import type { NextFunction, Request, Response } from "express";
import { parseIdentifier } from "@/lib/auth/identifier";
import { prisma } from "@/lib/prisma";
import { RATE_RULES, clientIp, enforceRates } from "@/lib/rate-limit";

/** Identifiant normalisé (email ou téléphone), pour compter les essais par compte visé. */
function normalizedIdentifier(req: Request): string {
  const raw = typeof req.body?.identifiant === "string" ? req.body.identifiant.trim() : "";
  const parsed = parseIdentifier(raw);
  if (!parsed) return raw.toLocaleLowerCase("fr").slice(0, 254) || "missing";
  return parsed.kind === "email" ? `email:${parsed.email}` : `phone:${parsed.telephone}`;
}

/**
 * Protection contre les essais répétés de connexion et d'inscription : par
 * adresse IP et par couple (IP, identifiant visé). Compteurs partagés en base
 * (voir lib/rate-limit), donc valables avec plusieurs instances de l'API.
 */
export function authRateLimit(kind: "login" | "register") {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const ip = clientIp(req);
    const identity = normalizedIdentifier(req);
    await enforceRates(
      kind === "login"
        ? [
            { rule: RATE_RULES.loginIp, subject: ip },
            { rule: RATE_RULES.loginIdentity, subject: `${ip}|${identity}` },
          ]
        : [
            { rule: RATE_RULES.registerIp, subject: ip },
            { rule: RATE_RULES.registerIdentity, subject: `${ip}|${identity}` },
          ],
    );
    next();
  };
}

export async function resetAuthRateLimitForTests() {
  await prisma.compteurLimite.deleteMany({});
}
