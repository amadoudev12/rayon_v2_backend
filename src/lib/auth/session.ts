import { getRequestSession } from "@/lib/auth/token";
import { requestCache } from "@/lib/http/context";
import { prisma } from "@/lib/prisma";
import { Errors, PageRedirect } from "@/lib/api/errors";
import { can, type Permission } from "@/lib/auth/permissions";
import type { Role } from "@/generated/prisma/enums";

/** Tenant-scoped identity resolved from the current session. Every API
 * route and page loader must derive `organizationId` from here —
 * never from a client-supplied value — so data stays isolated per tenant. */
export type AuthContext = {
  userId: number;
  organizationId: number;
  role: Role;
  /** Non-null when this member is restricted to a single store. */
  membershipStoreId: number | null;
};

/**
 * Route qui ferme une session devenue invalide (membre retiré, compte
 * supprimé) : elle efface le cookie de session puis renvoie vers /login.
 */
export const SESSION_EXPIRED_PATH = "/api/session/expired";

/** Accueil de l'espace d'administration de la plateforme. */
export const SUPER_ADMIN_HOME = "/admin";

/** Page affichée aux membres d'une organisation suspendue. */
export const SUSPENDED_PATH = "/suspendu";

/**
 * Returns the raw session, or null when the request is unauthenticated.
 * The web sends it as an HttpOnly cookie, the mobile app as a Bearer token.
 */
export async function getSession() {
  return getRequestSession();
}

/** Équivalent du `redirect()` d'une page rendue côté serveur : le site suit `destination`. */
function redirect(destination: string): never {
  throw new PageRedirect(destination);
}

/**
 * Lit en base l'état réel du compte : le JWT n'est qu'une photo prise à la
 * connexion (valable 30 jours) et ne doit jamais servir à autoriser un accès.
 * Mis en cache pour la durée d'une requête (une seule lecture par requête).
 */
const loadAccount = requestCache(async (userId: number) => {
  const account = await prisma.utilisateur.findUnique({
    where: { id: userId },
    select: {
      superAdmin: true,
      actif: true,
      derniereActiviteLe: true,
      membre: {
        select: { role: true, organisationId: true, boutiqueId: true, organisation: { select: { actif: true } } },
      },
    },
  });

  if (account?.actif) await touchLastActivity(userId, account.derniereActiviteLe);
  return account;
});

/** Écart minimal entre deux mises à jour de `derniereActiviteLe`. */
const ACTIVITY_TOUCH_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Note la dernière activité du compte (statistiques de la plateforme), au
 * plus une écriture toutes les 15 minutes. Purement informatif : un échec
 * ne doit jamais faire échouer la requête en cours.
 */
async function touchLastActivity(userId: number, lastActivity: Date | null) {
  const now = Date.now();
  if (lastActivity && now - lastActivity.getTime() < ACTIVITY_TOUCH_INTERVAL_MS) return;
  try {
    await prisma.utilisateur.updateMany({ where: { id: userId }, data: { derniereActiviteLe: new Date(now) } });
  } catch (error) {
    console.error("Échec de la mise à jour de la dernière activité", error);
  }
}

type AccountState =
  | { status: "anonymous" }
  /** Session présente mais compte supprimé, ou accès à l'organisation retiré. */
  | { status: "revoked" }
  /** Compte valide qui n'a pas encore créé son organisation. */
  | { status: "onboarding"; userId: number }
  /** Gestionnaire de la plateforme : aucun espace boutique, uniquement /admin. */
  | { status: "superadmin"; userId: number }
  /** Membre d'une organisation suspendue par le super administrateur. */
  | { status: "suspended" }
  | { status: "member"; context: AuthContext };

async function resolveAccount(): Promise<AccountState> {
  const session = await getSession();
  const userId = session?.user?.id;
  if (!userId) return { status: "anonymous" };

  const account = await loadAccount(userId);
  // Compte supprimé, ou désactivé par le super administrateur.
  if (!account || !account.actif) return { status: "revoked" };

  // Vérifié avant l'adhésion : un super administrateur n'obtient jamais de
  // contexte d'organisation, même si une adhésion existait par erreur.
  if (account.superAdmin) return { status: "superadmin", userId };

  if (!account.membre) {
    // Le jeton indique une organisation que la base ne connaît plus : le
    // membre a été retiré. Sinon, l'inscription n'est simplement pas terminée.
    return session.user.tenant ? { status: "revoked" } : { status: "onboarding", userId };
  }

  if (!account.membre.organisation.actif) return { status: "suspended" };

  return {
    status: "member",
    context: {
      userId,
      organizationId: account.membre.organisationId,
      role: account.membre.role,
      membershipStoreId: account.membre.boutiqueId,
    },
  };
}

/** Returns the authenticated user id even if onboarding isn't finished yet. */
export async function getAuthenticatedUserId(): Promise<number | null> {
  const state = await resolveAccount();
  if (state.status === "member") return state.context.userId;
  if (state.status === "onboarding") return state.userId;
  return null;
}

/** Throws 401 if the request has no valid session (or the account no longer exists). */
export async function requireUserId(): Promise<number> {
  const state = await resolveAccount();
  if (state.status === "member") return state.context.userId;
  if (state.status === "onboarding") return state.userId;
  if (state.status === "superadmin") throw Errors.platformAccountOnly();
  if (state.status === "suspended") throw Errors.organizationSuspended();
  throw Errors.unauthenticated();
}

/**
 * Full tenant context: authenticated AND onboarded (has an organization).
 * Throws 401 when not authenticated or when access was revoked, 409 when
 * onboarding is incomplete.
 */
export async function requireAuthContext(): Promise<AuthContext> {
  const state = await resolveAccount();
  if (state.status === "anonymous") throw Errors.unauthenticated();
  if (state.status === "revoked") throw Errors.accessRevoked();
  if (state.status === "onboarding") throw Errors.onboardingRequired();
  if (state.status === "superadmin") throw Errors.platformAccountOnly();
  if (state.status === "suspended") throw Errors.organizationSuspended();
  return state.context;
}

/**
 * Same contract as `requireAuthContext`, for page loaders (`/api/pages/**`):
 * answers with a redirection instead of an error, so the site sends the
 * visitor to the right place (login, onboarding, admin…).
 */
export async function requirePageAuthContext(): Promise<AuthContext> {
  const state = await resolveAccount();
  if (state.status === "anonymous") redirect("/login");
  // Le cookie de session doit être effacé : la route dédiée s'en charge
  // puis renvoie vers la page de connexion.
  if (state.status === "revoked") redirect(SESSION_EXPIRED_PATH);
  if (state.status === "onboarding") redirect("/onboarding");
  if (state.status === "superadmin") redirect(SUPER_ADMIN_HOME);
  if (state.status === "suspended") redirect(SUSPENDED_PATH);
  return state.context;
}

/** Destination naturelle d'un compte selon son état réel (jamais selon le jeton). */
function homeFor(state: AccountState): string {
  switch (state.status) {
    case "anonymous":
      return "/login";
    case "revoked":
      return SESSION_EXPIRED_PATH;
    case "onboarding":
      return "/onboarding";
    case "superadmin":
      return SUPER_ADMIN_HOME;
    case "suspended":
      return SUSPENDED_PATH;
    case "member":
      return "/dashboard";
  }
}

/**
 * Réservé aux routes API de la plateforme (/api/admin/**) : 401 sans session
 * valide, 403 pour tout compte qui n'est pas super administrateur — y compris
 * le propriétaire d'une boutique. Le statut est relu en base à chaque requête.
 */
export async function requireSuperAdmin(): Promise<{ userId: number }> {
  const state = await resolveAccount();
  if (state.status === "anonymous" || state.status === "revoked") throw Errors.unauthenticated();
  if (state.status !== "superadmin") throw Errors.forbidden("Accès réservé à l'administration de la plateforme");
  return { userId: state.userId };
}

/** Même règle que `requireSuperAdmin`, pour les pages : redirige au lieu de lever. */
export async function requirePageSuperAdmin(): Promise<{ userId: number }> {
  const state = await resolveAccount();
  if (state.status !== "superadmin") redirect(homeFor(state));
  return { userId: state.userId };
}

/**
 * Pour la page « organisation suspendue » : null si l'utilisateur doit bien
 * la voir, sinon la destination vers laquelle le rediriger.
 */
export async function getSuspendedRedirect(): Promise<string | null> {
  const state = await resolveAccount();
  return state.status === "suspended" ? null : homeFor(state);
}

/**
 * Pour la page d'onboarding : null si l'utilisateur doit bien la voir,
 * sinon la destination vers laquelle le rediriger.
 */
export async function getOnboardingRedirect(): Promise<string | null> {
  const state = await resolveAccount();
  return state.status === "onboarding" ? null : homeFor(state);
}

/**
 * État réel du compte de la requête et page où il a sa place : sert au site
 * pour orienter un visiteur déjà connecté (page d'accueil, connexion,
 * inscription), comme le faisait le proxy de l'ancienne application.
 */
export async function getAccountHome(): Promise<{ status: AccountState["status"]; home: string }> {
  const state = await resolveAccount();
  return { status: state.status, home: homeFor(state) };
}

/** Throws 403 unless the context's role holds the given permission. */
export function requirePermission(context: AuthContext, permission: Permission): void {
  if (!can(context.role, permission)) throw Errors.forbidden();
}

/**
 * Resolves which store a request should act on. A member restricted to one
 * store can never act on another one, even if they pass a different id;
 * an unrestricted member may target any store that belongs to their own
 * organization, and otherwise falls back to the organization's default
 * (or first) store.
 */
export async function resolveActiveStoreId(
  context: AuthContext,
  requestedStoreId?: number | null,
): Promise<number> {
  if (context.membershipStoreId) {
    if (requestedStoreId && requestedStoreId !== context.membershipStoreId) {
      throw Errors.forbidden("Vous n'avez pas accès à cette boutique");
    }
    return context.membershipStoreId;
  }

  if (requestedStoreId) {
    const store = await prisma.boutique.findFirst({
      where: { id: requestedStoreId, organisationId: context.organizationId },
      select: { id: true },
    });
    if (!store) throw Errors.forbidden("Boutique invalide");
    return store.id;
  }

  const defaultStore = await prisma.boutique.findFirst({
    where: { organisationId: context.organizationId },
    orderBy: [{ parDefaut: "desc" }, { id: "asc" }],
    select: { id: true },
  });
  if (!defaultStore) throw Errors.conflict("Aucune boutique n'est configurée pour cette organisation.");
  return defaultStore.id;
}
