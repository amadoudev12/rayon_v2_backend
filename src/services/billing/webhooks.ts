import { Prisma } from "@/generated/prisma/client";
import { SubscriptionPaymentStatus } from "@/generated/prisma/enums";
import { ApiError } from "@/lib/api/errors";
import { log } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { closeUnpaid, confirmAndActivate, markUnderReview, paymentEvents } from "./payments";
import { findProvider, InvalidNotificationError, type ProviderTransaction } from "./provider";

/**
 * WebhookService — réception des notifications d'un prestataire de paiement.
 *
 * 1. Signature vérifiée par l'adaptateur du prestataire : sinon 401, tracé.
 * 2. Chaque notification est enregistrée une seule fois (fournisseur,
 *    identifiant d'événement) : une notification répétée n'a aucun effet.
 * 3. Le statut RÉEL est relu auprès du prestataire : la notification seule
 *    n'est jamais une preuve de paiement.
 * 4. Paiement réussi : confirmation puis activation idempotentes (un paiement
 *    déjà activé ne l'est jamais deux fois). En attente : rien ne change.
 *    Échec : la transaction est close sans effet sur l'abonnement.
 */
export type WebhookOutcome = { status: "PROCESSED" | "DUPLICATE" | "IGNORED"; result?: string };

export async function handleProviderWebhook(
  providerId: string,
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
): Promise<WebhookOutcome> {
  const provider = findProvider(providerId);
  if (!provider) throw new ApiError(404, "Ressource introuvable");

  let notification;
  try {
    notification = await provider.verifyNotification(rawBody, headers);
  } catch (error) {
    // Ni le corps ni les en-têtes ne sont conservés : seule la trace du rejet.
    await paymentEvents.record(prisma, {
      paymentId: null,
      provider: providerId,
      type: "NOTIFICATION",
      status: "REJECTED",
      error: error instanceof InvalidNotificationError ? "invalid_signature" : "unreadable_notification",
    });
    log("warn", "billing.webhook_rejected", { provider: providerId });
    throw new ApiError(401, "Notification refusée.");
  }

  const payment = await prisma.paiementAbonnement.findUnique({ where: { referenceInterne: notification.internalReference } });
  let event;
  try {
    event = await paymentEvents.record(prisma, {
      paymentId: payment && payment.fournisseur === providerId ? payment.id : null,
      provider: providerId,
      eventId: notification.eventId,
      type: "NOTIFICATION",
      status: "RECEIVED",
      data: {
        status: notification.status,
        internalReference: notification.internalReference,
        providerReference: notification.providerReference,
        amount: notification.amount,
        currency: notification.currency,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { status: "DUPLICATE" };
    }
    throw error;
  }

  const finish = async (status: string, result: string, error?: string) => {
    await prisma.evenementPaiement.update({ where: { id: event.id }, data: { statutTraitement: status, erreur: error ?? null, donnees: { ...((event.donnees as object | null) ?? {}), result } } });
    return { status: status === "PROCESSED" ? "PROCESSED" : "IGNORED", result } as WebhookOutcome;
  };

  if (!payment || payment.fournisseur !== providerId) return finish("IGNORED", "unknown_payment");

  // Statut réel auprès du prestataire.
  let transaction: ProviderTransaction | null;
  try {
    transaction = await provider.fetchTransaction(notification.internalReference, notification.providerReference ?? payment.referenceExterne);
  } catch {
    // Le rapprochement réessaiera : la notification est conservée.
    return finish("FAILED", "verification_unavailable", "provider_unreachable");
  }
  if (!transaction) return finish("IGNORED", "unknown_at_provider");

  if (transaction.status === "SUCCEEDED") {
    if (transaction.amount === null) return finish("FAILED", "missing_amount");
    const abandoned = payment.statut === SubscriptionPaymentStatus.CANCELLED || payment.statut === SubscriptionPaymentStatus.FAILED;
    const outcome = await confirmAndActivate(payment.id, {
      amount: transaction.amount,
      currency: transaction.currency,
      method: transaction.method,
      providerReference: transaction.providerReference,
      receivedAt: new Date(),
      source: "PROVIDER",
      performedBy: null,
    });
    if (abandoned && outcome.status === "IGNORED") {
      await markUnderReview(payment.id, "Paiement reçu sur une transaction abandonnée.", "PAID_AFTER_CANCEL", null, "PROVIDER");
      return finish("PROCESSED", "under_review");
    }
    return finish("PROCESSED", outcome.status.toLowerCase());
  }
  if (transaction.status === "FAILED" || transaction.status === "CANCELLED") {
    await closeUnpaid(payment.id, transaction.status, "Paiement non abouti chez le prestataire.", "PROVIDER");
    return finish("PROCESSED", transaction.status.toLowerCase());
  }
  return finish("PROCESSED", "pending");
}
