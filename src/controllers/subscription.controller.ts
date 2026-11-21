import type { Request, Response } from "express";
import { z } from "zod";
import { SubscriptionPaymentStatus, SubscriptionStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { jsonData, routeId } from "@/lib/api/response";
import { confirmPaymentByAdmin, PAYMENT_METHODS, reconcilePayments, rejectPaymentByAdmin } from "@/services/billing/payments";
import { accessFromSubscription, recordSubscriptionPayment, upsertSubscription } from "@/services/subscription";

/**
 * Abonnements gérés par l'administration de la plateforme (`/api/admin`).
 *
 * Saisie DIRECTE (abonnement complet, paiement avec sa période) : conservée
 * pour compatibilité, réservée aux cas exceptionnels. Le parcours normal passe
 * par les interventions de `adminBilling.controller` et la confirmation des
 * transactions. Comme toute intervention manuelle, un motif est exigé.
 */
const reason = z.string({ message: "Motif obligatoire." }).trim().min(5, "Motif obligatoire (5 caractères au moins).").max(500);

const subscriptionSchema = z.object({
  plan: z.string().trim().min(2).max(40),
  statut: z.enum(SubscriptionStatus),
  essaiFinLe: z.coerce.date().optional().nullable(),
  periodeDebut: z.coerce.date(),
  periodeFin: z.coerce.date(),
  motif: reason,
});

const paymentSchema = z.object({
  /** « manuel » pour un paiement reçu hors ligne ; sinon l'identifiant du prestataire. */
  fournisseur: z.string().trim().min(2).max(40).default("manuel"),
  /** Référence de la transaction (n° Mobile Money, reçu…) : rend la saisie idempotente. */
  referenceExterne: z.string().trim().min(3).max(120),
  montant: z.coerce.number().nonnegative(),
  devise: z.string().trim().length(3).default("XOF"),
  periodeDebut: z.coerce.date(),
  periodeFin: z.coerce.date(),
  statut: z.enum(SubscriptionPaymentStatus).default("SUCCEEDED"),
  motif: reason,
});

export async function getOrganizationSubscription(req: Request, res: Response) {
  const subscription = await prisma.abonnement.findUnique({
    where: { organisationId: routeId(req) },
    include: { paiements: { orderBy: { creeLe: "desc" }, take: 50 } },
  });
  return jsonData(res, { subscription, access: accessFromSubscription(subscription) });
}

export async function putOrganizationSubscription(req: Request, res: Response) {
  const { motif, ...parsed } = subscriptionSchema.parse(req.body);
  const subscription = await upsertSubscription(routeId(req), parsed, req.admin.userId, motif);
  return jsonData(res, { subscription, access: accessFromSubscription(subscription) });
}

export async function postSubscriptionPayment(req: Request, res: Response) {
  const { motif, ...parsed } = paymentSchema.parse(req.body);
  const result = await recordSubscriptionPayment(routeId(req), parsed, req.admin.userId, motif);
  return jsonData(res, { ...result, access: accessFromSubscription(result.subscription) }, { status: result.replay ? 200 : 201 });
}

// ---------------------------------------------------------------------------
// Transactions de paiement (paiements Mobile Money reçus hors ligne)
// ---------------------------------------------------------------------------

const confirmSchema = z.object({
  /** Montant effectivement reçu (FCFA). */
  montantRecu: z.coerce.number().int().positive(),
  moyenPaiement: z.enum(PAYMENT_METHODS),
  /** Référence de l'opération Mobile Money (n° de transaction). */
  referenceExterne: z.string().trim().min(3).max(120),
  /** Date de réception de l'argent (par défaut : maintenant). */
  recuLe: z.coerce.date().optional(),
  note: z.string().trim().max(500).optional(),
});

/** Confirme un paiement reçu : activation, reçu et notification, une seule fois. */
export async function postConfirmSubscriptionPayment(req: Request, res: Response) {
  const parsed = confirmSchema.parse(req.body);
  const result = await confirmPaymentByAdmin(req.admin.userId, routeId(req), {
    amount: parsed.montantRecu,
    method: parsed.moyenPaiement,
    providerReference: parsed.referenceExterne,
    receivedAt: parsed.recuLe,
    note: parsed.note,
  });
  return jsonData(res, result);
}

const rejectSchema = z.object({ motif: z.string().trim().min(3).max(500) });

export async function postRejectSubscriptionPayment(req: Request, res: Response) {
  const { motif } = rejectSchema.parse(req.body);
  const payment = await rejectPaymentByAdmin(req.admin.userId, routeId(req), motif);
  return jsonData(res, { id: payment.id, statut: payment.statut, motif: payment.motif });
}

/** Lance le rapprochement immédiatement (il tourne aussi chaque heure). */
export async function postReconcileSubscriptionPayments(_req: Request, res: Response) {
  return jsonData(res, await reconcilePayments());
}
