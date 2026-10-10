import type { NextFunction, Request, Response } from "express";
import { requirePermission as assertPermission } from "@/lib/auth/session";
import type { Permission } from "@/lib/auth/permissions";

/**
 * Réserve une route aux rôles qui détiennent la permission (voir la matrice
 * de `lib/auth/permissions`). À placer après `verifyToken`, qui fournit
 * `req.user` ; répond 403 sinon.
 */
export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction) => {
    assertPermission(req.user, permission);
    next();
  };
}
