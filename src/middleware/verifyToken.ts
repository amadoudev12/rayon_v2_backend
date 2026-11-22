import type { NextFunction, Request, Response } from "express";
import { requireAuthContext, requirePageAuthContext, requireUserId } from "@/lib/auth/session";
import { assertCanWrite } from "@/services/subscription";

/**
 * Authentification des routes de l'API : vérifie la session (cookie du site
 * ou jeton Bearer du mobile), relit le compte en base, puis range son contexte
 * dans `req.user` (utilisateur, organisation, rôle, boutique imposée).
 *
 * Sans session valide la requête s'arrête ici : 401, 403 ou 409 selon l'état
 * du compte (voir `requireAuthContext`).
 */
export async function verifyToken(req: Request, _res: Response, next: NextFunction) {
  req.user = await requireAuthContext();
  // Abonnement inactif (si le contrôle est activé) : lecture seule.
  if (!READ_METHODS.has(req.method)) await assertCanWrite(req.user.organizationId);
  next();
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Variante qui reste ouverte en LECTURE SEULE : page et actions
 * d'abonnement (consultation, devis, renouvellement), choix de la boutique
 * affichée et déconnexion des autres appareils (sécurité). Aucune donnée
 * commerciale n'est modifiable par ces routes.
 */
export async function verifyTokenAllowingReadOnly(req: Request, _res: Response, next: NextFunction) {
  req.user = await requireAuthContext();
  next();
}

/**
 * Même contrôle pour les lectures de page (`/api/pages/**`) : au lieu d'une
 * erreur, le site reçoit la page vers laquelle rediriger le visiteur
 * (connexion, onboarding, administration…).
 */
/**
 * Variante qui laisse passer un membre au mot de passe temporaire : réservée
 * au changement de mot de passe, au profil et à la déconnexion.
 */
export async function verifyTokenAllowingPasswordChange(req: Request, _res: Response, next: NextFunction) {
  req.user = await requireAuthContext({ allowPendingPasswordChange: true });
  next();
}

export async function verifyPageToken(req: Request, _res: Response, next: NextFunction) {
  req.user = await requirePageAuthContext();
  next();
}

/**
 * Compte connecté, même s'il n'a pas encore créé son organisation (étape
 * d'onboarding) : seul son identifiant est connu, rangé dans `req.userId`.
 */
export async function verifyAccount(req: Request, _res: Response, next: NextFunction) {
  req.userId = await requireUserId();
  next();
}
