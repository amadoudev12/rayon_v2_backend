import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Request } from "express";
import { log } from "@/lib/logger";

const keySchema = z
  .string({ message: "En-tête Idempotency-Key obligatoire : mettez à jour l'application." })
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

/**
 * `IDEMPOTENCY_KEY_REQUIRED=true` : toute opération sensible doit fournir sa
 * clé. Sinon (défaut, période de transition), une requête SANS clé est
 * acceptée comme avant, sans protection contre les doublons : c'est le cas de
 * l'application mobile déjà installée chez les commerçants. Passer à `true`
 * une fois toutes les applications mises à jour (voir docs/EXPLOITATION.md).
 */
export function idempotencyKeyRequired(): boolean {
  return process.env.IDEMPOTENCY_KEY_REQUIRED === "true";
}

/**
 * Clé d'idempotence d'une opération sensible (en-tête `Idempotency-Key`).
 * Une clé fournie est toujours validée ; une clé absente n'est tolérée que
 * pendant la période de transition, et chaque cas est journalisé pour savoir
 * quand il est possible d'exiger la clé.
 */
export function requireIdempotencyKey(req: Request): string {
  const raw = req.get("idempotency-key");
  if (raw === undefined && !idempotencyKeyRequired()) {
    log("warn", "idempotency.key_missing", {
      method: req.method,
      route: req.baseUrl + (req.route?.path ?? ""),
      userId: req.user?.userId,
      organizationId: req.user?.organizationId,
      userAgent: req.get("user-agent")?.slice(0, 120),
    });
    return `legacy-${randomUUID()}`;
  }
  return keySchema.parse(raw);
}
