import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Journaux structurés : une ligne JSON par événement, lisible par n'importe
 * quel agrégateur (Better Stack, Grafana Loki, Datadog, journald…). Jamais de
 * corps de requête, de mot de passe, de jeton ni de cookie.
 */
type Level = "info" | "warn" | "error";

export function log(level: Level, event: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Identifiant de requête accepté du proxy (s'il est sûr) ou généré. */
function requestIdOf(req: Request): string {
  const incoming = req.get("x-request-id");
  return incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomUUID();
}

declare module "express-serve-static-core" {
  interface Request {
    requestId: string;
  }
}

/**
 * Journal d'accès : méthode, route, statut, durée, utilisateur et
 * organisation (identifiants seulement). L'identifiant de requête est renvoyé
 * au client (`X-Request-Id`) pour retrouver une erreur signalée par un commerçant.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const started = process.hrtime.bigint();
  req.requestId = requestIdOf(req);
  res.setHeader("X-Request-Id", req.requestId);
  res.on("finish", () => {
    if (process.env.NODE_ENV === "test" || process.env.VITEST || process.env.LOG_HTTP === "false") return;
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    log(res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info", "http.request", {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl.split("?")[0],
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      userId: req.user?.userId ?? req.userId ?? null,
      organizationId: req.user?.organizationId ?? null,
    });
  });
  next();
}
