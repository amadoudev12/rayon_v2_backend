import type { CookieOptions, Response } from "express";
import { SignJWT, jwtVerify } from "jose";
import { prisma } from "@/lib/prisma";
import { currentRequest } from "@/lib/http/context";
import type { Role } from "@/generated/prisma/enums";

/**
 * Session gérée par le backend (remplace NextAuth).
 *
 * Un jeton signé (JWT HS256) valable 30 jours identifie le compte :
 * - le site web le reçoit dans un cookie `HttpOnly`, jamais lisible par le
 *   JavaScript de la page ;
 * - l'application mobile le reçoit dans la réponse de connexion et le renvoie
 *   dans l'en-tête `Authorization: Bearer …`.
 *
 * Dans les deux cas le jeton ne sert qu'à identifier le compte : rôle,
 * organisation et état du compte sont relus en base à chaque requête
 * (voir lib/auth/session).
 */

export function getAuthSecret(): string | undefined {
  return process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
}

function requireSecret(): Uint8Array {
  const secret = getAuthSecret();
  if (!secret) {
    throw new Error("AUTH_SECRET est requis pour émettre ou lire un jeton de session.");
  }
  return new TextEncoder().encode(secret);
}

/** Contexte d'organisation porté par le jeton et exposé dans la session. */
export type SessionTenant = {
  organizationId: number;
  organizationName: string;
  role: Role;
  storeId: number | null;
} | null;

/** Session portée par la requête, telle que le jeton la décrit (photo prise à la connexion). */
export type Session = {
  expires: string;
  user: { id: number; name?: string | null; tenant: SessionTenant };
  /** Date d'émission du jeton, pour prolonger la session web d'un compte actif. */
  issuedAt?: Date;
};

export async function loadMembership(userId: number) {
  const membership = await prisma.membre.findUnique({
    where: { utilisateurId: userId },
    select: {
      role: true,
      boutiqueId: true,
      organisation: { select: { id: true, nom: true } },
    },
  });

  if (!membership) return null;

  return {
    organizationId: membership.organisation.id,
    organizationName: membership.organisation.nom,
    role: membership.role,
    storeId: membership.boutiqueId,
  } satisfies NonNullable<SessionTenant>;
}

export async function loadIsSuperAdmin(userId: number) {
  const user = await prisma.utilisateur.findUnique({ where: { id: userId }, select: { superAdmin: true } });
  return user?.superAdmin ?? false;
}

/** 30 jours, pour le web comme pour le mobile. */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Destinataire du jeton : un jeton mobile n'est pas un cookie de session
 * valide, et inversement.
 */
type Audience = "web" | "mobile";

/** Émet le jeton de session d'un compte dont les identifiants viennent d'être vérifiés. */
export async function issueSessionToken(user: { id: number; prenom: string; nom: string }, audience: Audience) {
  const token = await new SignJWT({
    id: user.id,
    name: `${user.prenom} ${user.nom}`,
    tenant: await loadMembership(user.id),
    superAdmin: await loadIsSuperAdmin(user.id),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(user.id))
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(requireSecret());

  return { token, expiresAt: new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000) };
}

/** Lit un jeton ; null s'il est falsifié, tronqué, expiré ou destiné à l'autre client. */
export async function readSessionToken(token: string, audience: Audience): Promise<Session | null> {
  if (!getAuthSecret()) return null;

  let payload;
  try {
    ({ payload } = await jwtVerify(token, requireSecret(), { algorithms: ["HS256"], audience }));
  } catch {
    return null;
  }
  if (typeof payload.id !== "number") return null;

  const expiresAt = typeof payload.exp === "number" ? payload.exp * 1000 : Date.now();
  return {
    expires: new Date(expiresAt).toISOString(),
    user: {
      id: payload.id,
      name: typeof payload.name === "string" ? payload.name : null,
      tenant: (payload.tenant as SessionTenant) ?? null,
    },
    issuedAt: typeof payload.iat === "number" ? new Date(payload.iat * 1000) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Cookie de session du site web
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = "rayon_session";

/**
 * `HttpOnly` : invisible du JavaScript (un script injecté ne peut pas voler la
 * session). `Secure` en production : jamais envoyé en clair. `SameSite=Lax` :
 * pas envoyé par les requêtes d'écriture venant d'un autre site.
 */
export function cookieBaseOptions(): CookieOptions {
  const requested = process.env.COOKIE_SAMESITE;
  const sameSite = requested === "none" || requested === "strict" ? requested : "lax";
  const secure = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "true" : process.env.NODE_ENV === "production";
  // Un cookie `SameSite=None` est refusé par les navigateurs s'il n'est pas `Secure`.
  return { httpOnly: true, sameSite, secure: secure || sameSite === "none", path: "/" };
}

export function setSessionCookie(res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, { ...cookieBaseOptions(), maxAge: SESSION_MAX_AGE_SECONDS * 1000 });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, cookieBaseOptions());
}

/** Jeton du cookie de session de la requête en cours, s'il y en a un. */
export function getSessionCookie(): string | null {
  const cookies = currentRequest()?.cookies as Record<string, string> | undefined;
  return cookies?.[SESSION_COOKIE] ?? null;
}

/**
 * Session de la requête en cours : le cookie du site web, sinon l'en-tête
 * `Authorization: Bearer` de l'application mobile. Null si la requête n'est
 * pas authentifiée ou si le jeton est invalide.
 */
export async function getRequestSession(): Promise<Session | null> {
  // Hors d'une requête HTTP (tests des services, scripts) : pas de session.
  const req = currentRequest();
  if (!req) return null;

  const cookie = getSessionCookie();
  if (cookie) {
    const session = await readSessionToken(cookie, "web");
    if (session) return session;
  }

  const match = req.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  return match ? readSessionToken(match[1], "mobile") : null;
}
