import type { NextFunction, Request, Response } from "express";
import { ApiError } from "@/lib/api/errors";
import type { AuthContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";
import { lockOrganization } from "@/lib/locks";
import { prisma } from "@/lib/prisma";
import type { Tx } from "@/lib/transactions";
import { getSubscriptionAccess, subscriptionsEnforced, type SubscriptionAccess } from "@/services/subscription";
import { FEATURES, getPlan, planHasFeature, QUOTA_LABELS, resolvePlan, type FeatureKey, type PlanDefinition, type QuotaKey } from "./plans";

/**
 * EntitlementService — contrôle CENTRALISÉ des fonctionnalités et des quotas.
 *
 * Toujours appliqué côté serveur (middleware de route ou service) : un
 * contournement de l'interface ou une requête HTTP directe est refusé de la
 * même façon. Sans contrôle activé (SUBSCRIPTIONS_ENFORCED) ou pour une
 * organisation non soumise, tout est permis, comme avant.
 *
 * Règle des fonctionnalités d'un forfait supérieur : leurs ÉCRITURES
 * (créations, modifications) exigent le forfait ; les données déjà
 * enregistrées restent consultables (rétrogradation : rien n'est caché ni
 * supprimé). Les fonctionnalités qui SONT des lectures (exports, analyses
 * de marge, valorisation) exigent le forfait.
 */
export type Entitlements = {
  /** Faux : organisation non soumise ou contrôle désactivé — aucune restriction. */
  restricted: boolean;
  plan: PlanDefinition | null;
  /** Code de forfait historique inconnu du catalogue (traité comme PREMIUM). */
  legacyPlan: boolean;
  limits: Record<QuotaKey, number | null>;
  has(feature: FeatureKey): boolean;
};

const UNRESTRICTED: Entitlements = {
  restricted: false,
  plan: null,
  legacyPlan: false,
  limits: { stores: null, users: null },
  has: () => true,
};

export function entitlementsFromAccess(access: SubscriptionAccess): Entitlements {
  if (access.state === "UNMANAGED") return UNRESTRICTED;
  const { plan, legacy } = resolvePlan(access.plan);
  return {
    restricted: true,
    plan,
    legacyPlan: legacy,
    limits: { ...plan.limits },
    has: (feature) => planHasFeature(plan.code, feature),
  };
}

export async function getEntitlements(organizationId: number): Promise<Entitlements> {
  if (!subscriptionsEnforced()) return UNRESTRICTED;
  return entitlementsFromAccess(await getSubscriptionAccess(organizationId));
}

export function featureRequiredError(feature: FeatureKey): ApiError {
  const definition = FEATURES[feature];
  const required = getPlan(definition.plan);
  return new ApiError(
    403,
    `« ${definition.label} » est inclus à partir du forfait ${required.name}. Passez à un forfait supérieur depuis la page Abonnement.`,
    { feature, requiredPlan: required.code },
    "PLAN_FEATURE_REQUIRED",
  );
}

export async function hasFeature(organizationId: number, feature: FeatureKey): Promise<boolean> {
  return (await getEntitlements(organizationId)).has(feature);
}

export async function assertFeature(organizationId: number, feature: FeatureKey): Promise<void> {
  if (!(await hasFeature(organizationId, feature))) throw featureRequiredError(feature);
}

/** Middleware de route : à placer après `verifyToken` (qui fournit `req.user`). */
export function requireFeature(feature: FeatureKey) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    await assertFeature(req.user.organizationId, feature);
    next();
  };
}

/**
 * Marges, coûts et bénéfices : rôle autorisé (`report:view`) ET forfait
 * incluant l'analyse des marges et le calcul des bénéfices nets.
 */
export async function canViewFinance(context: AuthContext): Promise<boolean> {
  if (!can(context.role, "report:view")) return false;
  const entitlements = await getEntitlements(context.organizationId);
  return entitlements.has("margin_analysis") && entitlements.has("net_profit");
}

async function countUsage(client: Tx | typeof prisma, organizationId: number, quota: QuotaKey): Promise<number> {
  return quota === "stores"
    ? client.boutique.count({ where: { organisationId: organizationId } })
    : client.membre.count({ where: { organisationId: organizationId } });
}

/**
 * Vérifie, DANS la transaction de création, qu'une ressource de plus reste
 * dans le quota du forfait. L'organisation est verrouillée : deux créations
 * simultanées ne peuvent pas dépasser la limite. Les ressources existantes
 * au-delà du quota (après une rétrogradation) sont conservées ; seules les
 * nouvelles créations sont bloquées.
 */
export async function assertQuota(tx: Tx, organizationId: number, quota: QuotaKey): Promise<void> {
  const entitlements = await getEntitlements(organizationId);
  const limit = entitlements.limits[quota];
  if (limit === null) return;
  await lockOrganization(tx, organizationId);
  const used = await countUsage(tx, organizationId, quota);
  if (used >= limit) {
    const plan = entitlements.plan!;
    throw new ApiError(
      403,
      `Votre forfait ${plan.name} est limité à ${limit} ${QUOTA_LABELS[quota]} (actuellement ${used}). Vos données existantes sont conservées ; passez à un forfait supérieur pour en ajouter.`,
      { quota, limit, used, plan: plan.code },
      "PLAN_QUOTA_REACHED",
    );
  }
}

/** Utilisation des quotas, pour informer clairement le client (page Abonnement). */
export async function getUsage(organizationId: number) {
  // Limites du forfait réel, même si le contrôle n'est pas encore activé.
  const entitlements = entitlementsFromAccess(await getSubscriptionAccess(organizationId));
  const [stores, users] = await Promise.all([countUsage(prisma, organizationId, "stores"), countUsage(prisma, organizationId, "users")]);
  const item = (used: number, limit: number | null) => ({ used, limit, overLimit: limit !== null && used > limit, atLimit: limit !== null && used >= limit });
  return { stores: item(stores, entitlements.limits.stores), users: item(users, entitlements.limits.users) };
}

/**
 * Résumé des droits pour l'interface : forfait en vigueur et fonctionnalités
 * DÉVELOPPÉES mais non incluses (à signaler, jamais à masquer en silence).
 * L'interface s'en sert pour informer ; le serveur reste seul juge.
 */
export async function describeEntitlements(organizationId: number) {
  const entitlements = await getEntitlements(organizationId);
  const locked = (Object.keys(FEATURES) as FeatureKey[])
    .filter((key) => FEATURES[key].available && !entitlements.has(key))
    .map((key) => ({ key, label: FEATURES[key].label, requiredPlan: FEATURES[key].plan }));
  return { restricted: entitlements.restricted, plan: entitlements.plan?.code ?? null, locked };
}
