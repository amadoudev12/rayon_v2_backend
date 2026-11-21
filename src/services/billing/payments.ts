import { randomInt } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { SubscriptionPaymentStatus } from "@/generated/prisma/enums";
import { ApiError, Errors } from "@/lib/api/errors";
import type { AuthContext } from "@/lib/auth/session";
import { formatDateFr, formatXof } from "@/lib/format-fr";
import { lockOrganization } from "@/lib/locks";
import { log } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { runTransaction, type Tx } from "@/lib/transactions";
import { notifyOwner } from "@/services/notifications";
import { recordAdminAudit } from "./audit";
import { applyConfirmedPurchase, planName } from "@/services/subscription";
import { isDuration, isPlanCode, SUBSCRIPTION_CURRENCY } from "./plans";
import { checkoutProviderId, findProvider, MANUAL_PROVIDER } from "./provider";
import { quotePurchase, DAY_MS, type PurchaseRequest, type Quote } from "./rules";

/**
 * PaymentService — transactions de paiement d'abonnement, de la création à
 * l'activation, et InvoiceService (reçus).
 *
 * Parcours : le serveur calcule le montant et crée une transaction PENDING
 * (référence interne unique) ; le paiement est ensuite CONFIRMÉ (par
 * l'administration pour un Mobile Money hors ligne, ou par le prestataire
 * après vérification) ; l'ACTIVATION applique l'achat à l'abonnement, émet le
 * reçu et notifie le propriétaire, dans une seule transaction de base.
 *
 * Confirmation et activation sont deux étapes : si l'activation échoue pour
 * une raison technique, le paiement reste « reçu, non activé » et le
 * rapprochement la rejoue. Une activation déjà faite n'est jamais refaite
 * (ligne verrouillée, statut SUCCEEDED, reçu unique par paiement).
 */

export const PAYMENT_METHODS = ["WAVE", "ORANGE_MONEY", "MTN_MOMO", "MOOV_MONEY", "FREE_MONEY", "CARTE", "VIREMENT", "ESPECES", "AUTRE"] as const;
export type PaymentMethodCode = (typeof PAYMENT_METHODS)[number];

/** Une transaction non payée est abandonnée après ce délai. */
export const PENDING_EXPIRY_DAYS = 7;

type PaymentRow = Prisma.PaiementAbonnementGetPayload<object>;

const REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sans 0/O ni 1/I

/** Référence interne : courte (à saisir dans un transfert Mobile Money), non devinable. */
export function newInternalReference(): string {
  let code = "";
  for (let i = 0; i < 10; i += 1) code += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  return `RAY-${code}`;
}

export function requestFromPayment(payment: Pick<PaymentRow, "typeAchat" | "forfait" | "dureeMois">): PurchaseRequest {
  if (!isPlanCode(payment.forfait)) throw Errors.conflict("Transaction sans forfait valide.");
  if (payment.typeAchat === "UPGRADE") return { type: "UPGRADE", plan: payment.forfait };
  if (payment.typeAchat === "PERIOD" && isDuration(payment.dureeMois)) return { type: "PERIOD", plan: payment.forfait, months: payment.dureeMois };
  throw Errors.conflict("Transaction sans achat valide.");
}

async function recordEvent(
  client: Tx | typeof prisma,
  input: { paymentId: number | null; provider: string; type: string; status: string; data?: Prisma.InputJsonValue; error?: string | null; performedBy?: number | null; eventId?: string | null },
) {
  return client.evenementPaiement.create({
    data: {
      paiementId: input.paymentId,
      fournisseur: input.provider,
      identifiantEvenement: input.eventId ?? null,
      type: input.type,
      statutTraitement: input.status,
      donnees: input.data,
      erreur: input.error ?? null,
      effectueParId: input.performedBy ?? null,
    },
  });
}

export const paymentEvents = { record: recordEvent };

export function manualInstructions(reference: string, amount: number): string {
  const configured = process.env.SUBSCRIPTION_MANUAL_PAYMENT_INSTRUCTIONS?.trim();
  const base = configured || "Effectuez votre paiement Mobile Money auprès de l'équipe Rayon.";
  return `${base} Montant : ${formatXof(amount)}. Référence à indiquer : ${reference}. Votre abonnement sera activé dès la confirmation du paiement.`;
}

// ---------------------------------------------------------------------------
// Création (client : propriétaire de l'organisation)
// ---------------------------------------------------------------------------

const samePurchase = (payment: PaymentRow, request: PurchaseRequest, quote: Quote) =>
  payment.typeAchat === request.type &&
  payment.forfait === request.plan &&
  (payment.dureeMois ?? null) === (request.type === "PERIOD" ? request.months : null) &&
  Number(payment.montant) === quote.amount;

/**
 * Crée la transaction d'un achat : le montant est calculé ici, jamais reçu du
 * client. Une seule transaction en attente par organisation : redemander le
 * même achat renvoie la même transaction (pas de doublon) ; un autre achat
 * remplace l'ancienne demande non payée.
 */
export async function createPayment(context: AuthContext, request: PurchaseRequest, now = new Date()) {
  const providerId = checkoutProviderId();
  const provider = providerId === MANUAL_PROVIDER ? null : findProvider(providerId);
  if (providerId !== MANUAL_PROVIDER && !provider) {
    log("error", "billing.provider_missing", { provider: providerId });
    throw new ApiError(503, "Le paiement en ligne est momentanément indisponible. Réessayez plus tard.", undefined, "PAYMENT_PROVIDER_UNAVAILABLE");
  }

  const { payment, created } = await runTransaction(async (tx) => {
    await lockOrganization(tx, context.organizationId);
    const subscription = await tx.abonnement.findUnique({ where: { organisationId: context.organizationId } });
    const quote = quotePurchase(subscription, request, now);
    if (quote.amount <= 0) throw Errors.conflict("Aucun montant à payer pour cet achat.");

    const pending = await tx.paiementAbonnement.findFirst({
      where: { organisationId: context.organizationId, statut: SubscriptionPaymentStatus.PENDING, paiementRecuLe: null },
      orderBy: { id: "desc" },
    });
    if (pending && samePurchase(pending, request, quote) && pending.fournisseur === providerId) return { payment: pending, created: false };
    if (pending) {
      await tx.paiementAbonnement.update({ where: { id: pending.id }, data: { statut: SubscriptionPaymentStatus.CANCELLED, motif: "Remplacée par une nouvelle demande." } });
      await recordEvent(tx, { paymentId: pending.id, provider: pending.fournisseur, type: "CANCELLED", status: "PROCESSED", data: { reason: "replaced" }, performedBy: context.userId });
    }

    const createdPayment = await tx.paiementAbonnement.create({
      data: {
        organisationId: context.organizationId,
        abonnementId: subscription?.id ?? null,
        fournisseur: providerId,
        referenceInterne: newInternalReference(),
        typeAchat: request.type,
        forfait: request.plan,
        dureeMois: request.type === "PERIOD" ? request.months : null,
        montant: new Prisma.Decimal(quote.amount),
        devise: SUBSCRIPTION_CURRENCY,
        periodeDebut: quote.periodStart,
        periodeFin: quote.periodEnd,
        creeParId: context.userId,
        metadonnees: { kind: quote.kind, previousPlan: quote.previousPlan, remainingDays: quote.remainingDays },
      },
    });
    await recordEvent(tx, {
      paymentId: createdPayment.id,
      provider: providerId,
      type: "CREATED",
      status: "PROCESSED",
      data: { amount: quote.amount, kind: quote.kind, plan: request.plan },
      performedBy: context.userId,
    });
    return { payment: createdPayment, created: true };
  });

  if (!provider) return { payment, created, instructions: manualInstructions(payment.referenceInterne!, Number(payment.montant)), redirectUrl: null };

  // Prestataire en ligne : la demande de paiement est créée hors transaction (appel réseau).
  const known = payment.metadonnees as { redirectUrl?: string } | null;
  if (!created && known?.redirectUrl) return { payment, created, instructions: null, redirectUrl: known.redirectUrl };
  try {
    const checkout = await provider.createCheckout({
      internalReference: payment.referenceInterne!,
      amount: Number(payment.montant),
      currency: payment.devise,
      description: `Abonnement Rayon ${planName(payment.forfait)}${payment.dureeMois ? ` — ${payment.dureeMois} mois` : " — mise à niveau"}`,
      organizationId: context.organizationId,
    });
    const updated = await prisma.paiementAbonnement.update({
      where: { id: payment.id },
      data: {
        referenceExterne: checkout.providerReference ?? undefined,
        metadonnees: { ...((payment.metadonnees as object | null) ?? {}), redirectUrl: checkout.redirectUrl ?? null },
      },
    });
    await recordEvent(prisma, { paymentId: payment.id, provider: provider.id, type: "CHECKOUT_CREATED", status: "PROCESSED", data: { providerReference: checkout.providerReference } });
    return { payment: updated, created, instructions: checkout.instructions ?? null, redirectUrl: checkout.redirectUrl ?? null };
  } catch (error) {
    // Message du prestataire jamais renvoyé au client (il peut contenir des détails sensibles).
    log("error", "billing.checkout_failed", { paymentId: payment.id, provider: provider.id, error: error instanceof Error ? error.name : "unknown" });
    await prisma.paiementAbonnement.update({ where: { id: payment.id }, data: { statut: SubscriptionPaymentStatus.FAILED, motif: "Initialisation du paiement impossible." } });
    await recordEvent(prisma, { paymentId: payment.id, provider: provider.id, type: "CHECKOUT_FAILED", status: "FAILED", error: "checkout_failed" });
    throw new ApiError(502, "Le paiement n'a pas pu être initialisé. Réessayez dans quelques instants.", undefined, "PAYMENT_INIT_FAILED");
  }
}

/** Le propriétaire abandonne une transaction non payée. */
export async function cancelPayment(context: AuthContext, paymentId: number) {
  return runTransaction(async (tx) => {
    const payment = await lockPayment(tx, paymentId);
    if (!payment || payment.organisationId !== context.organizationId) throw Errors.notFound("Transaction introuvable");
    if (payment.statut !== SubscriptionPaymentStatus.PENDING || payment.paiementRecuLe) {
      throw Errors.conflict("Seule une transaction en attente de paiement peut être annulée.");
    }
    const updated = await tx.paiementAbonnement.update({ where: { id: payment.id }, data: { statut: SubscriptionPaymentStatus.CANCELLED, motif: "Annulée par le client." } });
    await recordEvent(tx, { paymentId: payment.id, provider: payment.fournisseur, type: "CANCELLED", status: "PROCESSED", data: { reason: "customer" }, performedBy: context.userId });
    return updated;
  });
}

async function lockPayment(tx: Tx, paymentId: number) {
  await tx.$queryRaw`SELECT "id" FROM "PaiementAbonnement" WHERE "id" = ${paymentId} FOR UPDATE`;
  return tx.paiementAbonnement.findUnique({ where: { id: paymentId } });
}

// ---------------------------------------------------------------------------
// Confirmation (argent reçu) puis activation
// ---------------------------------------------------------------------------

export type Confirmation = {
  amount: number;
  currency?: string | null;
  method?: string | null;
  providerReference?: string | null;
  /** Date de confirmation effective du paiement (début de période après la grâce). */
  receivedAt: Date;
  source: "ADMIN" | "PROVIDER" | "RECONCILIATION";
  performedBy: number | null;
  eventId?: string | null;
};

export type ActivationResult =
  | { status: "SUCCEEDED"; replay: boolean; paymentId: number; receiptId: number }
  | { status: "UNDER_REVIEW"; paymentId: number; reason: string; code: string }
  | { status: "IGNORED"; paymentId: number; reason: string };

/** Enregistre la réception de l'argent (étape 1). Idempotent. */
async function recordConfirmation(paymentId: number, confirmation: Confirmation): Promise<PaymentRow> {
  return runTransaction(async (tx) => {
    const payment = await lockPayment(tx, paymentId);
    if (!payment) throw Errors.notFound("Transaction introuvable");
    if (payment.paiementRecuLe) {
      const sameAmount = payment.montantRecu !== null && Number(payment.montantRecu) === confirmation.amount;
      if (!sameAmount) {
        log("warn", "billing.confirmation_mismatch", { paymentId, source: confirmation.source });
      }
      return payment; // déjà confirmé : jamais compté deux fois
    }
    const updated = await tx.paiementAbonnement.update({
      where: { id: payment.id },
      data: {
        montantRecu: new Prisma.Decimal(confirmation.amount),
        paiementRecuLe: confirmation.receivedAt,
        moyenPaiement: confirmation.method ?? payment.moyenPaiement,
        referenceExterne: confirmation.providerReference ?? payment.referenceExterne,
      },
    });
    await recordEvent(tx, {
      paymentId: payment.id,
      provider: payment.fournisseur,
      type: "PAYMENT_RECEIVED",
      status: "PROCESSED",
      data: { amount: confirmation.amount, currency: confirmation.currency ?? null, method: confirmation.method ?? null, source: confirmation.source },
      performedBy: confirmation.performedBy,
    });
    return updated;
  });
}

export async function markUnderReview(paymentId: number, reason: string, code: string, performedBy: number | null, source: string) {
  await runTransaction(async (tx) => {
    const payment = await lockPayment(tx, paymentId);
    if (!payment || payment.statut === SubscriptionPaymentStatus.SUCCEEDED) return;
    await tx.paiementAbonnement.update({ where: { id: paymentId }, data: { statut: SubscriptionPaymentStatus.UNDER_REVIEW, motif: reason } });
    await recordEvent(tx, { paymentId, provider: payment.fournisseur, type: "UNDER_REVIEW", status: "PROCESSED", data: { code, source }, error: reason, performedBy });
  });
  log("warn", "billing.payment_under_review", { paymentId, code });
}

async function createReceipt(tx: Tx, payment: PaymentRow, quote: Quote) {
  const organization = await tx.organisation.findUniqueOrThrow({ where: { id: payment.organisationId! }, select: { nom: true } });
  const receivedAt = payment.paiementRecuLe!;
  const receipt = await tx.recuAbonnement.create({
    data: {
      numero: `TMP-${payment.id}`,
      organisationId: payment.organisationId!,
      paiementId: payment.id,
      nomOrganisation: organization.nom,
      forfait: quote.plan,
      typeAchat: quote.kind,
      dureeMois: quote.months,
      montant: payment.montantRecu!,
      devise: payment.devise,
      moyenPaiement: payment.moyenPaiement,
      referenceTransaction: payment.referenceInterne ?? `PAIEMENT-${payment.id}`,
      referenceExterne: payment.referenceExterne,
      confirmeLe: receivedAt,
      periodeDebut: quote.periodStart,
      periodeFin: quote.periodEnd,
    },
  });
  // Numéro séquentiel lisible, dérivé de l'identifiant (unique, jamais réutilisé).
  return tx.recuAbonnement.update({
    where: { id: receipt.id },
    data: { numero: `REC-${receivedAt.getUTCFullYear()}-${String(receipt.id).padStart(6, "0")}` },
  });
}

/** Codes métier : le paiement est reçu mais ne peut pas être appliqué automatiquement. */
const REVIEW_CODES = new Set(["AMOUNT_MISMATCH", "CURRENCY_MISMATCH", "SUBSCRIPTION_SUSPENDED", "UPGRADE_NOT_APPLICABLE", "UPGRADE_NOT_HIGHER", "UPGRADE_REQUIRED", "DOWNGRADE_PENDING"]);

/**
 * Active un paiement confirmé (étape 2) : abonnement prolongé ou modifié,
 * reçu émis, propriétaire notifié — tout ou rien. Sans effet s'il est déjà
 * activé. Un refus métier met le paiement en vérification ; une erreur
 * technique est relancée (le rapprochement rejouera l'activation).
 */
export async function activatePayment(paymentId: number, options: { performedBy: number | null; source: Confirmation["source"]; allowReview?: boolean }): Promise<ActivationResult> {
  try {
    return await runTransaction(async (tx) => {
      const payment = await lockPayment(tx, paymentId);
      if (!payment) throw Errors.notFound("Transaction introuvable");
      if (payment.statut === SubscriptionPaymentStatus.SUCCEEDED) {
        const receipt = await tx.recuAbonnement.findUniqueOrThrow({ where: { paiementId: payment.id }, select: { id: true } });
        return { status: "SUCCEEDED" as const, replay: true, paymentId, receiptId: receipt.id };
      }
      if (!payment.paiementRecuLe || payment.montantRecu === null || payment.organisationId === null) {
        throw Errors.conflict("Le paiement de cette transaction n'est pas confirmé.");
      }
      const activable = payment.statut === SubscriptionPaymentStatus.PENDING || (options.allowReview && payment.statut !== SubscriptionPaymentStatus.FAILED && payment.statut !== SubscriptionPaymentStatus.REFUNDED);
      if (!activable) return { status: "IGNORED" as const, paymentId, reason: `Transaction ${payment.statut}` };
      if (payment.devise !== SUBSCRIPTION_CURRENCY) {
        throw new ApiError(409, "Devise de paiement incorrecte.", undefined, "CURRENCY_MISMATCH");
      }

      const { quote, subscription } = await applyConfirmedPurchase(tx, payment.organisationId, requestFromPayment(payment), {
        confirmedAt: payment.paiementRecuLe,
        amountPaid: Number(payment.montantRecu),
        performedBy: options.performedBy,
        metadata: { paymentId: payment.id, reference: payment.referenceInterne, source: options.source },
      });
      const receipt = await createReceipt(tx, payment, quote);
      await tx.paiementAbonnement.update({
        where: { id: payment.id },
        data: {
          statut: SubscriptionPaymentStatus.SUCCEEDED,
          payeLe: new Date(),
          abonnementId: subscription.id,
          periodeDebut: quote.periodStart,
          periodeFin: quote.periodEnd,
          motif: null,
        },
      });
      await recordEvent(tx, { paymentId: payment.id, provider: payment.fournisseur, type: "ACTIVATED", status: "PROCESSED", data: { receipt: receipt.numero, kind: quote.kind, source: options.source }, performedBy: options.performedBy });

      await notifyOwner(tx, payment.organisationId, {
        type: "PAYMENT_CONFIRMED",
        title: "Paiement confirmé",
        message: `Votre paiement de ${formatXof(Number(payment.montantRecu))} est confirmé (reçu ${receipt.numero}). Forfait ${planName(quote.plan)} actif jusqu'au ${formatDateFr(subscription.periodeFin)}.`,
        key: `payment-confirmed:${payment.id}`,
      });
      if (quote.previousPlan !== subscription.plan) {
        await notifyOwner(tx, payment.organisationId, {
          type: "PLAN_CHANGED",
          title: "Nouveau forfait",
          message: `Votre forfait est désormais ${planName(subscription.plan)}.`,
          key: `plan-changed:payment:${payment.id}`,
        });
      }
      return { status: "SUCCEEDED" as const, replay: false, paymentId, receiptId: receipt.id };
    });
  } catch (error) {
    if (error instanceof ApiError && error.code && REVIEW_CODES.has(error.code)) {
      await markUnderReview(paymentId, error.message, error.code, options.performedBy, options.source);
      return { status: "UNDER_REVIEW", paymentId, reason: error.message, code: error.code };
    }
    throw error;
  }
}

/** Confirmation PUIS activation (administration, prestataire, rapprochement). */
export async function confirmAndActivate(paymentId: number, confirmation: Confirmation, options: { allowReview?: boolean } = {}): Promise<ActivationResult> {
  const payment = await recordConfirmation(paymentId, confirmation);
  if (confirmation.currency && confirmation.currency.toUpperCase() !== payment.devise) {
    await markUnderReview(paymentId, "Devise de paiement incorrecte.", "CURRENCY_MISMATCH", confirmation.performedBy, confirmation.source);
    return { status: "UNDER_REVIEW", paymentId, reason: "Devise de paiement incorrecte.", code: "CURRENCY_MISMATCH" };
  }
  return activatePayment(paymentId, { performedBy: confirmation.performedBy, source: confirmation.source, allowReview: options.allowReview });
}

// ---------------------------------------------------------------------------
// Administration : confirmation manuelle, refus
// ---------------------------------------------------------------------------

/**
 * L'administration confirme un paiement reçu hors ligne (Mobile Money…).
 * Possible sur une transaction en attente, en vérification ou annulée
 * (paiement arrivé après abandon) : décision humaine explicite.
 */
export async function confirmPaymentByAdmin(
  adminId: number,
  paymentId: number,
  input: { amount: number; method: PaymentMethodCode; providerReference: string; receivedAt?: Date; note?: string | null },
) {
  const payment = await prisma.paiementAbonnement.findUnique({ where: { id: paymentId } });
  if (!payment) throw Errors.notFound("Transaction introuvable");
  if (payment.statut === SubscriptionPaymentStatus.FAILED || payment.statut === SubscriptionPaymentStatus.REFUNDED) {
    throw Errors.conflict("Cette transaction est close : créez une nouvelle transaction.");
  }
  const receivedAt = input.receivedAt ?? new Date();
  if (receivedAt > new Date() || receivedAt < payment.creeLe) throw Errors.conflict("Date de réception incohérente avec la transaction.");
  const result = await confirmOrRetry(adminId, payment, input, receivedAt);
  // Journal d'audit de l'administration (après l'opération, qui a ses propres transactions).
  await recordAdminAudit(prisma, {
    adminId,
    action: "payment.confirmed",
    entity: "PaiementAbonnement",
    entityId: paymentId,
    organizationId: payment.organisationId,
    before: { statut: payment.statut, montant: Number(payment.montant), montantRecu: payment.montantRecu === null ? null : Number(payment.montantRecu) },
    after: { resultat: result.status, montantRecu: input.amount, moyenPaiement: input.method, referenceExterne: input.providerReference, recuLe: receivedAt.toISOString() },
    reason: input.note ?? null,
  });
  return result;
}

async function confirmOrRetry(
  adminId: number,
  payment: PaymentRow,
  input: { amount: number; method: PaymentMethodCode; providerReference: string; note?: string | null },
  receivedAt: Date,
): Promise<ActivationResult> {
  const paymentId = payment.id;
  if (payment.statut === SubscriptionPaymentStatus.UNDER_REVIEW || payment.statut === SubscriptionPaymentStatus.CANCELLED) {
    // Nouvelle tentative après vérification : la confirmation est (re)saisie par l'administrateur.
    await prisma.paiementAbonnement.update({
      where: { id: paymentId },
      data: { montantRecu: new Prisma.Decimal(input.amount), paiementRecuLe: receivedAt, moyenPaiement: input.method, referenceExterne: input.providerReference },
    });
    await recordEvent(prisma, { paymentId, provider: payment.fournisseur, type: "ADMIN_RECONFIRMED", status: "PROCESSED", data: { amount: input.amount, method: input.method, note: input.note ?? null }, performedBy: adminId });
    return activatePayment(paymentId, { performedBy: adminId, source: "ADMIN", allowReview: true });
  }
  return confirmAndActivate(paymentId, {
    amount: input.amount,
    currency: SUBSCRIPTION_CURRENCY,
    method: input.method,
    providerReference: input.providerReference,
    receivedAt,
    source: "ADMIN",
    performedBy: adminId,
  });
}

/** Marque une transaction en échec (aucun effet sur l'abonnement). */
export async function rejectPaymentByAdmin(adminId: number, paymentId: number, reason: string) {
  return runTransaction(async (tx) => {
    const payment = await lockPayment(tx, paymentId);
    if (!payment) throw Errors.notFound("Transaction introuvable");
    if (payment.statut === SubscriptionPaymentStatus.SUCCEEDED) throw Errors.conflict("Un paiement activé ne peut pas être refusé (procédure de remboursement).");
    const updated = await tx.paiementAbonnement.update({ where: { id: paymentId }, data: { statut: SubscriptionPaymentStatus.FAILED, motif: reason } });
    await recordEvent(tx, { paymentId, provider: payment.fournisseur, type: "REJECTED", status: "PROCESSED", data: { reason }, performedBy: adminId });
    await recordAdminAudit(tx, {
      adminId,
      action: "payment.rejected",
      entity: "PaiementAbonnement",
      entityId: paymentId,
      organizationId: payment.organisationId,
      before: { statut: payment.statut },
      after: { statut: SubscriptionPaymentStatus.FAILED },
      reason,
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Rapprochement (tâche planifiée, ou à la demande de l'administration)
// ---------------------------------------------------------------------------

/**
 * - rejoue l'activation des paiements reçus mais non activés (panne
 *   technique entre confirmation et activation) ;
 * - interroge le prestataire pour les transactions en ligne restées en
 *   attente (notification manquante) ;
 * - abandonne les transactions non payées après 7 jours.
 */
export async function reconcilePayments(now = new Date()) {
  const result = { activated: 0, underReview: 0, verified: 0, expired: 0, errors: 0 };

  const received = await prisma.paiementAbonnement.findMany({
    where: { statut: SubscriptionPaymentStatus.PENDING, paiementRecuLe: { not: null } },
    select: { id: true },
    take: 200,
  });
  for (const { id } of received) {
    try {
      const outcome = await activatePayment(id, { performedBy: null, source: "RECONCILIATION" });
      if (outcome.status === "SUCCEEDED" && !outcome.replay) result.activated += 1;
      if (outcome.status === "UNDER_REVIEW") result.underReview += 1;
    } catch (error) {
      result.errors += 1;
      log("error", "billing.reconciliation_failed", { paymentId: id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const online = await prisma.paiementAbonnement.findMany({
    where: { statut: SubscriptionPaymentStatus.PENDING, paiementRecuLe: null, fournisseur: { not: MANUAL_PROVIDER }, creeLe: { lte: new Date(now.getTime() - 15 * 60_000) } },
    select: { id: true, fournisseur: true, referenceInterne: true, referenceExterne: true },
    take: 200,
  });
  for (const payment of online) {
    const provider = findProvider(payment.fournisseur);
    if (!provider || !payment.referenceInterne) continue;
    try {
      const transaction = await provider.fetchTransaction(payment.referenceInterne, payment.referenceExterne);
      result.verified += 1;
      if (transaction?.status === "SUCCEEDED" && transaction.amount !== null) {
        const outcome = await confirmAndActivate(payment.id, {
          amount: transaction.amount,
          currency: transaction.currency,
          method: transaction.method,
          providerReference: transaction.providerReference,
          receivedAt: now,
          source: "RECONCILIATION",
          performedBy: null,
        });
        if (outcome.status === "SUCCEEDED") result.activated += 1;
        if (outcome.status === "UNDER_REVIEW") result.underReview += 1;
      } else if (transaction?.status === "FAILED" || transaction?.status === "CANCELLED") {
        await closeUnpaid(payment.id, transaction.status === "FAILED" ? SubscriptionPaymentStatus.FAILED : SubscriptionPaymentStatus.CANCELLED, "Paiement non abouti chez le prestataire.", "RECONCILIATION");
      }
    } catch (error) {
      result.errors += 1;
      log("error", "billing.provider_check_failed", { paymentId: payment.id, error: error instanceof Error ? error.name : "unknown" });
    }
  }

  const stale = await prisma.paiementAbonnement.findMany({
    where: { statut: SubscriptionPaymentStatus.PENDING, paiementRecuLe: null, creeLe: { lte: new Date(now.getTime() - PENDING_EXPIRY_DAYS * DAY_MS) } },
    select: { id: true },
    take: 500,
  });
  for (const { id } of stale) {
    if (await closeUnpaid(id, SubscriptionPaymentStatus.CANCELLED, `Expirée sans paiement après ${PENDING_EXPIRY_DAYS} jours.`, "RECONCILIATION")) result.expired += 1;
  }
  return result;
}

/** Clôt une transaction NON payée (échec, abandon). Sans effet si l'argent a été reçu. */
export async function closeUnpaid(paymentId: number, status: "FAILED" | "CANCELLED", reason: string, source: string) {
  return runTransaction(async (tx) => {
    const payment = await lockPayment(tx, paymentId);
    if (!payment || payment.statut !== SubscriptionPaymentStatus.PENDING || payment.paiementRecuLe) return false;
    await tx.paiementAbonnement.update({ where: { id: paymentId }, data: { statut: status, motif: reason } });
    await recordEvent(tx, { paymentId, provider: payment.fournisseur, type: status, status: "PROCESSED", data: { source }, error: reason });
    return true;
  });
}

// ---------------------------------------------------------------------------
// Consultation
// ---------------------------------------------------------------------------

const PAYMENT_SELECT = {
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
  recu: { select: { id: true, numero: true } },
} as const;

export function serializePayment<T extends { montant: Prisma.Decimal; montantRecu: Prisma.Decimal | null; forfait: string | null }>(payment: T) {
  return { ...payment, montant: Number(payment.montant), montantRecu: payment.montantRecu === null ? null : Number(payment.montantRecu), forfaitNom: planName(payment.forfait) };
}

export async function listPayments(organizationId: number) {
  const payments = await prisma.paiementAbonnement.findMany({ where: { organisationId: organizationId }, orderBy: { id: "desc" }, take: 100, select: PAYMENT_SELECT });
  return payments.map(serializePayment);
}

export async function getPayment(organizationId: number, paymentId: number) {
  const payment = await prisma.paiementAbonnement.findFirst({ where: { id: paymentId, organisationId: organizationId }, select: PAYMENT_SELECT });
  if (!payment) throw Errors.notFound("Transaction introuvable");
  return serializePayment(payment);
}

const serializeReceipt = <T extends { montant: Prisma.Decimal; forfait: string }>(receipt: T) => ({ ...receipt, montant: Number(receipt.montant), forfaitNom: planName(receipt.forfait) });

export async function listReceipts(organizationId: number) {
  const receipts = await prisma.recuAbonnement.findMany({ where: { organisationId: organizationId }, orderBy: { id: "desc" }, take: 100 });
  return receipts.map(serializeReceipt);
}

export async function getReceipt(organizationId: number, receiptId: number) {
  const receipt = await prisma.recuAbonnement.findFirst({ where: { id: receiptId, organisationId: organizationId } });
  if (!receipt) throw Errors.notFound("Reçu introuvable");
  return serializeReceipt(receipt);
}
