import type { NextFunction, Request, Response } from "express";
import { allowedOrigins } from "@/env";
import { SESSION_COOKIE } from "@/lib/auth/token";

/** En-têtes de sécurité d'une API qui ne renvoie que du JSON. */
const SECURITY_HEADERS = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.set(SECURITY_HEADERS);
  // Les réponses dépendent du compte connecté : jamais mises en cache.
  res.set("Cache-Control", "no-store");
  next();
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Protection CSRF du cookie de session : une requête d'écriture qui porte le
 * cookie doit venir du site lui-même (en-tête `Origin` autorisé). Un autre
 * site ne peut donc pas faire agir le navigateur d'un utilisateur connecté.
 * L'application mobile (jeton Bearer, pas de cookie) n'est pas concernée.
 */
export function verifyOrigin(req: Request, res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();
  const cookies = req.cookies as Record<string, string> | undefined;
  if (!cookies?.[SESSION_COOKIE]) return next();

  const origin = req.get("origin");
  if (origin && allowedOrigins().includes(origin)) return next();

  res.status(403).json({ message: "Origine de la requête non autorisée." });
}
