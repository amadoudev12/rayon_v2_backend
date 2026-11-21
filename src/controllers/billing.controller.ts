import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { jsonData, routeId } from "@/lib/api/response";
import { can } from "@/lib/auth/permissions";
import { getUsage } from "@/services/billing/entitlements";
import { cancelPayment, createPayment, getPayment, getReceipt, listPayments, listReceipts, manualInstructions, serializePayment } from "@/services/billing/payments";
import { checkoutProviderId, MANUAL_PROVIDER } from "@/services/billing/provider";
import { PLAN_CODES, publicCatalog } from "@/services/billing/plans";
import { parsePurchaseRequest, type Quote } from "@/services/billing/rules";
import {
  accessFromSubscription,
  cancelScheduledDowngrade,
  planName,
  quoteForOrganization,
  scheduleDowngradeForOrganization,
  subscriptionsEnforced,
} from "@/services/subscription";

/**
 * Abonnement vu par l'organisation (`/api/subscription`). Ces routes restent
 * ouvertes en lecture seule : le client doit toujours pouvoir consulter son
 * abonnement et le renouveler. Les montants viennent exclusivement du serveur.
 */

async function overview(organizationId: number, canManage: boolean) {
  const subscription = await prisma.abonnement.findUnique({ where: { organisationId: organizationId } });
  return {
    enforced: subscriptionsEnforced(),
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
          trialConsumed: subscription.essaiDebutLe !== null,
          scheduledPlan: subscription.forfaitProgramme,
          scheduledAt: subscription.forfaitProgrammeLe,
        }
      : null,
    usage: await getUsage(organizationId),
    catalog: publicCatalog(),
    canManage,
  };
}

const serializeQuote = (quote: Quote) => ({ ...quote, planName: planName(quote.plan), previousPlanName: planName(quote.previousPlan) });

export async function getSubscription(req: Request, res: Response) {
  return jsonData(res, await overview(req.user.organizationId, can(req.user.role, "subscription:manage")));
}

export async function getSubscriptionHistory(req: Request, res: Response) {
  const entries = await prisma.historiqueAbonnement.findMany({
    where: { organisationId: req.user.organizationId },
    orderBy: { id: "desc" },
    take: 100,
    select: {
      id: true,
      action: true,
      ancienForfait: true,
      nouveauForfait: true,
      ancienStatut: true,
      nouveauStatut: true,
      anciennePeriodeFin: true,
      nouvellePeriodeFin: true,
      creeLe: true,
    },
  });
  return jsonData(res, entries);
}

const quoteSchema = z.object({
  type: z.enum(["PERIOD", "UPGRADE"]),
  plan: z.enum(PLAN_CODES),
  months: z.coerce.number().int().optional(),
});

/** Devis calculé par le serveur (montant, période couverte) avant le paiement. */
export async function postQuote(req: Request, res: Response) {
  const request = parsePurchaseRequest(quoteSchema.parse(req.body));
  return jsonData(res, serializeQuote(await quoteForOrganization(req.user.organizationId, request)));
}

const scheduleSchema = z.object({ plan: z.enum(PLAN_CODES) });

/** Rétrogradation : programmée à l'échéance, sans remboursement ni suppression de données. */
export async function postScheduledChange(req: Request, res: Response) {
  const { plan } = scheduleSchema.parse(req.body);
  await scheduleDowngradeForOrganization(req.user.organizationId, plan, req.user.userId);
  return jsonData(res, await overview(req.user.organizationId, true));
}

export async function deleteScheduledChange(req: Request, res: Response) {
  await cancelScheduledDowngrade(req.user.organizationId, req.user.userId);
  return jsonData(res, await overview(req.user.organizationId, true));
}

// ---------------------------------------------------------------------------
// Paiements et reçus (propriétaire)
// ---------------------------------------------------------------------------

/**
 * Démarre le paiement d'un achat : le serveur calcule le montant et crée la
 * transaction. Le retour du navigateur n'est jamais une preuve de paiement :
 * l'abonnement ne change qu'à la confirmation (administration ou prestataire).
 */
export async function postPayment(req: Request, res: Response) {
  const request = parsePurchaseRequest(quoteSchema.parse(req.body));
  const result = await createPayment(req.user, request);
  return jsonData(
    res,
    { payment: serializePayment(result.payment), instructions: result.instructions, redirectUrl: result.redirectUrl },
    { status: result.created ? 201 : 200 },
  );
}

export async function getPayments(req: Request, res: Response) {
  return jsonData(res, await listPayments(req.user.organizationId));
}

export async function getPaymentById(req: Request, res: Response) {
  return jsonData(res, await getPayment(req.user.organizationId, routeId(req)));
}

export async function postCancelPayment(req: Request, res: Response) {
  const payment = await cancelPayment(req.user, routeId(req));
  return jsonData(res, serializePayment(payment));
}

export async function getReceipts(req: Request, res: Response) {
  return jsonData(res, await listReceipts(req.user.organizationId));
}

export async function getReceiptById(req: Request, res: Response) {
  return jsonData(res, await getReceipt(req.user.organizationId, routeId(req)));
}

// ---------------------------------------------------------------------------
// Page « Abonnement » du site (`/api/pages/abonnement`)
// ---------------------------------------------------------------------------

async function subscriptionHistory(organizationId: number) {
  return prisma.historiqueAbonnement.findMany({
    where: { organisationId: organizationId },
    orderBy: { id: "desc" },
    take: 100,
    select: { id: true, action: true, ancienForfait: true, nouveauForfait: true, ancienStatut: true, nouveauStatut: true, anciennePeriodeFin: true, nouvellePeriodeFin: true, creeLe: true },
  });
}

/**
 * Tout ce que la page Abonnement affiche, en une lecture. Les membres voient
 * l'état et les forfaits ; le propriétaire voit aussi paiements, reçus et
 * historique. Accessible en lecture seule.
 */
export async function getSubscriptionPage(req: Request, res: Response) {
  const context = req.user;
  const canManage = can(context.role, "subscription:manage");
  const [base, organization] = await Promise.all([
    overview(context.organizationId, canManage),
    prisma.organisation.findUniqueOrThrow({ where: { id: context.organizationId }, select: { nom: true } }),
  ]);
  const owned = canManage
    ? await Promise.all([listPayments(context.organizationId), listReceipts(context.organizationId), subscriptionHistory(context.organizationId)])
    : null;
  // Transaction en attente de paiement : rappel des instructions (paiement hors ligne).
  const pending = owned?.[0].find((payment) => payment.statut === "PENDING" && payment.paiementRecuLe === null) ?? null;
  return jsonData(res, {
    ...base,
    organizationName: organization.nom,
    pendingInstructions:
      pending && pending.fournisseur === MANUAL_PROVIDER && pending.referenceInterne ? manualInstructions(pending.referenceInterne, pending.montant) : null,
    paymentMode: checkoutProviderId() === MANUAL_PROVIDER ? "MANUAL" : "ONLINE",
    payments: owned?.[0] ?? [],
    receipts: owned?.[1] ?? [],
    history: owned?.[2] ?? [],
  });
}
