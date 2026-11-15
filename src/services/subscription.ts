import { Prisma } from "@/generated/prisma/client";
import { SubscriptionPaymentStatus, SubscriptionStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { ApiError, Errors } from "@/lib/api/errors";
import { runTransaction } from "@/lib/transactions";

/**
 * Abonnements SaaS — règles d'accès.
 *
 * - Aucune ligne `Abonnement` : organisation NON SOUMISE (comptes existants,
 *   tant que la facturation n'est pas mise en place pour elle).
 * - Essai : accès complet jusqu'à `essaiFinLe`.
 * - Actif : accès complet jusqu'à `periodeFin`, puis délai de grâce
 *   (SUBSCRIPTION_GRACE_DAYS, 7 jours par défaut) avec avertissement.
 * - Au-delà, ou suspendu, ou résilié : LECTURE SEULE. Les données ne sont
 *   jamais bloquées : consultation et exports restent possibles.
 *
 * Le blocage des écritures n'est appliqué que si SUBSCRIPTIONS_ENFORCED=true :
 * l'activer est une décision commerciale, pas un effet du déploiement.
 */
export type AccessState = "UNMANAGED" | "TRIAL" | "ACTIVE" | "GRACE" | "READ_ONLY";

export type SubscriptionAccess = {
  state: AccessState;
  canWrite: boolean;
  /** Date jusqu'à laquelle l'accès complet est garanti (null : non soumis). */
  accessUntil: Date | null;
  plan: string | null;
  /** Vrai à 5 jours ou moins de la fin de l'accès complet : afficher un rappel. */
  endsSoon: boolean;
};

const SOON_MS = 5 * 86_400_000;
const withSoon = (access: Omit<SubscriptionAccess, "endsSoon">, now: Date): SubscriptionAccess => ({
  ...access,
  endsSoon: access.canWrite && access.accessUntil !== null && access.accessUntil.getTime() - now.getTime() < SOON_MS,
});

const DAY_MS = 86_400_000;
const graceDays = () => Number(process.env.SUBSCRIPTION_GRACE_DAYS ?? 7);
export const subscriptionsEnforced = () => process.env.SUBSCRIPTIONS_ENFORCED === "true";

export function accessFromSubscription(
  subscription: { statut: SubscriptionStatus; essaiFinLe: Date | null; periodeFin: Date; plan: string } | null,
  now = new Date(),
): SubscriptionAccess {
  return withSoon(baseAccess(subscription, now), now);
}

function baseAccess(
  subscription: { statut: SubscriptionStatus; essaiFinLe: Date | null; periodeFin: Date; plan: string } | null,
  now: Date,
): Omit<SubscriptionAccess, "endsSoon"> {
  if (!subscription) return { state: "UNMANAGED", canWrite: true, accessUntil: null, plan: null };
  const { statut, plan } = subscription;
  if (statut === SubscriptionStatus.SUSPENDED || statut === SubscriptionStatus.CANCELLED) {
    return { state: "READ_ONLY", canWrite: false, accessUntil: null, plan };
  }
  if (statut === SubscriptionStatus.TRIAL) {
    const end = subscription.essaiFinLe ?? subscription.periodeFin;
    return end > now ? { state: "TRIAL", canWrite: true, accessUntil: end, plan } : { state: "READ_ONLY", canWrite: false, accessUntil: end, plan };
  }
  if (subscription.periodeFin > now && statut === SubscriptionStatus.ACTIVE) {
    return { state: "ACTIVE", canWrite: true, accessUntil: subscription.periodeFin, plan };
  }
  const graceEnd = new Date(subscription.periodeFin.getTime() + graceDays() * DAY_MS);
  return graceEnd > now
    ? { state: "GRACE", canWrite: true, accessUntil: graceEnd, plan }
    : { state: "READ_ONLY", canWrite: false, accessUntil: graceEnd, plan };
}

export async function getSubscriptionAccess(organizationId: number): Promise<SubscriptionAccess> {
  const subscription = await prisma.abonnement.findUnique({
    where: { organisationId: organizationId },
    select: { statut: true, essaiFinLe: true, periodeFin: true, plan: true },
  });
  return accessFromSubscription(subscription);
}

/** Lève 402 si l'organisation est en lecture seule et que le contrôle est activé. */
export async function assertCanWrite(organizationId: number) {
  if (!subscriptionsEnforced()) return;
  const access = await getSubscriptionAccess(organizationId);
  if (!access.canWrite) {
    throw new ApiError(
      402,
      "Votre abonnement n'est plus actif : l'application est en lecture seule. Vos données restent consultables et exportables ; renouvelez l'abonnement pour reprendre les ventes.",
      undefined,
      "SUBSCRIPTION_INACTIVE",
    );
  }
}

export type SubscriptionInput = {
  plan: string;
  statut: SubscriptionStatus;
  essaiFinLe?: Date | null;
  periodeDebut: Date;
  periodeFin: Date;
};

/** Création ou mise à jour d'un abonnement par l'administration de la plateforme. */
export async function upsertSubscription(organizationId: number, input: SubscriptionInput) {
  if (input.periodeFin <= input.periodeDebut) throw Errors.conflict("La fin de période doit suivre son début.");
  const organization = await prisma.organisation.findUnique({ where: { id: organizationId }, select: { id: true } });
  if (!organization) throw Errors.notFound("Organisation introuvable");
  return prisma.abonnement.upsert({
    where: { organisationId: organizationId },
    create: { organisationId: organizationId, ...input, annuleLe: input.statut === SubscriptionStatus.CANCELLED ? new Date() : null },
    update: { ...input, annuleLe: input.statut === SubscriptionStatus.CANCELLED ? new Date() : null },
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
 * Enregistre un paiement d'abonnement (saisi par l'administration pour un
 * paiement reçu hors ligne, ou notifié par un prestataire). Idempotent :
 * une même référence chez un même prestataire n'est traitée qu'une fois.
 * Un paiement réussi prolonge la période et réactive l'abonnement.
 */
export async function recordSubscriptionPayment(organizationId: number, input: SubscriptionPaymentInput) {
  if (input.periodeFin <= input.periodeDebut) throw Errors.conflict("La fin de période doit suivre son début.");
  return runTransaction(async (tx) => {
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
    return { payment, subscription: updated, replay: false };
  });
}
