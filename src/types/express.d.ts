import type { AuthContext } from "@/lib/auth/session";

// Informations que les middlewares d'authentification ajoutent à la requête
// avant d'appeler le contrôleur.
declare module "express-serve-static-core" {
  interface Request {
    /** Posé par `verifyToken` / `verifyPageToken` : membre d'une organisation. */
    user: AuthContext;
    /** Posé par `requireSuperAdmin` / `requirePageSuperAdmin`. */
    admin: { userId: number };
    /** Posé par `verifyAccount` : compte connecté, organisation pas encore créée. */
    userId: number;
  }
}
