import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import { Errors } from "@/lib/api/errors";
import { recordSecurityEvent } from "@/lib/auth/security-log";

/**
 * Limitation de débit PARTAGÉE par toutes les instances de l'API (table
 * `CompteurLimite`), contrairement à un compteur en mémoire qui serait propre
 * à chaque processus. Chaque appel incrémente le compteur de façon atomique
 * (une seule instruction SQL). Au-delà de la limite, la clé est bloquée avec
 * un délai croissant : 1, 2, 4, 8 puis 15 minutes au plus.
 */
export type RateRule = { name: string; limit: number; windowMs: number };

const MAX_BLOCK_MS = 15 * 60 * 1000;

export function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/** Retourne null si l'appel est permis, sinon le délai d'attente en secondes. */
export async function consumeRate(rule: RateRule, subject: string): Promise<number | null> {
  const key = `${rule.name}:${hashKey(subject)}`;
  const now = new Date();
  const windowStart = new Date(now.getTime() - rule.windowMs);

  const rows = await prisma.$queryRaw<{ compteur: number; bloqueJusqua: Date | null; rejets: number }[]>`
    INSERT INTO "CompteurLimite" ("cle", "compteur", "fenetreDebut", "modifieLe")
    VALUES (${key}, 1, ${now}, ${now})
    ON CONFLICT ("cle") DO UPDATE SET
      "compteur" = CASE WHEN "CompteurLimite"."fenetreDebut" < ${windowStart} THEN 1 ELSE "CompteurLimite"."compteur" + 1 END,
      "fenetreDebut" = CASE WHEN "CompteurLimite"."fenetreDebut" < ${windowStart} THEN ${now} ELSE "CompteurLimite"."fenetreDebut" END,
      "modifieLe" = ${now}
    RETURNING "compteur", "bloqueJusqua", "rejets"`;
  const row = rows[0]!;

  if (row.bloqueJusqua && row.bloqueJusqua.getTime() > now.getTime()) {
    return Math.ceil((row.bloqueJusqua.getTime() - now.getTime()) / 1000);
  }
  if (row.compteur <= rule.limit) return null;

  const delay = Math.min(60_000 * 2 ** Math.min(row.rejets, 4), MAX_BLOCK_MS);
  await prisma.compteurLimite.update({
    where: { cle: key },
    data: { bloqueJusqua: new Date(now.getTime() + delay), rejets: { increment: 1 } },
  });
  // Nettoyage opportuniste des compteurs inactifs depuis plus d'un jour.
  if (Math.random() < 0.05) {
    void prisma.compteurLimite.deleteMany({ where: { modifieLe: { lt: new Date(now.getTime() - 86_400_000) } } }).catch(() => undefined);
  }
  return Math.ceil(delay / 1000);
}

/** Lève une erreur 429 si l'une des règles est dépassée pour son sujet. */
export async function enforceRates(checks: { rule: RateRule; subject: string }[]) {
  let retryAfter = 0;
  for (const check of checks) {
    const wait = await consumeRate(check.rule, check.subject);
    if (wait) retryAfter = Math.max(retryAfter, wait);
  }
  if (retryAfter > 0) {
    await recordSecurityEvent({ evenement: "rate_limit.blocked", metadonnees: { regles: checks.map((check) => check.rule.name), retryAfter } });
    throw Errors.tooManyRequests(retryAfter);
  }
}

export function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

/**
 * Middleware : limite par utilisateur connecté (à placer après verifyToken),
 * ou par adresse IP pour une route publique.
 */
export function rateLimit(rule: RateRule) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const subject = req.user ? `user:${req.user.userId}` : req.userId ? `user:${req.userId}` : `ip:${clientIp(req)}`;
    await enforceRates([{ rule, subject }]);
    next();
  };
}

/** Règles communes. */
export const RATE_RULES = {
  loginIp: { name: "login:ip", limit: 120, windowMs: 15 * 60_000 },
  loginIdentity: { name: "login:identity", limit: 10, windowMs: 15 * 60_000 },
  registerIp: { name: "register:ip", limit: 12, windowMs: 60 * 60_000 },
  registerIdentity: { name: "register:identity", limit: 5, windowMs: 60 * 60_000 },
  passwordChange: { name: "password:change", limit: 5, windowMs: 15 * 60_000 },
  passwordReset: { name: "password:reset", limit: 20, windowMs: 60 * 60_000 },
  saleCreate: { name: "sale:create", limit: 60, windowMs: 60_000 },
  sensitive: { name: "sensitive", limit: 60, windowMs: 60_000 },
} satisfies Record<string, RateRule>;
