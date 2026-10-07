import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { ApiError, Errors, PageRedirect } from "./errors";
import { parseIntId } from "./pagination";

/**
 * Every route handler should be wrapped with this so error handling stays
 * consistent: Zod issues -> 400, ApiError -> its status, unknown -> 500
 * (logged, never leaked to the client).
 */
export function apiRoute(handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

/** Middleware d'erreur Express : dernière étape de toutes les routes. */
export function errorHandler(error: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(error);
  handleApiError(error, res);
}

export function handleApiError(error: unknown, res: Response) {
  if (error instanceof ApiError) {
    return res.status(error.status).json({ message: error.message, ...(error.details ? { errors: error.details } : {}) });
  }

  if (error instanceof PageRedirect) {
    return res.status(error.redirect === "/login" ? 401 : 403).json({ message: error.message, redirect: error.redirect });
  }

  if (error instanceof ZodError) {
    return res.status(400).json({ message: "Données invalides", errors: error.flatten() });
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      return res.status(409).json({ message: "Cette valeur existe déjà (contrainte d'unicité)." });
    }
    if (error.code === "P2003") {
      return res.status(409).json({ message: "Cette ressource est référencée ailleurs et ne peut pas être modifiée." });
    }
    if (error.code === "P2025") {
      return res.status(404).json({ message: "Ressource introuvable." });
    }
  }

  // Corps de requête illisible (JSON mal formé) ou trop volumineux.
  const bodyError = error as { type?: string } | null;
  if (bodyError?.type === "entity.parse.failed" || bodyError?.type === "entity.too.large") {
    return res.status(400).json({ message: "Données invalides" });
  }

  console.error(error);
  return res.status(500).json({ message: "Une erreur interne est survenue." });
}

export function jsonData<T>(res: Response, data: T, init?: { status?: number }) {
  return res.status(init?.status ?? 200).json({ data });
}

export function jsonPage<T>(
  res: Response,
  data: T[],
  pagination: { page: number; limit: number; total: number; totalPages: number },
) {
  return res.json({ data, pagination });
}

export function jsonMessage(res: Response, message: string, init?: { status?: number }) {
  return res.status(init?.status ?? 200).json({ message });
}

/** Paramètres de l'URL (`?page=2&search=riz`), lus de la même façon par toutes les routes. */
export function searchParams(req: Request): URLSearchParams {
  const queryIndex = req.originalUrl.indexOf("?");
  return new URLSearchParams(queryIndex === -1 ? "" : req.originalUrl.slice(queryIndex + 1));
}

/** Identifiant numérique de la route (`/:id`) ; lève une erreur 400 s'il est invalide. */
export function routeId(req: Request): number {
  const id = parseIntId(String(req.params.id));
  if (!id) throw Errors.invalidId();
  return id;
}
