import { Prisma } from "@/generated/prisma/client";
import { SubscriptionPaymentStatus, SubscriptionStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { ApiError, Errors } from "@/lib/api/errors";
import { requestCache } from "@/lib/http/context";
import { lockOrganization } from "@/lib/locks";
import { runTransaction, type Tx } from "@/lib/transactions";
import { recordAdminAudit, subscriptionSnapshot } from "@/services/billing/audit";
import { subscriptionsEnforced } from "@/services/billing/flags";
import { getPlan, isPlanCode, type PlanCode } from "@/services/billing/plans";
import { notifyOwner } from "@/services/notifications";
import {
  applyQuote,
  effectivePlanCode,
  graceEnd,
  phaseOf,
  quotePurchase,
  scheduleDowngrade,
  trialValues,
  type PurchaseRequest,
  type Quote,
  type SubscriptionRecord,
} from "@/services/billing/rules";

/**
 * SubscriptionService — essais, échéances, renouvellements, changements de
 * forfait et droits d'accès. Les règles de calcul (pures) sont dans
 * `billing/rules`, le catalogue dans `billing/plans`.
 *
 * - Aucune ligne `Abonnement` : organisation NON SOUMISE (comptes existants,
 *   décision métier : aucun forfait attribué automatiquement).
 * - Essai : 14 jours, droits PREMIUM, puis lecture seule sans délai de grâce.
 * - Période payée : accès complet jusqu'à `periodeFin`, puis 7 jours de grâce
 *   (accès normal), puis LECTURE SEULE. Les données ne sont jamais bloquées :
 *   consultation et exports restent possibles.
 * - Suspension administrative : lecture seule, distincte de l'expiration.
 *
 * Les blocages (lecture seule, fonctionnalités, quotas) ne s'appliquent que
 * si SUBSCRIPTIONS_ENFORCED=true : les activer est une décision commerciale,
 * pas un effet du déploiement.
 */
export type AccessState = "UNMANAGED" | "TRIAL" | "ACTIVE" | "GRACE" | "READ_ONLY";

/** Cause d'une lecture seule. */
export type ReadOnlyReason = "TRIAL_ENDED" | "EXPIRED" | "SUSPENDED" | "CANCELLED";

export type SubscriptionAccess = {
  state: AccessState;
  canWrite: boolean;
  /** Date jusqu'à laquelle l'accès complet est garanti (null : non soumis ou suspendu). */
  accessUntil: Date | null;
  /** Forfait en vigueur (essai : PREMIUM ; rétrogradation échue appliquée). */
  plan: string | null;
  /** Vrai à 5 jours ou moins de la fin de l'accès complet : afficher un rappel. */
  endsSoon: boolean;
  reason: ReadOnlyReason | null;
  /** Échéance de la période payée (essai : fin de l'essai). */
  periodEnd: Date | null;
  /** Fin du délai de grâce (null pour un essai : pas de grâce). */
  graceEndsAt: Date | null;
  scheduledPlan: string | null;
  scheduledAt: Date | null;
};

type AccessInput = Pick<SubscriptionRecord, "statut" | "essaiFinLe" | "periodeFin" | "plan"> &
  Partial<Pick<SubscriptionRecord, "periodeDebut" | "forfaitProgramme" | "forfaitProgrammeLe">>;

const SOON_MS = 5 * 86_400_000;
export { subscriptionsEnforced };

const asRecord = (subscription: AccessInput): SubscriptionRecord => ({
  periodeDebut: subscription.periodeDebut ?? subscription.periodeFin,
  forfaitProgramme: null,
  forfaitProgrammeLe: null,
  ...subscription,
});

export function accessFromSubscription(subscription: AccessInput | null, now = new Date()): SubscriptionAccess {
  if (!subscription) {
    return { state: "UNMANAGED", canWrite: true, accessUntil: null, plan: null, endsSoon: false, reason: null, periodEnd: null, graceEndsAt: null, scheduledPlan: null, scheduledAt: null };
  }
  const record = asRecord(subscription);
  const phase = phaseOf(record, now);
  const plan = effectivePlanCode(record, now);
  const trialEnd = record.essaiFinLe ?? record.periodeFin;
  const isTrial = record.statut === SubscriptionStatus.TRIAL;
  const pending = record.forfaitProgramme && record.forfaitProgrammeLe && record.forfaitProgrammeLe > now;
  const common = {
    plan,
    periodEnd: isTrial ? trialEnd : record.periodeFin,
    graceEndsAt: isTrial ? null : graceEnd(record.periodeFin),
    scheduledPlan: pending ? record.forfaitProgramme! : null,
    scheduledAt: pending ? record.forfaitProgrammeLe! : null,
  };
  const base = (() => {
    switch (phase) {
      case "TRIAL":
        return { state: "TRIAL" as const, canWrite: true, accessUntil: trialEnd, reason: null };
      case "TRIAL_ENDED":
        return { state: "READ_ONLY" as const, canWrite: false, accessUntil: trialEnd, reason: "TRIAL_ENDED" as const };
      case "ACTIVE":
        return { state: "ACTIVE" as const, canWrite: true, accessUntil: record.periodeFin, reason: null };
      case "GRACE":
        return { state: "GRACE" as const, canWrite: true, accessUntil: graceEnd(record.periodeFin), reason: null };
      case "EXPIRED":
        return { state: "READ_ONLY" as const, canWrite: false, accessUntil: graceEnd(record.periodeFin), reason: "EXPIRED" as const };
      case "SUSPENDED":
        return { state: "READ_ONLY" as const, canWrite: false, accessUntil: null, reason: "SUSPENDED" as const };
      case "CANCELLED":
        return { state: "READ_ONLY" as const, canWrite: false, accessUntil: null, reason: "CANCELLED" as const };
    }
  })();
  const endsSoon = base.canWrite && base.accessUntil !== null && base.accessUntil.getTime() - now.getTime() < SOON_MS;
  return { ...base, ...common, endsSoon };
}

const ACCESS_SELECT = {
  statut: true,
  essaiFinLe: true,
  periodeDebut: true,
  periodeFin: true,
  plan: true,
  forfaitProgramme: true,
  forfaitProgrammeLe: true,
} as const;

/** État d'accès, mémorisé pour la durée d'une requête HTTP (une seule lecture). */
export const getSubscriptionAccess = requestCache(async (organizationId: number): Promise<SubscriptionAccess> => {
  const subscription = await prisma.abonnement.findUnique({ where: { organisationId: organizationId }, select: ACCESS_SELECT });
  return accessFromSubscription(subscription);
});

const READ_ONLY_MESSAGES: Record<ReadOnlyReason, string> = {
  TRIAL_ENDED:
    "Votre période d'essai est terminée : l'application est en lecture seule. Vos données restent consultables et exportables ; choisissez un forfait pour reprendre les ventes.",
  EXPIRED:
    "Votre abonnement n'est plus actif : l'application est en lecture seule. Vos données restent consultables et exportables ; renouvelez l'abonnement pour reprendre les ventes.",
  SUSPENDED:
    "Votre abonnement est suspendu par l'administration de Rayon : l'application est en lecture seule. Vos données restent consultables ; contactez le support.",
  CANCELLED:
    "Votre abonnement est résilié : l'application est en lecture seule. Vos données restent consultables et exportables ; souscrivez un forfait pour reprendre les ventes.",
};

/** Lève 402 si l'organisation est en lecture seule et que le contrôle est activé. */
export async function assertCanWrite(organizationId: number) {
  if (!subscriptionsEnforced()) return;
  const access = await getSubscriptionAccess(organizationId);
  if (!access.canWrite) {
    const reason = access.reason ?? "EXPIRED";
    throw new ApiError(402, READ_ONLY_MESSAGES[reason], { reason }, "SUBSCRIPTION_INACTIVE");
  }
}

// ---------------------------------------------------------------------------
// Historique
// ---------------------------------------------------------------------------

type HistoryEntry = {
  action: string;
  before: { plan: string; statut: SubscriptionStatus; periodeFin: Date } | null;
  after: { plan: string; statut: SubscriptionStatus; periodeFin: Date };
  performedBy: number | null;
  reason?: string | null;
  metadata?: Prisma.InputJsonValue;
};

export async function recordHistory(tx: Tx, subscription: { id: number; organisationId: number }, entry: HistoryEntry) {
  await tx.historiqueAbonnement.create({
    data: {
      abonnementId: subscription.id,
      organisationId: subscription.organisationId,
      action: entry.action,
      ancienForfait: entry.before?.plan ?? null,
      nouveauForfait: entry.after.plan,
      ancienStatut: entry.before?.statut ?? null,
      nouveauStatut: entry.after.statut,
      anciennePeriodeFin: entry.before?.periodeFin ?? null,
      nouvellePeriodeFin: entry.after.periodeFin,
      motif: entry.reason ?? null,
      metadonnees: entry.metadata,
      effectueParId: entry.performedBy,
    },
  });
}

// ---------------------------------------------------------------------------
// Essai gratuit
// ---------------------------------------------------------------------------

/**
 * Démarre l'essai gratuit d'une organisation qui vient d'être créée, dans la
 * transaction de sa création. Un seul essai par organisation : sans effet si
 * un abonnement existe déjà (les membres invités partagent cet abonnement et
 * n'en déclenchent jamais un nouveau).
 */
export async function startTrial(tx: Tx, organizationId: number, performedBy: number | null, now = new Date()) {
  const existing = await tx.abonnement.findUnique({ where: { organisationId: organizationId }, select: { id: true } });
  if (existing) return null;
  const values = trialValues(now);
  const subscription = await tx.abonnement.create({ data: { organisationId: organizationId, ...values } });
  await recordHistory(tx, subscription, { action: "TRIAL_STARTED", before: null, after: subscription, performedBy });
  return subscription;
}

// ---------------------------------------------------------------------------
// Achats : devis, application d'un paiement confirmé
// ---------------------------------------------------------------------------

async function loadRecord(client: Tx | typeof prisma, organizationId: number) {
  return client.abonnement.findUnique({ where: { organisationId: organizationId } });
}

/** Devis d'un achat pour une organisation, calculé par le serveur à `now`. */
export async function quoteForOrganization(organizationId: number, request: PurchaseRequest, now = new Date()): Promise<Quote> {
  return quotePurchase(await loadRecord(prisma, organizationId), request, now);
}

const HISTORY_ACTION: Record<Quote["kind"], string> = { SUBSCRIPTION: "SUBSCRIBED", RENEWAL: "RENEWED", UPGRADE: "UPGRADED" };

/**
 * Applique un achat dont le paiement est CONFIRMÉ, dans la transaction de la
 * confirmation (phase 3 : webhook vérifié ; administration : saisie manuelle).
 *
 * Le devis est recalculé à `confirmedAt` sur la ligne verrouillée : un
 * renouvellement initié pendant la grâce mais confirmé après part de la
 * confirmation. Un montant payé inférieur au montant dû est refusé
 * (AMOUNT_MISMATCH) : l'appelant met alors le paiement en vérification.
 */
export async function applyConfirmedPurchase(
  tx: Tx,
  organizationId: number,
  request: PurchaseRequest,
  options: { confirmedAt: Date; amountPaid: number; performedBy: number | null; metadata?: Prisma.InputJsonValue },
) {
  await lockOrganization(tx, organizationId);
  const current = await loadRecord(tx, organizationId);
  const quote = quotePurchase(current, request, options.confirmedAt);
  if (!Number.isFinite(options.amountPaid) || options.amountPaid < quote.amount) {
    throw new ApiError(409, "Le montant payé ne correspond pas au montant dû.", { expected: quote.amount, paid: options.amountPaid }, "AMOUNT_MISMATCH");
  }
  const values = applyQuote(current, quote, options.confirmedAt);
  const subscription = current
    ? await tx.abonnement.update({ where: { id: current.id }, data: { ...values, annuleLe: null, suspenduLe: null, motifSuspension: null } })
    : await tx.abonnement.create({ data: { organisationId: organizationId, ...values } });

  await recordHistory(tx, subscription, {
    action: HISTORY_ACTION[quote.kind],
    before: current,
    after: subscription,
    performedBy: options.performedBy,
    metadata: {
      kind: quote.kind,
      plan: quote.plan,
      months: quote.months,
      amount: quote.amount,
      currency: quote.currency,
      periodStart: quote.periodStart.toISOString(),
      periodEnd: quote.periodEnd.toISOString(),
      remainingDays: quote.remainingDays,
      scheduledPlan: quote.scheduledPlan,
      ...(options.metadata && typeof options.metadata === "object" && !Array.isArray(options.metadata) ? options.metadata : {}),
    },
  });
  return { quote, subscription };
}

// ---------------------------------------------------------------------------
// Rétrogradation programmée
// ---------------------------------------------------------------------------

/** Programme un forfait inférieur à l'échéance (aucun remboursement, aucune donnée supprimée). */
export async function scheduleDowngradeForOrganization(organizationId: number, target: PlanCode, performedBy: number, now = new Date()) {
  return runTransaction(async (tx) => {
    await lockOrganization(tx, organizationId);
    const current = await loadRecord(tx, organizationId);
    const schedule = scheduleDowngrade(current, target, now);
    const subscription = await tx.abonnement.update({ where: { id: current!.id }, data: schedule });
    await recordHistory(tx, subscription, {
      action: "DOWNGRADE_SCHEDULED",
      before: current,
      after: subscription,
      performedBy,
      metadata: { scheduledPlan: target, effectiveAt: schedule.forfaitProgrammeLe.toISOString() },
    });
    return subscription;
  });
}

export async function cancelScheduledDowngrade(organizationId: number, performedBy: number, now = new Date()) {
  return runTransaction(async (tx) => {
    await lockOrganization(tx, organizationId);
    const current = await loadRecord(tx, organizationId);
    if (!current?.forfaitProgramme || !current.forfaitProgrammeLe || current.forfaitProgrammeLe <= now) {
      throw new ApiError(409, "Aucune rétrogradation programmée à annuler.", undefined, "NO_SCHEDULED_CHANGE");
    }
    const subscription = await tx.abonnement.update({ where: { id: current.id }, data: { forfaitProgramme: null, forfaitProgrammeLe: null } });
    await recordHistory(tx, subscription, {
      action: "DOWNGRADE_CANCELLED",
      before: current,
      after: subscription,
      performedBy,
      metadata: { cancelledPlan: current.forfaitProgramme },
    });
    return subscription;
  });
}

// ---------------------------------------------------------------------------
// Maintenance planifiée
// ---------------------------------------------------------------------------

/**
 * Inscrit en base les changements échus (rétrogradations programmées) et les
 * trace dans l'historique. Les droits n'en dépendent pas — ils sont calculés
 * à chaque requête — : un retard de la tâche n'a donc aucun effet commercial.
 * Idempotent et sûr en cas d'exécutions simultanées (mise à jour conditionnelle).
 */
export async function runSubscriptionMaintenance(now = new Date()) {
  const due = await prisma.abonnement.findMany({
    where: { forfaitProgramme: { not: null }, forfaitProgrammeLe: { lte: now } },
    select: { id: true },
    take: 500,
  });
  let applied = 0;
  for (const { id } of due) {
    const done = await runTransaction(async (tx) => {
      const current = await tx.abonnement.findUnique({ where: { id } });
      if (!current?.forfaitProgramme || !current.forfaitProgrammeLe || current.forfaitProgrammeLe > now) return false;
      const result = await tx.abonnement.updateMany({
        where: { id, forfaitProgramme: current.forfaitProgramme, forfaitProgrammeLe: current.forfaitProgrammeLe },
        data: { plan: current.forfaitProgramme, forfaitProgramme: null, forfaitProgrammeLe: null },
      });
      if (result.count !== 1) return false;
      await notifyOwner(tx, current.organisationId, {
        type: "PLAN_CHANGED",
        title: "Nouveau forfait",
        message: `Votre forfait est désormais ${planName(current.forfaitProgramme)}, comme vous l'aviez programmé. Vos données sont conservées.`,
        key: `plan-changed:scheduled:${current.id}:${current.forfaitProgrammeLe.toISOString()}`,
      });
      await recordHistory(tx, current, {
        action: "PLAN_CHANGED",
        before: current,
        after: { ...current, plan: current.forfaitProgramme },
        performedBy: null,
        metadata: { scheduledAt: current.forfaitProgrammeLe.toISOString() },
      });
      return true;
    });
    if (done) applied += 1;
  }
  return { applied };
}

// ---------------------------------------------------------------------------
// Administration de la plateforme (saisie manuelle — refonte en phase 5)
// ---------------------------------------------------------------------------

export type SubscriptionInput = {
  plan: string;
  statut: SubscriptionStatus;
  essaiFinLe?: Date | null;
  periodeDebut: Date;
  periodeFin: Date;
};

/** Création ou mise à jour d'un abonnement par l'administration de la plateforme. */
export async function upsertSubscription(organizationId: number, input: SubscriptionInput, performedBy: number | null = null, reason: string | null = null) {
  if (input.periodeFin <= input.periodeDebut) throw Errors.conflict("La fin de période doit suivre son début.");
  return runTransaction(async (tx) => {
    const organization = await tx.organisation.findUnique({ where: { id: organizationId }, select: { id: true } });
    if (!organization) throw Errors.notFound("Organisation introuvable");
    await lockOrganization(tx, organizationId);
    const current = await loadRecord(tx, organizationId);
    // Un seul essai par organisation : il ne peut pas être relancé une fois terminé.
    if (input.statut === SubscriptionStatus.TRIAL && current?.essaiDebutLe && current.statut !== SubscriptionStatus.TRIAL) {
      throw Errors.conflict("L'essai gratuit de cette organisation a déjà été consommé.");
    }
    const now = new Date();
    const data = {
      ...input,
      annuleLe: input.statut === SubscriptionStatus.CANCELLED ? now : null,
      suspenduLe: input.statut === SubscriptionStatus.SUSPENDED ? (current?.suspenduLe ?? now) : null,
      ...(input.statut === SubscriptionStatus.TRIAL && !current?.essaiDebutLe ? { essaiDebutLe: input.periodeDebut } : {}),
    };
    const subscription = current
      ? await tx.abonnement.update({ where: { id: current.id }, data })
      : await tx.abonnement.create({ data: { organisationId: organizationId, ...data } });
    await recordHistory(tx, subscription, { action: "ADMIN_UPDATED", before: current, after: subscription, performedBy, reason });
    if (performedBy !== null) {
      await recordAdminAudit(tx, {
        adminId: performedBy,
        action: "subscription.updated",
        entity: "Abonnement",
        entityId: subscription.id,
        organizationId,
        before: subscriptionSnapshot(current),
        after: subscriptionSnapshot(subscription),
        reason,
      });
    }
    return subscription;
  });
}

export type SubscriptionPaymentInput = {
  fournisseur: string;
  referenceExterne: string;
  montant: number;
  devise: string;
  periodeDebut: Date;
  periodeFin: Date;
  statut: SubscriptionPaymentStatus;
  metadonnees?: Prisma.InputJsonValue;
};

/**
 * Enregistre un paiement d'abonnement reçu hors ligne, saisi par
 * l'administration avec sa période. Idempotent : une même référence chez un
 * même prestataire n'est traitée qu'une fois. Un paiement réussi prolonge la
 * période et réactive l'abonnement.
 */
export async function recordSubscriptionPayment(organizationId: number, input: SubscriptionPaymentInput, performedBy: number | null = null, reason: string | null = null) {
  if (input.periodeFin <= input.periodeDebut) throw Errors.conflict("La fin de période doit suivre son début.");
  return runTransaction(async (tx) => {
    await lockOrganization(tx, organizationId);
    const subscription = await tx.abonnement.findUnique({ where: { organisationId: organizationId } });
    if (!subscription) throw Errors.conflict("Créez d'abord l'abonnement de cette organisation.");
    const existing = await tx.paiementAbonnement.findUnique({
      where: { fournisseur_referenceExterne: { fournisseur: input.fournisseur, referenceExterne: input.referenceExterne } },
    });
    if (existing) {
      if (existing.abonnementId !== subscription.id || !existing.montant.equals(new Prisma.Decimal(input.montant))) {
        throw Errors.conflict("Cette référence de paiement a déjà été enregistrée pour un autre montant ou une autre organisation.");
      }
      return { payment: existing, subscription, replay: true };
    }
    const payment = await tx.paiementAbonnement.create({
      data: {
        abonnementId: subscription.id,
        fournisseur: input.fournisseur,
        referenceExterne: input.referenceExterne,
        montant: new Prisma.Decimal(input.montant).toDecimalPlaces(2),
        devise: input.devise.toUpperCase(),
        statut: input.statut,
        periodeDebut: input.periodeDebut,
        periodeFin: input.periodeFin,
        payeLe: input.statut === SubscriptionPaymentStatus.SUCCEEDED ? new Date() : null,
        metadonnees: input.metadonnees,
      },
    });
    let updated = subscription;
    if (input.statut === SubscriptionPaymentStatus.SUCCEEDED) {
      updated = await tx.abonnement.update({
        where: { id: subscription.id },
        data: {
          statut: SubscriptionStatus.ACTIVE,
          periodeFin: input.periodeFin > subscription.periodeFin ? input.periodeFin : subscription.periodeFin,
          annuleLe: null,
        },
      });
    }
    await recordHistory(tx, updated, {
      action: "PAYMENT_RECORDED",
      before: subscription,
      after: updated,
      performedBy,
      reason,
      metadata: { paymentId: payment.id, fournisseur: payment.fournisseur, referenceExterne: payment.referenceExterne, statut: payment.statut },
    });
    if (performedBy !== null) {
      await recordAdminAudit(tx, {
        adminId: performedBy,
        action: "payment.recorded",
        entity: "PaiementAbonnement",
        entityId: payment.id,
        organizationId,
        before: subscriptionSnapshot(subscription),
        after: { ...(subscriptionSnapshot(updated) as object), montant: input.montant, referenceExterne: input.referenceExterne },
        reason,
      });
    }
    return { payment, subscription: updated, replay: false };
  });
}

/** Libellé d'un code de forfait (codes historiques affichés tels quels). */
export function planName(code: string | null): string | null {
  if (!code) return null;
  return isPlanCode(code) ? getPlan(code).name : code;
}
