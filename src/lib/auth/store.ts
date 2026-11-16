import { currentRequest } from "@/lib/http/context";
import { resolveActiveStoreId, type AuthContext } from "./session";

export const ACTIVE_STORE_COOKIE = "active_store";

/**
 * Resolves which store a page should render for: the member's
 * fixed store when restricted, otherwise whatever the store-switcher cookie
 * points to (still validated against the caller's own organization), else
 * the organization's default store.
 */
export async function getActiveStoreId(context: AuthContext): Promise<number> {
  if (context.membershipStoreId) return context.membershipStoreId;

  const cookies = currentRequest()?.cookies as Record<string, string> | undefined;
  const raw = cookies?.[ACTIVE_STORE_COOKIE];
  const requested = raw ? Number(raw) : undefined;
  return resolveActiveStoreId(context, requested);
}

/**
 * Boutique visée par une requête : celle demandée explicitement (mobile,
 * `boutiqueId` / `storeId`), sinon la boutique ACTIVE du sélecteur du site
 * (cookie), jamais la boutique par défaut de l'organisation. Toujours validée
 * contre l'organisation et la boutique imposée au membre.
 */
export async function resolveRequestStoreId(context: AuthContext, requestedStoreId?: number | null): Promise<number> {
  return requestedStoreId ? resolveActiveStoreId(context, requestedStoreId) : getActiveStoreId(context);
}
