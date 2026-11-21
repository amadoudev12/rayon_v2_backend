import { SubscriptionStatus } from "@/generated/prisma/enums";
import { ApiError } from "@/lib/api/errors";
import {
  GRACE_DAYS,
  TRIAL_DAYS,
  TRIAL_PLAN,
  getPlan,
  isDuration,
  isPlanCode,
  periodPrice,
  resolvePlan,
  SUBSCRIPTION_CURRENCY,
  type DurationMonths,
  type PlanCode,
} from "./plans";

/**
 * Règles d'abonnement PURES (aucun accès à la base) : échéances, états,
 * renouvellements, prorata et changements de forfait. Toutes les dates sont
 * en UTC ; `now` est toujours passé explicitement pour des calculs
 * déterministes et testables. Voir docs/ABONNEMENTS.md.
 */

export const DAY_MS = 86_400_000;

/** Ligne `Abonnement` telle que les règles en ont besoin. */
export type SubscriptionRecord = {
  plan: string;
  statut: SubscriptionStatus;
  essaiFinLe: Date | null;
  periodeDebut: Date;
  periodeFin: Date;
  forfaitProgramme?: string | null;
  forfaitProgrammeLe?: Date | null;
};

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/**
 * Ajoute des mois calendaires (UTC). Le jour est ramené au dernier jour du
 * mois cible s'il n'existe pas : 30 novembre + 3 mois = 28 (ou 29) février.
 */
export function addMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const result = new Date(date.getTime());
  result.setUTCFullYear(year, month, Math.min(date.getUTCDate(), lastDay));
  return result;
}

/** Fin du délai de grâce : 7 jours après l'échéance ; lecture seule ensuite. */
export function graceEnd(periodEnd: Date): Date {
  return addDays(periodEnd, GRACE_DAYS);
}

/** Nombre de jours restants, jour entamé compté : (0, 1 j] → 1. */
export function remainingDays(periodEnd: Date, now: Date): number {
  return Math.max(0, Math.ceil((periodEnd.getTime() - now.getTime()) / DAY_MS));
}

/**
 * Montant d'une mise à niveau au prorata (formule validée, docs/ABONNEMENTS.md) :
 *   ⌈ (prix mensuel nouveau − prix mensuel actuel) × jours restants ÷ 30 ⌉
 * Prix du catalogue, arrondi au franc supérieur (le XOF n'a pas de centimes).
 */
export function upgradeProrata(currentMonthly: number, targetMonthly: number, days: number): number {
  const difference = targetMonthly - currentMonthly;
  if (!Number.isInteger(difference) || difference <= 0) throw new Error("Une mise à niveau suppose un forfait plus cher.");
  if (!Number.isInteger(days) || days <= 0) throw new Error("Aucun jour restant à proratiser.");
  return Math.floor((difference * days + 29) / 30);
}

/** Phase commerciale d'un abonnement à l'instant `now`. */
export type Phase =
  /** Essai en cours. */
  | "TRIAL"
  /** Essai terminé sans paiement : lecture seule, sans délai de grâce (cahier §5). */
  | "TRIAL_ENDED"
  /** Période payée en cours. */
  | "ACTIVE"
  /** Échéance dépassée depuis moins de 7 jours : accès normal. */
  | "GRACE"
  /** Délai de grâce dépassé : lecture seule. */
  | "EXPIRED"
  /** Suspension administrative (distincte de l'expiration commerciale). */
  | "SUSPENDED"
  /** Résilié (statut historique) : lecture seule. */
  | "CANCELLED";

export function phaseOf(subscription: SubscriptionRecord, now: Date): Phase {
  switch (subscription.statut) {
    case SubscriptionStatus.SUSPENDED:
      return "SUSPENDED";
    case SubscriptionStatus.CANCELLED:
      return "CANCELLED";
    case SubscriptionStatus.TRIAL: {
      const end = subscription.essaiFinLe ?? subscription.periodeFin;
      return end > now ? "TRIAL" : "TRIAL_ENDED";
    }
    default:
      // ACTIVE et PAST_DUE : l'état découle des dates, jamais d'une tâche planifiée.
      if (subscription.periodeFin > now) return "ACTIVE";
      return graceEnd(subscription.periodeFin) > now ? "GRACE" : "EXPIRED";
  }
}

/**
 * Forfait en vigueur à `now` : une rétrogradation programmée s'applique dès
 * son échéance, même si la tâche de maintenance n'est pas encore passée.
 */
export function effectivePlanCode(subscription: SubscriptionRecord, now: Date): string {
  if (subscription.statut === SubscriptionStatus.TRIAL) return TRIAL_PLAN;
  const { forfaitProgramme, forfaitProgrammeLe } = subscription;
  if (forfaitProgramme && forfaitProgrammeLe && forfaitProgrammeLe <= now) return forfaitProgramme;
  return subscription.plan;
}

/** Vue de l'abonnement avec la rétrogradation échue déjà appliquée. */
export function normalize(subscription: SubscriptionRecord, now: Date): SubscriptionRecord {
  const plan = subscription.statut === SubscriptionStatus.TRIAL ? subscription.plan : effectivePlanCode(subscription, now);
  const due = plan !== subscription.plan;
  return {
    ...subscription,
    plan,
    forfaitProgramme: due ? null : (subscription.forfaitProgramme ?? null),
    forfaitProgrammeLe: due ? null : (subscription.forfaitProgrammeLe ?? null),
  };
}

/** Valeurs d'une nouvelle période d'essai (création d'organisation). */
export function trialValues(now: Date) {
  const end = addDays(now, TRIAL_DAYS);
  return {
    plan: TRIAL_PLAN as string,
    statut: SubscriptionStatus.TRIAL,
    essaiDebutLe: now,
    essaiFinLe: end,
    periodeDebut: now,
    periodeFin: end,
  };
}

// ---------------------------------------------------------------------------
// Achats : souscription, renouvellement, mise à niveau
// ---------------------------------------------------------------------------

export type PurchaseRequest =
  /** Achat d'une durée (souscription ou renouvellement) d'un forfait. */
  | { type: "PERIOD"; plan: PlanCode; months: DurationMonths }
  /** Passage immédiat à un forfait supérieur, au prorata, échéance inchangée. */
  | { type: "UPGRADE"; plan: PlanCode };

export type PurchaseKind = "SUBSCRIPTION" | "RENEWAL" | "UPGRADE";

export type Quote = {
  kind: PurchaseKind;
  plan: PlanCode;
  months: DurationMonths | null;
  amount: number;
  currency: string;
  /** Forfait en vigueur avant l'achat (null : aucun abonnement). */
  previousPlan: string | null;
  /** Période couverte par l'achat. Mise à niveau : de maintenant à l'échéance actuelle. */
  periodStart: Date;
  periodEnd: Date;
  /** Mise à niveau : jours restants proratisés. */
  remainingDays: number | null;
  /** Rétrogradation programmée qui résultera de l'achat (renouvellement anticipé vers un forfait inférieur). */
  scheduledPlan: PlanCode | null;
  scheduledAt: Date | null;
};

/** Valeurs de l'abonnement après application d'un achat confirmé. */
export type SubscriptionValues = {
  plan: string;
  statut: SubscriptionStatus;
  essaiFinLe: Date | null;
  periodeDebut: Date;
  periodeFin: Date;
  forfaitProgramme: string | null;
  forfaitProgrammeLe: Date | null;
};

const purchaseError = (message: string, code: string) => new ApiError(409, message, undefined, code);

export function parsePurchaseRequest(input: { type?: unknown; plan?: unknown; months?: unknown }): PurchaseRequest {
  if (!isPlanCode(input.plan)) throw new ApiError(400, "Forfait inconnu.", undefined, "PLAN_UNKNOWN");
  if (input.type === "UPGRADE") return { type: "UPGRADE", plan: input.plan };
  if (input.type !== "PERIOD") throw new ApiError(400, "Type d'achat invalide.", undefined, "PURCHASE_TYPE_INVALID");
  const months = Number(input.months);
  if (!isDuration(months)) throw new ApiError(400, "Durée invalide : 1, 3, 6 ou 12 mois.", undefined, "DURATION_INVALID");
  return { type: "PERIOD", plan: input.plan, months };
}

/**
 * Calcule ce que coûte un achat et la période qu'il couvre, à l'instant
 * `now`. Le backend est la seule autorité : le même calcul est refait à la
 * confirmation du paiement (l'état a pu changer entre-temps).
 *
 * Renouvellement (cahier §7) :
 * - avant l'échéance ou pendant la grâce : la période part de l'ancienne échéance ;
 * - après la grâce, après un essai, sans abonnement : elle part de `now`
 *   (date de confirmation du paiement).
 */
export function quotePurchase(current: SubscriptionRecord | null, request: PurchaseRequest, now: Date): Quote {
  const subscription = current ? normalize(current, now) : null;
  const phase = subscription ? phaseOf(subscription, now) : null;
  if (phase === "SUSPENDED") {
    throw purchaseError("Votre abonnement est suspendu par l'administration de Rayon : contactez le support.", "SUBSCRIPTION_SUSPENDED");
  }
  const target = getPlan(request.plan);
  const base = { plan: request.plan, currency: SUBSCRIPTION_CURRENCY, previousPlan: subscription?.plan ?? null };

  if (request.type === "UPGRADE") {
    if (!subscription || phase !== "ACTIVE") {
      throw purchaseError(
        phase === "TRIAL" || phase === "TRIAL_ENDED" || !subscription
          ? "Aucun forfait payé en cours : choisissez un forfait et une durée."
          : "Votre abonnement est arrivé à échéance : renouvelez-le directement avec le forfait souhaité.",
        "UPGRADE_NOT_APPLICABLE",
      );
    }
    const { plan: currentPlan, legacy } = resolvePlan(subscription.plan);
    if (legacy || target.rank <= currentPlan.rank) {
      throw purchaseError("La mise à niveau doit viser un forfait supérieur au forfait actuel.", "UPGRADE_NOT_HIGHER");
    }
    if (subscription.forfaitProgramme) {
      throw purchaseError("Annulez d'abord la rétrogradation programmée.", "DOWNGRADE_PENDING");
    }
    const days = remainingDays(subscription.periodeFin, now);
    return {
      ...base,
      kind: "UPGRADE",
      months: null,
      amount: upgradeProrata(currentPlan.monthlyPrice, target.monthlyPrice, days),
      periodStart: now,
      periodEnd: subscription.periodeFin,
      remainingDays: days,
      scheduledPlan: null,
      scheduledAt: null,
    };
  }

  const amount = periodPrice(request.plan, request.months);
  const period = { months: request.months, amount, remainingDays: null };

  // Renouvellement anticipé : les jours payés ne sont pas perdus.
  if (subscription && phase === "ACTIVE") {
    const start = subscription.periodeFin;
    const end = addMonths(start, request.months);
    const { plan: currentPlan, legacy } = resolvePlan(subscription.plan);
    const scheduled = subscription.forfaitProgramme ?? null;
    if (scheduled) {
      if (scheduled !== request.plan) {
        throw purchaseError(
          `Une rétrogradation vers ${getPlan(scheduled as PlanCode)?.name ?? scheduled} est programmée : renouvelez ce forfait, ou annulez d'abord la rétrogradation.`,
          "DOWNGRADE_PENDING",
        );
      }
      return { ...base, ...period, kind: "RENEWAL", periodStart: start, periodEnd: end, scheduledPlan: request.plan, scheduledAt: subscription.forfaitProgrammeLe ?? start };
    }
    if (!legacy && request.plan === currentPlan.code) {
      return { ...base, ...period, kind: "RENEWAL", periodStart: start, periodEnd: end, scheduledPlan: null, scheduledAt: null };
    }
    if (!legacy && target.rank > currentPlan.rank) {
      throw purchaseError(
        `Pour passer à ${target.name} avant l'échéance, faites d'abord une mise à niveau (montant au prorata), puis renouvelez.`,
        "UPGRADE_REQUIRED",
      );
    }
    // Forfait inférieur (ou forfait historique) : il prendra effet à l'échéance actuelle.
    return { ...base, ...period, kind: "RENEWAL", periodStart: start, periodEnd: end, scheduledPlan: request.plan, scheduledAt: start };
  }

  // Délai de grâce : la période repart de l'ancienne échéance (les jours de grâce ne sont pas offerts).
  if (subscription && phase === "GRACE") {
    const start = subscription.periodeFin;
    return { ...base, ...period, kind: "RENEWAL", periodStart: start, periodEnd: addMonths(start, request.months), scheduledPlan: null, scheduledAt: null };
  }

  // Essai (en cours ou terminé), abonnement expiré ou résilié, ou aucun abonnement : à partir de maintenant.
  const kind: PurchaseKind = !subscription || phase === "TRIAL" || phase === "TRIAL_ENDED" ? "SUBSCRIPTION" : "RENEWAL";
  return { ...base, ...period, kind, periodStart: now, periodEnd: addMonths(now, request.months), scheduledPlan: null, scheduledAt: null };
}

/** Nouvelles valeurs de l'abonnement une fois l'achat confirmé à `confirmedAt`. */
export function applyQuote(current: SubscriptionRecord | null, quote: Quote, confirmedAt: Date): SubscriptionValues {
  const subscription = current ? normalize(current, confirmedAt) : null;

  if (quote.kind === "UPGRADE") {
    if (!subscription) throw new Error("Mise à niveau sans abonnement.");
    return {
      plan: quote.plan,
      statut: SubscriptionStatus.ACTIVE,
      essaiFinLe: subscription.essaiFinLe,
      periodeDebut: subscription.periodeDebut,
      periodeFin: subscription.periodeFin,
      forfaitProgramme: null,
      forfaitProgrammeLe: null,
    };
  }

  // Continuité : la nouvelle période prolonge la précédente (renouvellement anticipé ou pendant la grâce).
  const continuous = subscription !== null && subscription.statut !== SubscriptionStatus.TRIAL && quote.periodStart.getTime() === subscription.periodeFin.getTime();
  const essaiFinLe =
    subscription?.statut === SubscriptionStatus.TRIAL && subscription.essaiFinLe && subscription.essaiFinLe > confirmedAt
      ? confirmedAt // essai interrompu par la souscription (effet immédiat)
      : (subscription?.essaiFinLe ?? null);

  return {
    plan: quote.scheduledPlan ? subscription!.plan : quote.plan,
    statut: SubscriptionStatus.ACTIVE,
    essaiFinLe,
    periodeDebut: continuous ? subscription!.periodeDebut : quote.periodStart,
    periodeFin: quote.periodEnd,
    forfaitProgramme: quote.scheduledPlan,
    forfaitProgrammeLe: quote.scheduledAt,
  };
}

// ---------------------------------------------------------------------------
// Rétrogradation programmée
// ---------------------------------------------------------------------------

/** Programme le passage à un forfait inférieur à l'échéance actuelle (sans remboursement). */
export function scheduleDowngrade(current: SubscriptionRecord | null, target: PlanCode, now: Date): { forfaitProgramme: PlanCode; forfaitProgrammeLe: Date } {
  const subscription = current ? normalize(current, now) : null;
  if (!subscription || phaseOf(subscription, now) !== "ACTIVE") {
    throw purchaseError("Une rétrogradation se programme pendant une période payée en cours.", "DOWNGRADE_NOT_APPLICABLE");
  }
  const { plan: currentPlan, legacy } = resolvePlan(subscription.plan);
  if (!legacy && getPlan(target).rank >= currentPlan.rank) {
    throw purchaseError("La rétrogradation doit viser un forfait inférieur au forfait actuel.", "DOWNGRADE_NOT_LOWER");
  }
  return { forfaitProgramme: target, forfaitProgrammeLe: subscription.periodeFin };
}
