import type { Response } from "express";
import { prisma } from "@/lib/prisma";
import { getSessionCookie, issueSessionToken, readSessionToken, setSessionCookie } from "@/lib/auth/token";

/** Âge à partir duquel le cookie d'un compte actif est renouvelé (session glissante). */
export const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Réémet le cookie de session du site web avec les informations à jour du
 * compte (organisation, rôle) et une nouvelle durée de 30 jours.
 *
 * - sans option : immédiatement (juste après l'onboarding, par exemple) ;
 * - avec `olderThanMs` : seulement si le jeton a dépassé cet âge, pour qu'une
 *   personne qui utilise le site régulièrement ne soit pas déconnectée au
 *   bout de 30 jours.
 *
 * Retourne faux si la requête ne porte pas de cookie de session valide.
 */
export async function renewSessionCookie(res: Response, options: { olderThanMs?: number } = {}): Promise<boolean> {
  const cookie = getSessionCookie();
  if (!cookie) return false;

  const session = await readSessionToken(cookie, "web");
  if (!session) return false;

  const age = session.issuedAt ? Date.now() - session.issuedAt.getTime() : Infinity;
  if (options.olderThanMs !== undefined && age < options.olderThanMs) return false;

  const user = await prisma.utilisateur.findUnique({
    where: { id: session.user.id },
    select: { id: true, prenom: true, nom: true, actif: true },
  });
  if (!user || !user.actif) return false;

  const { token } = await issueSessionToken(user, "web");
  setSessionCookie(res, token);
  return true;
}
