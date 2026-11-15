import type { Request, Response } from "express";
import * as accountService from "@/services/account";
import * as onboardingService from "@/services/onboarding";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyCredentials } from "@/lib/auth/credentials";
import { hashPassword } from "@/lib/auth/password";
import { identifierTakenMessage, identifierWhere, parseIdentifier } from "@/lib/auth/identifier";
import { getAccountHome, getSession, resolveActiveStoreId } from "@/lib/auth/session";
import { ACTIVE_STORE_COOKIE } from "@/lib/auth/store";
import { clearSessionCookie, cookieBaseOptions, issueSessionToken, revokeSession, revokeUserSessions, setSessionCookie } from "@/lib/auth/token";
import { recordSecurityEvent } from "@/lib/auth/security-log";
import { changeOwnPassword, listActiveSessions } from "@/services/security";
import { SESSION_RENEW_AFTER_MS, renewSessionCookie } from "@/lib/auth/web-session";
import { loginSchema, passwordSchema, registerSchema } from "@/lib/validations/auth";
import { onboardingSchema } from "@/lib/validations/onboarding";
import { recordAuditLog } from "@/lib/api/audit";
import { jsonData, jsonMessage } from "@/lib/api/response";
import { ApiError, Errors } from "@/lib/api/errors";
import { frontendUrl } from "@/env";

const activeStoreSchema = z.object({ storeId: z.coerce.number().int().positive() });

/**
 * Connexion du site web : mêmes identifiants et mêmes règles que le mobile,
 * mais le jeton de session est posé dans un cookie `HttpOnly` au lieu d'être
 * renvoyé dans la réponse.
 */
export async function login(req: Request, res: Response) {
  const parsed = loginSchema.parse(req.body);

  const user = await verifyCredentials(parsed.identifiant, parsed.motDePasse);
  if (!user) {
    await recordSecurityEvent({ evenement: "login.failure", identifiant: parsed.identifiant, metadonnees: { client: "web" } });
    throw new ApiError(401, "Identifiant ou mot de passe incorrect.");
  }

  const { token, expiresAt } = await issueSessionToken(user, "web");
  setSessionCookie(res, token);
  await recordSecurityEvent({ evenement: "login.success", utilisateurId: user.id, metadonnees: { client: "web" } });
  return jsonData(res, { expiresAt, doitChangerMotDePasse: user.doitChangerMotDePasse });
}

/**
 * Déconnexion RÉELLE : la session du jeton présenté (cookie du site ou jeton
 * Bearer du mobile) est révoquée en base ; le jeton devient inutilisable même
 * s'il avait été copié.
 */
export async function logout(req: Request, res: Response) {
  const session = await getSession();
  if (session?.sessionId) {
    await revokeSession(session.sessionId, "Déconnexion");
    await recordSecurityEvent({ evenement: "logout", utilisateurId: session.user.id, metadonnees: { client: session.audience ?? null } });
  }
  clearSessionCookie(res);
  return jsonMessage(res, "Déconnecté");
}

const passwordChangeSchema = z.object({
  motDePasseActuel: z.string().min(1, "Le mot de passe actuel est requis."),
  nouveauMotDePasse: passwordSchema,
});

/** Changement de mot de passe : ferme toutes les autres sessions du compte. */
export async function changePassword(req: Request, res: Response) {
  const parsed = passwordChangeSchema.parse(req.body);
  const session = await getSession();
  await changeOwnPassword(req.user.userId, session?.sessionId, parsed.motDePasseActuel, parsed.nouveauMotDePasse);
  return jsonMessage(res, "Mot de passe modifié. Vos autres appareils ont été déconnectés.");
}

export async function getSessions(req: Request, res: Response) {
  const session = await getSession();
  const sessions = await listActiveSessions(req.user.userId);
  return jsonData(res, sessions.map((item) => ({ ...item, courante: item.id === session?.sessionId })));
}

/** « Déconnecter mes autres appareils ». */
export async function revokeOtherSessions(req: Request, res: Response) {
  const session = await getSession();
  const count = await revokeUserSessions(req.user.userId, "Déconnexion des autres appareils", session?.sessionId);
  await recordSecurityEvent({ evenement: "sessions.revoked", utilisateurId: req.user.userId, metadonnees: { nombre: count } });
  return jsonData(res, { sessionsFermees: count });
}

/**
 * État réel du compte connecté et page où il a sa place. Le site s'en sert
 * pour rediriger un visiteur déjà connecté depuis l'accueil, la connexion et
 * l'inscription.
 */
export async function getSessionState(req: Request, res: Response) {
  const account = await getAccountHome();

  // Session devenue invalide (compte supprimé ou désactivé, accès retiré) :
  // le cookie est effacé, le visiteur redevient anonyme.
  if (account.status === "revoked") {
    clearSessionCookie(res);
    res.clearCookie(ACTIVE_STORE_COOKIE, cookieBaseOptions());
    return jsonData(res, { status: "anonymous", home: "/login" });
  }

  if (account.status !== "anonymous") await renewSessionCookie(res, { olderThanMs: SESSION_RENEW_AFTER_MS });
  return jsonData(res, account);
}

/**
 * Réémet le cookie de session avec l'organisation à jour : appelé par le site
 * juste après l'onboarding (le jeton émis à la connexion ne connaissait pas
 * encore l'organisation).
 */
export async function refreshSession(req: Request, res: Response) {
  const renewed = await renewSessionCookie(res);
  if (!renewed) throw Errors.unauthenticated();
  return jsonMessage(res, "Session mise à jour");
}

/**
 * Ferme une session devenue invalide (membre retiré de l'organisation,
 * compte supprimé) : efface les cookies puis renvoie vers la page de
 * connexion du site.
 */
export function closeExpiredSession(req: Request, res: Response) {
  clearSessionCookie(res);
  res.clearCookie(ACTIVE_STORE_COOKIE, cookieBaseOptions());
  res.redirect(`${frontendUrl()}/login`);
}

export async function setActiveStore(req: Request, res: Response) {
  const context = req.user;
  const { storeId } = activeStoreSchema.parse(req.body);

  // Validates the store belongs to the caller's organization before trusting it.
  const validStoreId = await resolveActiveStoreId(context, storeId);

  res.cookie(ACTIVE_STORE_COOKIE, String(validStoreId), {
    ...cookieBaseOptions(),
    maxAge: 60 * 60 * 24 * 365 * 1000,
  });

  return jsonMessage(res, "Boutique active mise à jour");
}

/**
 * Connexion de l'application mobile : mêmes identifiants et mêmes règles que
 * la connexion web, mais le jeton de session est renvoyé dans la réponse (à
 * conserver dans le stockage sécurisé du téléphone) au lieu d'un cookie.
 */
export async function mobileLogin(req: Request, res: Response) {
  const parsed = loginSchema.parse(req.body);

  const user = await verifyCredentials(parsed.identifiant, parsed.motDePasse);
  if (!user) {
    await recordSecurityEvent({ evenement: "login.failure", identifiant: parsed.identifiant, metadonnees: { client: "mobile" } });
    throw new ApiError(401, "Identifiant ou mot de passe incorrect.");
  }

  // L'administration de la plateforme n'existe que sur le web.
  if (user.superAdmin) throw Errors.platformAccountOnly();

  const { token, expiresAt } = await issueSessionToken(user, "mobile");
  await recordSecurityEvent({ evenement: "login.success", utilisateurId: user.id, metadonnees: { client: "mobile" } });
  return jsonData(res, { token, expiresAt, doitChangerMotDePasse: user.doitChangerMotDePasse });
}

export async function register(req: Request, res: Response) {
  const parsed = registerSchema.parse(req.body);
  // Le schéma a déjà validé le format : l'identifiant est forcément reconnu.
  const identifier = parseIdentifier(parsed.identifiant)!;

  const existing = await prisma.utilisateur.findUnique({ where: identifierWhere(identifier) });
  if (existing) {
    throw Errors.conflict(identifierTakenMessage(identifier));
  }

  const motDePasseHash = await hashPassword(parsed.motDePasse);
  const user = await prisma.utilisateur.create({
    data: {
      prenom: parsed.prenom,
      nom: parsed.nom,
      ...identifierWhere(identifier),
      motDePasseHash,
    },
    select: { id: true, prenom: true, nom: true, email: true, telephone: true },
  });

  return jsonData(res, user, { status: 201 });
}

export async function getMe(req: Request, res: Response) {
  const context = req.user;
  return jsonData(res, await accountService.getAccountProfile(context));
}

export async function completeOnboarding(req: Request, res: Response) {
  const userId = req.userId;
  const parsed = onboardingSchema.parse(req.body);

  const { organization, store } = await onboardingService.createOrganizationForUser(userId, parsed);

  await recordAuditLog({
    organisationId: organization.id,
    utilisateurId: userId,
    action: "organization.created",
    entite: "Organization",
    entiteId: organization.id,
  });

  return jsonData(res, { organization, store }, { status: 201 });
}
