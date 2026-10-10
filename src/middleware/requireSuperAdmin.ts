import type { NextFunction, Request, Response } from "express";
import {
  requirePageSuperAdmin as resolvePageSuperAdmin,
  requireSuperAdmin as resolveSuperAdmin,
} from "@/lib/auth/session";

/**
 * Réservé aux routes de la plateforme (`/api/admin/**`) : 401 sans session
 * valide, 403 pour tout compte qui n'est pas super administrateur. Le compte
 * est rangé dans `req.admin`.
 */
export async function requireSuperAdmin(req: Request, _res: Response, next: NextFunction) {
  req.admin = await resolveSuperAdmin();
  next();
}

/** Même règle pour les pages de l'administration : redirige au lieu de refuser. */
export async function requirePageSuperAdmin(req: Request, _res: Response, next: NextFunction) {
  req.admin = await resolvePageSuperAdmin();
  next();
}
