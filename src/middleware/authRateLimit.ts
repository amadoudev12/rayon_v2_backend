import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { parseIdentifier } from "@/lib/auth/identifier";

type Bucket = { count: number; windowStartedAt: number; blockedUntil: number; strikes: number; touchedAt: number };
const buckets = new Map<string, Bucket>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_BUCKETS = 20_000;

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function take(key: string, limit: number, now: number, windowMs = WINDOW_MS): number | null {
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStartedAt >= windowMs) {
    bucket = { count: 0, windowStartedAt: now, blockedUntil: 0, strikes: bucket?.strikes ?? 0, touchedAt: now };
    buckets.set(key, bucket);
  }
  bucket.touchedAt = now;
  if (bucket.blockedUntil > now) return Math.ceil((bucket.blockedUntil - now) / 1000);

  bucket.count += 1;
  if (bucket.count <= limit) return null;

  bucket.strikes += 1;
  const delay = Math.min(60_000 * 2 ** Math.min(bucket.strikes - 1, 4), 15 * 60_000);
  bucket.blockedUntil = now + delay;
  return Math.ceil(delay / 1000);
}

function trim(now: number) {
  if (buckets.size < MAX_BUCKETS) return;
  for (const [key, bucket] of buckets) {
    if (now - bucket.touchedAt > 60 * 60_000 || buckets.size >= MAX_BUCKETS) buckets.delete(key);
    if (buckets.size < MAX_BUCKETS * 0.9) break;
  }
}

function normalizedIdentifier(req: Request): string {
  const raw = typeof req.body?.identifiant === "string" ? req.body.identifiant.trim() : "";
  const parsed = parseIdentifier(raw);
  if (!parsed) return raw.toLocaleLowerCase("fr").slice(0, 254) || "missing";
  return parsed.kind === "email" ? `email:${parsed.email}` : `phone:${parsed.telephone}`;
}

export function authRateLimit(kind: "login" | "register") {
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    trim(now);
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const identityHash = digest(normalizedIdentifier(req));
    const ipHash = digest(ip);

    const ipLimit = kind === "login" ? 120 : 12;
    const identityLimit = kind === "login" ? 10 : 5;
    const windowMs = kind === "login" ? WINDOW_MS : 60 * 60_000;
    const ipRetry = take(`${kind}:ip:${ipHash}`, ipLimit, now, windowMs);
    const identityRetry = take(`${kind}:identity:${ipHash}:${identityHash}`, identityLimit, now, windowMs);
    const retryAfter = Math.max(ipRetry ?? 0, identityRetry ?? 0);

    if (retryAfter > 0) {
      res.setHeader("Retry-After", String(retryAfter));
      console.warn("[security] auth_rate_limited", { kind, ipHash, identityHash, retryAfter });
      return res.status(429).json({ message: "Trop de tentatives. Réessayez dans quelques instants." });
    }
    next();
  };
}

export function resetAuthRateLimitForTests() {
  buckets.clear();
}
