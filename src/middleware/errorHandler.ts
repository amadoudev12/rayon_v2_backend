import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { ApiError, PageRedirect } from "@/lib/api/errors";

/**
 * Middleware d'erreur Express : dernière étape de toutes les routes.
 *
 * Les contrôleurs ne contiennent pas de `try/catch` : ils lèvent une erreur
 * (`throw Errors.notFound(...)`, échec de validation zod…) et Express 5 la
 * transmet ici, même depuis une fonction `async`. La traduction en réponse
 * HTTP est donc faite à un seul endroit : erreurs zod -> 400, `ApiError` ->
 * son statut, erreur inconnue -> 500 (journalisée, jamais envoyée au client).
 */
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
