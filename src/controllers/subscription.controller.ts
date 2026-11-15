import type { Request, Response } from "express";
import { z } from "zod";
import { SubscriptionPaymentStatus, SubscriptionStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { jsonData, routeId } from "@/lib/api/response";
import { accessFromSubscription, recordSubscriptionPayment, upsertSubscription } from "@/services/subscription";

/**
 * Abonnements gérés par l'administration de la plateforme (`/api/admin`).
 * Permet de commercialiser dès maintenant avec des paiements reçus hors ligne
 * (Mobile Money, virement, espèces), enregistrés ici avec leur référence.
 */
const subscriptionSchema = z.object({
  plan: z.string().trim().min(2).max(40),
  statut: z.enum(SubscriptionStatus),
  essaiFinLe: z.coerce.date().optional().nullable(),
  periodeDebut: z.coerce.date(),
  periodeFin: z.coerce.date(),
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
});

export async function getOrganizationSubscription(req: Request, res: Response) {
  const subscription = await prisma.abonnement.findUnique({
    where: { organisationId: routeId(req) },
    include: { paiements: { orderBy: { creeLe: "desc" }, take: 50 } },
  });
  return jsonData(res, { subscription, access: accessFromSubscription(subscription) });
}

export async function putOrganizationSubscription(req: Request, res: Response) {
  const parsed = subscriptionSchema.parse(req.body);
  const subscription = await upsertSubscription(routeId(req), parsed);
  return jsonData(res, { subscription, access: accessFromSubscription(subscription) });
}

export async function postSubscriptionPayment(req: Request, res: Response) {
  const parsed = paymentSchema.parse(req.body);
  const result = await recordSubscriptionPayment(routeId(req), parsed);
  return jsonData(res, { ...result, access: accessFromSubscription(result.subscription) }, { status: result.replay ? 200 : 201 });
}
