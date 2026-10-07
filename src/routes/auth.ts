import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyCredentials } from "@/lib/auth/credentials";
import { hashPassword } from "@/lib/auth/password";
import { identifierTakenMessage, identifierWhere, parseIdentifier } from "@/lib/auth/identifier";
import { getAccountHome, requireAuthContext, requireUserId, resolveActiveStoreId } from "@/lib/auth/session";
import { ACTIVE_STORE_COOKIE } from "@/lib/auth/store";
import { clearSessionCookie, cookieBaseOptions, issueSessionToken, setSessionCookie } from "@/lib/auth/token";
import { SESSION_RENEW_AFTER_MS, renewSessionCookie } from "@/lib/auth/web-session";
import { loginSchema, registerSchema } from "@/lib/validations/auth";
import { onboardingSchema } from "@/lib/validations/onboarding";
import { getAccountProfile } from "@/lib/services/account";
import { createOrganizationForUser } from "@/lib/services/onboarding";
import { recordAuditLog } from "@/lib/api/audit";
import { apiRoute, jsonData, jsonMessage } from "@/lib/api/response";
import { ApiError, Errors } from "@/lib/api/errors";
import { frontendUrl } from "@/env";

export const authRouter = Router();

// ---------------------------------------------------------------------------
// Session du site web (cookie HttpOnly)
// ---------------------------------------------------------------------------

/**
 * Connexion du site web : mêmes identifiants et mêmes règles que le mobile,
 * mais le jeton de session est posé dans un cookie `HttpOnly` au lieu d'être
 * renvoyé dans la réponse.
 */
authRouter.post(
  "/auth/login",
  apiRoute(async (req, res) => {
    const parsed = loginSchema.parse(req.body);

    const user = await verifyCredentials(parsed.identifiant, parsed.motDePasse);
    if (!user) throw new ApiError(401, "Identifiant ou mot de passe incorrect.");

    const { token, expiresAt } = await issueSessionToken(user, "web");
    setSessionCookie(res, token);
    return jsonData(res, { expiresAt });
  }),
);

authRouter.post(
  "/auth/logout",
  apiRoute(async (_req, res) => {
    clearSessionCookie(res);
    return jsonMessage(res, "Déconnecté");
  }),
);

/**
 * État réel du compte connecté et page où il a sa place. Le site s'en sert
 * pour rediriger un visiteur déjà connecté depuis l'accueil, la connexion et
 * l'inscription.
 */
authRouter.get(
  "/auth/session",
  apiRoute(async (_req, res) => {
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
  }),
);

/**
 * Réémet le cookie de session avec l'organisation à jour : appelé par le site
 * juste après l'onboarding (le jeton émis à la connexion ne connaissait pas
 * encore l'organisation).
 */
authRouter.post(
  "/auth/session/refresh",
  apiRoute(async (_req, res) => {
    const renewed = await renewSessionCookie(res);
    if (!renewed) throw Errors.unauthenticated();
    return jsonMessage(res, "Session mise à jour");
  }),
);

/**
 * Ferme une session devenue invalide (membre retiré de l'organisation,
 * compte supprimé) : efface les cookies puis renvoie vers la page de
 * connexion du site.
 */
authRouter.get("/session/expired", (_req, res) => {
  clearSessionCookie(res);
  res.clearCookie(ACTIVE_STORE_COOKIE, cookieBaseOptions());
  res.redirect(`${frontendUrl()}/login`);
});

const activeStoreSchema = z.object({ storeId: z.coerce.number().int().positive() });

authRouter.post(
  "/session/active-store",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    const { storeId } = activeStoreSchema.parse(req.body);

    // Validates the store belongs to the caller's organization before trusting it.
    const validStoreId = await resolveActiveStoreId(context, storeId);

    res.cookie(ACTIVE_STORE_COOKIE, String(validStoreId), {
      ...cookieBaseOptions(),
      maxAge: 60 * 60 * 24 * 365 * 1000,
    });

    return jsonMessage(res, "Boutique active mise à jour");
  }),
);

// ---------------------------------------------------------------------------
// Session de l'application mobile (jeton Bearer)
// ---------------------------------------------------------------------------

/**
 * Connexion de l'application mobile : mêmes identifiants et mêmes règles que
 * la connexion web, mais le jeton de session est renvoyé dans la réponse (à
 * conserver dans le stockage sécurisé du téléphone) au lieu d'un cookie.
 */
authRouter.post(
  "/mobile/auth/login",
  apiRoute(async (req, res) => {
    const parsed = loginSchema.parse(req.body);

    const user = await verifyCredentials(parsed.identifiant, parsed.motDePasse);
    if (!user) throw new ApiError(401, "Identifiant ou mot de passe incorrect.");

    // L'administration de la plateforme n'existe que sur le web.
    if (user.superAdmin) throw Errors.platformAccountOnly();

    const { token, expiresAt } = await issueSessionToken(user, "mobile");
    return jsonData(res, { token, expiresAt });
  }),
);

// ---------------------------------------------------------------------------
// Inscription, profil, onboarding
// ---------------------------------------------------------------------------

authRouter.post(
  "/register",
  apiRoute(async (req, res) => {
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
  }),
);

authRouter.get(
  "/me",
  apiRoute(async (_req, res) => {
    const context = await requireAuthContext();
    return jsonData(res, await getAccountProfile(context));
  }),
);

authRouter.post(
  "/onboarding",
  apiRoute(async (req, res) => {
    const userId = await requireUserId();
    const parsed = onboardingSchema.parse(req.body);

    const { organization, store } = await createOrganizationForUser(userId, parsed);

    await recordAuditLog({
      organisationId: organization.id,
      utilisateurId: userId,
      action: "organization.created",
      entite: "Organization",
      entiteId: organization.id,
    });

    return jsonData(res, { organization, store }, { status: 201 });
  }),
);
