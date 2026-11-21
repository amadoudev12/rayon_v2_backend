import { Role, SubscriptionPaymentStatus, SubscriptionStatus } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { ApiError, Errors } from "@/lib/api/errors";
import { formatDateFr } from "@/lib/format-fr";
import { lockOrganization } from "@/lib/locks";
import { prisma } from "@/lib/prisma";
import { containsText } from "@/lib/search";
import { runTransaction, type Tx } from "@/lib/transactions";
import { notifyOwner } from "@/services/notifications";
import { accessFromSubscription, planName, recordHistory, type SubscriptionAccess } from "@/services/subscription";
import { recordAdminAudit, subscriptionSnapshot } from "./audit";
import { entitlementsFromAccess, getUsage } from "./entitlements";
import { listPayments, listReceipts } from "./payments";
import { PLAN_CODES, resolvePlan, type DurationMonths, type PlanCode } from "./plans";
import { addMonths, DAY_MS, trialValues } from "./rules";

/**
 * AdminSubscriptionService — administration centrale des abonnements.
 *
 * Toute intervention manuelle exige un MOTIF et enregistre, dans la même
 * transaction : la modification, l'historique de l'abonnement, le journal
 * d'audit (administrateur, ancienne et nouvelle valeur, motif) et une
 * notification au propriétaire. Aucune intervention n'efface l'historique
 * financier : paiements et reçus ne sont jamais modifiés ici.
 */

type Subscription = Prisma.AbonnementGetPayload<object>;

export const MIN_REASON_LENGTH = 5;

function requireReason(reason: string | null | undefined): string {
  const value = reason?.trim() ?? "";
  if (value.length < MIN_REASON_LENGTH) {
    throw new ApiError(400, `Motif obligatoire (${MIN_REASON_LENGTH} caractères au moins).`, { fieldErrors: { motif: ["Motif obligatoire."] } }, "REASON_REQUIRED");
  }
  return value.slice(0, 500);
}

type Outcome = {
  subscription: Subscription;
  history: string;
  notification?: { type: string; title: string; message: string };
};

async function intervene(
  adminId: number,
  organizationId: number,
  input: { action: string; reason: string },
  apply: (tx: Tx, current: Subscription | null, now: Date) => Promise<Outcome>,
) {
  const reason = requireReason(input.reason);
  const now = new Date();
  return runTransaction(async (tx) => {
    const organization = await tx.organisation.findUnique({ where: { id: organizationId }, select: { id: true } });
    if (!organization) throw Errors.notFound("Organisation introuvable");
    await lockOrganization(tx, organizationId);
    const current = await tx.abonnement.findUnique({ where: { organisationId: organizationId } });
    const outcome = await apply(tx, current, now);

    await recordHistory(tx, outcome.subscription, { action: outcome.history, before: current, after: outcome.subscription, performedBy: adminId, reason });
    await recordAdminAudit(tx, {
      adminId,
      action: input.action,
      entity: "Abonnement",
      entityId: outcome.subscription.id,
      organizationId,
      before: subscriptionSnapshot(current),
      after: subscriptionSnapshot(outcome.subscription),
      reason,
    });
    if (outcome.notification) {
      await notifyOwner(tx, organizationId, { ...outcome.notification, key: `admin:${input.action}:${outcome.subscription.id}:${now.getTime()}` });
    }
    return outcome.subscription;
  });
}

const isPaidStatus = (status: SubscriptionStatus) => status === SubscriptionStatus.ACTIVE || status === SubscriptionStatus.PAST_DUE;

/**
 * Attribue un forfait.
 * - Avec une durée : accorde une période (offerte, ou payée hors système) ;
 *   elle prolonge la période payée en cours, sinon commence maintenant.
 * - Sans durée : change le forfait de la période payée en cours (dates inchangées).
 */
export async function assignPlan(adminId: number, organizationId: number, input: { plan: PlanCode; months?: DurationMonths | null; reason: string }) {
  return intervene(adminId, organizationId, { action: "subscription.plan_assigned", reason: input.reason }, async (tx, current, now) => {
    if (current?.statut === SubscriptionStatus.SUSPENDED) throw Errors.conflict("Abonnement suspendu : réactivez-le d'abord.");
    const reset = { forfaitProgramme: null, forfaitProgrammeLe: null, annuleLe: null };
    let data: Prisma.AbonnementUncheckedUpdateInput;
    let history: string;
    if (input.months) {
      const running = current !== null && isPaidStatus(current.statut) && current.periodeFin > now;
      const start = running ? current.periodeFin : now;
      data = {
        ...reset,
        plan: input.plan,
        statut: SubscriptionStatus.ACTIVE,
        periodeDebut: running ? current.periodeDebut : now,
        periodeFin: addMonths(start, input.months),
        essaiFinLe: current?.statut === SubscriptionStatus.TRIAL && current.essaiFinLe && current.essaiFinLe > now ? now : (current?.essaiFinLe ?? null),
      };
      history = "ADMIN_PLAN_GRANTED";
    } else {
      // Sans durée, seul le forfait change : il faut une période payée EN COURS (une échéance passée ne serait pas rétablie).
      if (!current || !isPaidStatus(current.statut) || current.periodeFin <= now) {
        throw Errors.conflict("Aucune période payée en cours : précisez une durée à attribuer.");
      }
      data = { ...reset, plan: input.plan };
      history = "ADMIN_PLAN_CHANGED";
    }
    const subscription = current
      ? await tx.abonnement.update({ where: { id: current.id }, data })
      : await tx.abonnement.create({ data: { ...(data as Prisma.AbonnementUncheckedCreateInput), organisationId: organizationId } });
    return {
      subscription,
      history,
      notification: {
        type: "PLAN_CHANGED",
        title: "Nouveau forfait",
        message: `Rayon a attribué le forfait ${planName(input.plan)} à votre organisation, jusqu'au ${formatDateFr(subscription.periodeFin)}.`,
      },
    };
  });
}

/** Prolonge exceptionnellement l'échéance (essai ou période payée) jusqu'à `until`. */
export async function extendSubscription(adminId: number, organizationId: number, input: { until: Date; reason: string }) {
  return intervene(adminId, organizationId, { action: "subscription.extended", reason: input.reason }, async (tx, current, now) => {
    if (!current) throw Errors.conflict("Aucun abonnement : attribuez d'abord un forfait ou un essai.");
    const trial = current.statut === SubscriptionStatus.TRIAL;
    const currentEnd = trial ? (current.essaiFinLe ?? current.periodeFin) : current.periodeFin;
    if (input.until <= now || input.until <= currentEnd) throw Errors.conflict("La nouvelle échéance doit être postérieure à l'échéance actuelle et à aujourd'hui.");
    if (input.until.getTime() - now.getTime() > 3 * 366 * DAY_MS) throw Errors.conflict("Prolongation limitée à trois ans.");
    const subscription = await tx.abonnement.update({
      where: { id: current.id },
      data: trial
        ? { essaiFinLe: input.until, periodeFin: input.until }
        : { periodeFin: input.until, ...(current.statut === SubscriptionStatus.CANCELLED ? { statut: SubscriptionStatus.ACTIVE, annuleLe: null } : {}) },
    });
    return {
      subscription,
      history: "ADMIN_EXTENDED",
      notification: {
        type: "SUBSCRIPTION_EXTENDED",
        title: trial ? "Essai prolongé" : "Échéance prolongée",
        message: `${trial ? "Votre période d'essai" : "Votre abonnement"} est prolongé jusqu'au ${formatDateFr(input.until)}.`,
      },
    };
  });
}

/** Suspension administrative : lecture seule, distincte d'une expiration ; aucune donnée supprimée. */
export async function suspendSubscription(adminId: number, organizationId: number, input: { reason: string }) {
  return intervene(adminId, organizationId, { action: "subscription.suspended", reason: input.reason }, async (tx, current, now) => {
    if (!current) throw Errors.conflict("Aucun abonnement à suspendre.");
    if (current.statut === SubscriptionStatus.SUSPENDED) throw Errors.conflict("Abonnement déjà suspendu.");
    const subscription = await tx.abonnement.update({
      where: { id: current.id },
      data: { statut: SubscriptionStatus.SUSPENDED, statutAvantSuspension: current.statut, suspenduLe: now, motifSuspension: input.reason.trim().slice(0, 500) },
    });
    return {
      subscription,
      history: "ADMIN_SUSPENDED",
      notification: {
        type: "SUBSCRIPTION_SUSPENDED",
        title: "Abonnement suspendu",
        message: "Votre abonnement est suspendu par l'administration de Rayon : l'application est en lecture seule. Vos données sont conservées. Contactez le support.",
      },
    };
  });
}

/** Réactivation : le statut d'avant la suspension est rétabli (essai ou période payée). */
export async function reactivateSubscription(adminId: number, organizationId: number, input: { reason: string }) {
  return intervene(adminId, organizationId, { action: "subscription.reactivated", reason: input.reason }, async (tx, current) => {
    if (current?.statut !== SubscriptionStatus.SUSPENDED) throw Errors.conflict("Cet abonnement n'est pas suspendu.");
    const subscription = await tx.abonnement.update({
      where: { id: current.id },
      data: { statut: current.statutAvantSuspension ?? SubscriptionStatus.ACTIVE, statutAvantSuspension: null, suspenduLe: null, motifSuspension: null },
    });
    return {
      subscription,
      history: "ADMIN_REACTIVATED",
      notification: { type: "SUBSCRIPTION_REACTIVATED", title: "Abonnement réactivé", message: "Votre abonnement est réactivé : les droits de votre forfait s'appliquent de nouveau." },
    };
  });
}

/**
 * Essai gratuit accordé à une organisation existante qui n'a jamais eu
 * d'abonnement (décision métier : pas d'attribution automatique).
 */
export async function grantTrial(adminId: number, organizationId: number, input: { reason: string }) {
  return intervene(adminId, organizationId, { action: "subscription.trial_granted", reason: input.reason }, async (tx, current, now) => {
    if (current) throw Errors.conflict("Cette organisation a déjà un abonnement : l'essai gratuit est unique.");
    const subscription = await tx.abonnement.create({ data: { organisationId: organizationId, ...trialValues(now) } });
    return {
      subscription,
      history: "TRIAL_STARTED",
      notification: {
        type: "TRIAL_STARTED",
        title: "Essai gratuit activé",
        message: `Votre essai gratuit Premium est actif jusqu'au ${formatDateFr(subscription.periodeFin)}.`,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Tableau de bord, liste et fiche
// ---------------------------------------------------------------------------

export const ADMIN_STATE_FILTERS = ["UNMANAGED", "TRIAL", "ACTIVE", "GRACE", "READ_ONLY", "SUSPENDED", "EXPIRING"] as const;
export type AdminStateFilter = (typeof ADMIN_STATE_FILTERS)[number];

const ACCESS_FIELDS = { id: true, plan: true, statut: true, essaiFinLe: true, periodeDebut: true, periodeFin: true, forfaitProgramme: true, forfaitProgrammeLe: true } as const;

const SOON_DAYS = 7;
const expiringSoon = (access: SubscriptionAccess, now: Date) =>
  (access.state === "ACTIVE" || access.state === "TRIAL") && access.accessUntil !== null && access.accessUntil.getTime() - now.getTime() <= SOON_DAYS * DAY_MS;

/** Indicateurs du cahier §12.1, calculés avec les mêmes règles que les droits. */
export async function getSubscriptionDashboard(now = new Date()) {
  const twelveMonthsAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  const [organizations, subscriptions, paymentGroups, revenueRows] = await Promise.all([
    prisma.organisation.count(),
    prisma.abonnement.findMany({ select: ACCESS_FIELDS }),
    prisma.paiementAbonnement.groupBy({ by: ["statut"], _count: { _all: true } }),
    prisma.$queryRaw<{ month: string; amount: number; count: number }[]>`
      SELECT to_char(date_trunc('month', "payeLe"), 'YYYY-MM') AS "month",
             COALESCE(SUM(COALESCE("montantRecu", "montant")), 0)::float AS "amount",
             COUNT(*)::int AS "count"
      FROM "PaiementAbonnement"
      WHERE "statut" = 'SUCCEEDED' AND "payeLe" >= ${twelveMonthsAgo}
      GROUP BY 1 ORDER BY 1
    `,
  ]);

  const states = { TRIAL: 0, ACTIVE: 0, GRACE: 0, READ_ONLY: 0 };
  const readOnly = { TRIAL_ENDED: 0, EXPIRED: 0, SUSPENDED: 0, CANCELLED: 0 };
  const plans: Record<string, number> = Object.fromEntries([...PLAN_CODES, "LEGACY"].map((code) => [code, 0]));
  let soon = 0;
  for (const subscription of subscriptions) {
    const access = accessFromSubscription(subscription, now);
    if (access.state === "UNMANAGED") continue;
    states[access.state] += 1;
    if (access.reason) readOnly[access.reason] += 1;
    if (access.state === "ACTIVE" || access.state === "GRACE") {
      const { plan, legacy } = resolvePlan(access.plan);
      plans[legacy ? "LEGACY" : plan.code] += 1;
    }
    if (expiringSoon(access, now)) soon += 1;
  }

  const byMonth = new Map(revenueRows.map((row) => [row.month, row]));
  const revenue = Array.from({ length: 12 }, (_, index) => {
    const date = new Date(Date.UTC(twelveMonthsAgo.getUTCFullYear(), twelveMonthsAgo.getUTCMonth() + index, 1));
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    return { month: key, amount: byMonth.get(key)?.amount ?? 0, count: byMonth.get(key)?.count ?? 0 };
  });
  const payments = Object.fromEntries(paymentGroups.map((group) => [group.statut, group._count._all])) as Partial<Record<SubscriptionPaymentStatus, number>>;

  return {
    organizations,
    unmanaged: organizations - subscriptions.length,
    states,
    readOnly,
    paidByPlan: plans,
    expiringSoon: soon,
    payments: {
      confirmed: payments.SUCCEEDED ?? 0,
      pending: payments.PENDING ?? 0,
      underReview: payments.UNDER_REVIEW ?? 0,
      failed: (payments.FAILED ?? 0) + (payments.CANCELLED ?? 0),
    },
    revenue,
    revenueThisMonth: revenue[revenue.length - 1]?.amount ?? 0,
    revenueTwelveMonths: revenue.reduce((sum, item) => sum + item.amount, 0),
  };
}

/**
 * Organisations et leur abonnement, filtrables par état et par forfait.
 * L'état est calculé en mémoire avec les règles des droits (même source de
 * vérité que l'application) ; adapté à quelques milliers d'organisations.
 */
export async function listSubscriptions(filters: { search?: string; state?: AdminStateFilter; plan?: string; page: number; limit: number }, now = new Date()) {
  const organizations = await prisma.organisation.findMany({
    where: filters.search ? { nom: containsText(filters.search) } : {},
    orderBy: { nom: "asc" },
    select: {
      id: true,
      nom: true,
      pays: true,
      actif: true,
      creeLe: true,
      abonnement: { select: { ...ACCESS_FIELDS, motifSuspension: true } },
      membres: { where: { role: Role.OWNER }, take: 1, select: { utilisateur: { select: { prenom: true, nom: true, email: true, telephone: true } } } },
      _count: { select: { boutiques: true, membres: true } },
    },
  });

  const rows = organizations.map((organization) => {
    const access = accessFromSubscription(organization.abonnement, now);
    const entitlements = entitlementsFromAccess(access);
    return {
      id: organization.id,
      nom: organization.nom,
      pays: organization.pays,
      actif: organization.actif,
      creeLe: organization.creeLe,
      owner: organization.membres[0]?.utilisateur ?? null,
      access,
      planName: access.state === "UNMANAGED" ? null : planName(access.plan),
      stores: { used: organization._count.boutiques, limit: entitlements.limits.stores },
      users: { used: organization._count.membres, limit: entitlements.limits.users },
      suspensionReason: organization.abonnement?.motifSuspension ?? null,
    };
  });

  const filtered = rows.filter((row) => {
    if (filters.plan && (row.access.state === "UNMANAGED" || resolvePlan(row.access.plan).plan.code !== filters.plan)) return false;
    switch (filters.state) {
      case undefined:
        return true;
      case "SUSPENDED":
        return row.access.reason === "SUSPENDED";
      case "EXPIRING":
        return expiringSoon(row.access, now);
      default:
        return row.access.state === filters.state;
    }
  });
  // Les échéances les plus proches d'abord ; les organisations non soumises à la fin.
  filtered.sort((a, b) => (a.access.accessUntil?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.access.accessUntil?.getTime() ?? Number.MAX_SAFE_INTEGER));
  const start = (filters.page - 1) * filters.limit;
  return { items: filtered.slice(start, start + filters.limit), total: filtered.length };
}

/** Volet abonnement de la fiche d'une organisation (administration). */
export async function getOrganizationBilling(organizationId: number) {
  const [organization, subscription] = await Promise.all([
    prisma.organisation.findUnique({ where: { id: organizationId }, select: { id: true, pays: true } }),
    prisma.abonnement.findUnique({ where: { organisationId: organizationId } }),
  ]);
  if (!organization) return null;
  const [usage, history, payments, receipts, interventions] = await Promise.all([
    getUsage(organizationId),
    prisma.historiqueAbonnement.findMany({
      where: { organisationId: organizationId },
      orderBy: { id: "desc" },
      take: 50,
      select: {
        id: true,
        action: true,
        ancienForfait: true,
        nouveauForfait: true,
        ancienStatut: true,
        nouveauStatut: true,
        anciennePeriodeFin: true,
        nouvellePeriodeFin: true,
        motif: true,
        creeLe: true,
        effectuePar: { select: { prenom: true, nom: true, superAdmin: true } },
      },
    }),
    listPayments(organizationId),
    listReceipts(organizationId),
    listAdminAudit({ organizationId, limit: 50 }),
  ]);
  return {
    pays: organization.pays,
    access: accessFromSubscription(subscription),
    subscription: subscription
      ? {
          plan: subscription.plan,
          planName: planName(subscription.plan),
          statut: subscription.statut,
          periodeDebut: subscription.periodeDebut,
          periodeFin: subscription.periodeFin,
          essaiDebutLe: subscription.essaiDebutLe,
          essaiFinLe: subscription.essaiFinLe,
          scheduledPlan: subscription.forfaitProgramme,
          scheduledAt: subscription.forfaitProgrammeLe,
          suspenduLe: subscription.suspenduLe,
          motifSuspension: subscription.motifSuspension,
        }
      : null,
    usage,
    history,
    payments,
    receipts,
    interventions: interventions.items,
  };
}

// ---------------------------------------------------------------------------
// Journal d'audit
// ---------------------------------------------------------------------------

export async function listAdminAudit(filters: { organizationId?: number; action?: string; before?: number; limit?: number }) {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const entries = await prisma.journalAdministration.findMany({
    where: {
      ...(filters.organizationId ? { organisationId: filters.organizationId } : {}),
      ...(filters.action ? { action: { startsWith: filters.action } } : {}),
      ...(filters.before ? { id: { lt: filters.before } } : {}),
    },
    orderBy: { id: "desc" },
    take: limit + 1,
    select: {
      id: true,
      action: true,
      entite: true,
      entiteId: true,
      ancienneValeur: true,
      nouvelleValeur: true,
      motif: true,
      creeLe: true,
      admin: { select: { id: true, prenom: true, nom: true } },
      organisation: { select: { id: true, nom: true } },
    },
  });
  return { items: entries.slice(0, limit), nextBefore: entries.length > limit ? entries[limit - 1].id : null };
}

// ---------------------------------------------------------------------------
// Transactions : liste filtrée et incohérences
// ---------------------------------------------------------------------------

export type AdminPaymentFilters = {
  status?: SubscriptionPaymentStatus;
  organizationId?: number;
  plan?: string;
  from?: Date;
  to?: Date;
  search?: string;
  page: number;
  limit: number;
};

const ADMIN_PAYMENT_SELECT = {
  id: true,
  referenceInterne: true,
  referenceExterne: true,
  fournisseur: true,
  statut: true,
  typeAchat: true,
  forfait: true,
  dureeMois: true,
  montant: true,
  montantRecu: true,
  devise: true,
  moyenPaiement: true,
  periodeDebut: true,
  periodeFin: true,
  paiementRecuLe: true,
  payeLe: true,
  motif: true,
  creeLe: true,
  organisation: { select: { id: true, nom: true } },
  recu: { select: { id: true, numero: true } },
} as const;

const serialize = <T extends { montant: Prisma.Decimal; montantRecu: Prisma.Decimal | null; forfait: string | null }>(payment: T) => ({
  ...payment,
  montant: Number(payment.montant),
  montantRecu: payment.montantRecu === null ? null : Number(payment.montantRecu),
  forfaitNom: planName(payment.forfait),
});

export async function listAdminPayments(filters: AdminPaymentFilters) {
  const where: Prisma.PaiementAbonnementWhereInput = {
    ...(filters.status ? { statut: filters.status } : {}),
    ...(filters.organizationId ? { organisationId: filters.organizationId } : {}),
    ...(filters.plan ? { forfait: filters.plan } : {}),
    ...(filters.from || filters.to ? { creeLe: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lt: filters.to } : {}) } } : {}),
    ...(filters.search
      ? {
          OR: [
            { referenceInterne: containsText(filters.search) },
            { referenceExterne: containsText(filters.search) },
            { organisation: { nom: containsText(filters.search) } },
          ],
        }
      : {}),
  };
  const [items, total, sums] = await Promise.all([
    prisma.paiementAbonnement.findMany({ where, orderBy: { id: "desc" }, skip: (filters.page - 1) * filters.limit, take: filters.limit, select: ADMIN_PAYMENT_SELECT }),
    prisma.paiementAbonnement.count({ where }),
    prisma.paiementAbonnement.aggregate({ where: { ...where, statut: SubscriptionPaymentStatus.SUCCEEDED }, _sum: { montantRecu: true } }),
  ]);
  return { items: items.map(serialize), total, confirmedAmount: Number(sums._sum.montantRecu ?? 0) };
}

export async function getAdminPayment(paymentId: number) {
  const payment = await prisma.paiementAbonnement.findUnique({
    where: { id: paymentId },
    select: {
      ...ADMIN_PAYMENT_SELECT,
      recu: true,
      evenements: {
        orderBy: { id: "asc" },
        select: { id: true, type: true, statutTraitement: true, erreur: true, donnees: true, creeLe: true, effectuePar: { select: { prenom: true, nom: true } } },
      },
    },
  });
  if (!payment) throw Errors.notFound("Transaction introuvable");
  const { recu, ...rest } = payment;
  return {
    ...serialize(rest),
    recu: recu ? { ...recu, montant: Number(recu.montant), forfaitNom: planName(recu.forfait) } : null,
  };
}

/**
 * Incohérences de paiement à traiter (cahier §12.4) :
 * - paiements en vérification (montant, devise, abonnement suspendu…) ;
 * - argent reçu mais abonnement non activé ;
 * - paiement confirmé sans reçu ;
 * - montant reçu inférieur au montant dû sur un paiement confirmé ;
 * - transactions en attente depuis plus de 48 h ;
 * - notifications de prestataire rejetées (signature) sur 7 jours.
 */
export async function getPaymentAnomalies(now = new Date()) {
  const stale = new Date(now.getTime() - 2 * DAY_MS);
  const week = new Date(now.getTime() - 7 * DAY_MS);
  const [underReview, receivedNotActivated, withoutReceipt, shortPaid, stalePending, rejectedNotifications] = await Promise.all([
    prisma.paiementAbonnement.findMany({ where: { statut: SubscriptionPaymentStatus.UNDER_REVIEW }, orderBy: { id: "desc" }, take: 50, select: ADMIN_PAYMENT_SELECT }),
    prisma.paiementAbonnement.findMany({ where: { statut: SubscriptionPaymentStatus.PENDING, paiementRecuLe: { not: null } }, orderBy: { id: "desc" }, take: 50, select: ADMIN_PAYMENT_SELECT }),
    prisma.paiementAbonnement.findMany({
      where: { statut: SubscriptionPaymentStatus.SUCCEEDED, referenceInterne: { not: null }, recu: { is: null } },
      orderBy: { id: "desc" },
      take: 50,
      select: ADMIN_PAYMENT_SELECT,
    }),
    prisma.$queryRaw<{ id: number }[]>`
      SELECT "id" FROM "PaiementAbonnement"
      WHERE "statut" = 'SUCCEEDED' AND "montantRecu" IS NOT NULL AND "montantRecu" < "montant"
      ORDER BY "id" DESC LIMIT 50
    `,
    prisma.paiementAbonnement.count({ where: { statut: SubscriptionPaymentStatus.PENDING, paiementRecuLe: null, creeLe: { lt: stale } } }),
    prisma.evenementPaiement.count({ where: { statutTraitement: "REJECTED", creeLe: { gte: week } } }),
  ]);
  const shortPaidRows = shortPaid.length
    ? await prisma.paiementAbonnement.findMany({ where: { id: { in: shortPaid.map((row) => row.id) } }, orderBy: { id: "desc" }, select: ADMIN_PAYMENT_SELECT })
    : [];
  return {
    underReview: underReview.map(serialize),
    receivedNotActivated: receivedNotActivated.map(serialize),
    withoutReceipt: withoutReceipt.map(serialize),
    shortPaid: shortPaidRows.map(serialize),
    stalePending,
    rejectedNotifications,
  };
}

export async function listAdminReceipts(filters: { organizationId?: number; page: number; limit: number }) {
  const where = filters.organizationId ? { organisationId: filters.organizationId } : {};
  const [items, total] = await Promise.all([
    prisma.recuAbonnement.findMany({ where, orderBy: { id: "desc" }, skip: (filters.page - 1) * filters.limit, take: filters.limit }),
    prisma.recuAbonnement.count({ where }),
  ]);
  return { items: items.map((receipt) => ({ ...receipt, montant: Number(receipt.montant), forfaitNom: planName(receipt.forfait) })), total };
}
