import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { allowedOrigins } from "@/env";
import { errorHandler } from "@/lib/api/response";
import { SESSION_COOKIE } from "@/lib/auth/token";
import { requestContext } from "@/lib/http/context";
import { adminRouter } from "@/routes/admin";
import { authRouter } from "@/routes/auth";
import { catalogRouter } from "@/routes/catalog";
import { commerceRouter } from "@/routes/commerce";
import { organizationRouter } from "@/routes/organization";
import { pagesRouter } from "@/routes/pages";

/** En-têtes de sécurité d'une API qui ne renvoie que du JSON. */
const SECURITY_HEADERS = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

function securityHeaders(_req: Request, res: Response, next: NextFunction) {
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
function verifyOrigin(req: Request, res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();
  const cookies = req.cookies as Record<string, string> | undefined;
  if (!cookies?.[SESSION_COOKIE]) return next();

  const origin = req.get("origin");
  if (origin && allowedOrigins().includes(origin)) return next();

  res.status(403).json({ message: "Origine de la requête non autorisée." });
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);

  app.use(securityHeaders);
  app.use(cors({ origin: allowedOrigins(), credentials: true }));
  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));
  app.use(requestContext);
  app.use(verifyOrigin);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api/admin", adminRouter);
  app.use("/api/pages", pagesRouter);
  app.use("/api", authRouter, organizationRouter, catalogRouter, commerceRouter);

  app.use((_req, res) => {
    res.status(404).json({ message: "Ressource introuvable" });
  });
  app.use(errorHandler);

  return app;
}
