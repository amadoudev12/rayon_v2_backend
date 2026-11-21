import { Role, SubscriptionStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { Errors } from "@/lib/api/errors";
import type { Tx } from "@/lib/transactions";
import { formatDateFr } from "@/lib/format-fr";
import { GRACE_DAYS } from "@/services/billing/plans";
import { DAY_MS, graceEnd } from "@/services/billing/rules";
import { subscriptionsEnforced } from "@/services/billing/flags";

/**
 * NotificationService — notifications intégrées à l'application (aucun envoi
 * email ou WhatsApp dans cette version). Une notification porte une clé
 * unique par organisation : la même notification n'est jamais créée deux
 * fois, même si la tâche planifiée ou un traitement est rejoué.
 */

export const SUBSCRIPTION_PAGE = "/abonnement";

type NotificationInput = { type: string; title: string; message: string; link?: string | null; key: string };

/** Notifie le propriétaire de l'organisation (destinataire des notifications d'abonnement). */
export async function notifyOwner(client: Tx | typeof prisma, organizationId: number, input: NotificationInput): Promise<boolean> {
  const owner = await client.membre.findFirst({
    where: { organisationId: organizationId, role: Role.OWNER },
    orderBy: { id: "asc" },
    select: { utilisateurId: true },
  });
  if (!owner) return false;
  const result = await client.notification.createMany({
    data: [
      {
        organisationId: organizationId,
        utilisateurId: owner.utilisateurId,
        type: input.type,
        titre: input.title,
        message: input.message,
        lien: input.link ?? SUBSCRIPTION_PAGE,
        cle: input.key,
      },
    ],
    skipDuplicates: true,
  });
  return result.count === 1;
}

// ---------------------------------------------------------------------------
// Consultation (chaque utilisateur ne voit que les siennes)
// ---------------------------------------------------------------------------

export async function listNotifications(userId: number, organizationId: number, options: { unreadOnly?: boolean; limit?: number } = {}) {
  const where = { utilisateurId: userId, organisationId: organizationId, ...(options.unreadOnly ? { luLe: null } : {}) };
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { id: "desc" },
      take: Math.min(Math.max(options.limit ?? 30, 1), 100),
      select: { id: true, type: true, titre: true, message: true, lien: true, luLe: true, creeLe: true },
    }),
    prisma.notification.count({ where: { utilisateurId: userId, organisationId: organizationId, luLe: null } }),
  ]);
  return { items, unread };
}

export async function countUnreadNotifications(userId: number, organizationId: number) {
  return prisma.notification.count({ where: { utilisateurId: userId, organisationId: organizationId, luLe: null } });
}

export async function markNotificationRead(userId: number, organizationId: number, notificationId: number) {
  const result = await prisma.notification.updateMany({
    where: { id: notificationId, utilisateurId: userId, organisationId: organizationId, luLe: null },
    data: { luLe: new Date() },
  });
  if (result.count === 0) {
    const exists = await prisma.notification.count({ where: { id: notificationId, utilisateurId: userId, organisationId: organizationId } });
    if (!exists) throw Errors.notFound("Notification introuvable");
  }
}

export async function markAllNotificationsRead(userId: number, organizationId: number) {
  const result = await prisma.notification.updateMany({
    where: { utilisateurId: userId, organisationId: organizationId, luLe: null },
    data: { luLe: new Date() },
  });
  return { updated: result.count };
}

// ---------------------------------------------------------------------------
// Rappels d'échéance (tâche planifiée)
// ---------------------------------------------------------------------------

type Reminder = NotificationInput & { kind: string };

/**
 * Notification due pour une échéance à l'instant `now`, ou null.
 * Seul le palier COURANT est émis (7, 3, 1 jours avant, jour de l'expiration,
 * passage en lecture seule) : une tâche arrêtée quelques jours ne déverse pas
 * des rappels périmés. La clé inclut l'échéance : un renouvellement ouvre de
 * nouveaux rappels pour la nouvelle échéance.
 */
export function dueReminder(subscription: { statut: SubscriptionStatus; essaiFinLe: Date | null; periodeFin: Date }, now: Date): Reminder | null {
  const trial = subscription.statut === SubscriptionStatus.TRIAL;
  const end = trial ? (subscription.essaiFinLe ?? subscription.periodeFin) : subscription.periodeFin;
  const stamp = end.toISOString();
  const what = trial ? "Votre période d'essai" : "Votre abonnement";

  if (end > now) {
    const days = Math.ceil((end.getTime() - now.getTime()) / DAY_MS);
    const bucket = days <= 1 ? 1 : days <= 3 ? 3 : days <= 7 ? 7 : null;
    if (!bucket) return null;
    return {
      kind: `J-${bucket}`,
      type: bucket === 1 ? "SUBSCRIPTION_LAST_REMINDER" : "SUBSCRIPTION_REMINDER",
      title: bucket === 1 ? "Dernier rappel : renouvelez votre abonnement" : "Renouvelez votre abonnement",
      message: `${what} se termine le ${formatDateFr(end)}${bucket === 1 ? " (demain)" : ` (dans ${bucket} jours)`}. ${
        trial ? "Choisissez un forfait pour continuer à enregistrer vos ventes." : "Renouvelez-le pour continuer sans interruption."
      }`,
      key: `reminder-${bucket}:${stamp}`,
    };
  }

  if (trial) {
    return {
      kind: "READ_ONLY",
      type: "SUBSCRIPTION_READ_ONLY",
      title: "Période d'essai terminée : lecture seule",
      message: "Votre période d'essai est terminée. Vos données restent consultables ; choisissez un forfait pour reprendre les ventes.",
      key: `read-only:${stamp}`,
    };
  }
  const graceEndsAt = graceEnd(end);
  if (now < graceEndsAt) {
    return {
      kind: "EXPIRED",
      type: "SUBSCRIPTION_EXPIRED",
      title: "Votre abonnement a expiré",
      message: `Votre abonnement a expiré le ${formatDateFr(end)}. Vous gardez un accès normal pendant ${GRACE_DAYS} jours, jusqu'au ${formatDateFr(graceEndsAt)} ; renouvelez-le avant cette date.`,
      key: `expired:${stamp}`,
    };
  }
  return {
    kind: "READ_ONLY",
    type: "SUBSCRIPTION_READ_ONLY",
    title: "Application en lecture seule",
    message: "Le délai de grâce est terminé : l'application est en lecture seule. Vos données sont conservées et restent consultables ; renouvelez l'abonnement pour reprendre les ventes.",
    key: `read-only:${stamp}`,
  };
}

/** Génère les rappels d'échéance dus (uniquement si les abonnements sont appliqués). */
export async function runExpiryNotifications(now = new Date()) {
  if (!subscriptionsEnforced()) return { created: 0 };
  const from = new Date(now.getTime() - (GRACE_DAYS + 3) * DAY_MS);
  const to = new Date(now.getTime() + 8 * DAY_MS);
  const subscriptions = await prisma.abonnement.findMany({
    where: {
      statut: { in: [SubscriptionStatus.TRIAL, SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE] },
      OR: [{ periodeFin: { gte: from, lte: to } }, { essaiFinLe: { gte: from, lte: to } }],
    },
    select: { organisationId: true, statut: true, essaiFinLe: true, periodeFin: true },
  });
  let created = 0;
  for (const subscription of subscriptions) {
    const reminder = dueReminder(subscription, now);
    if (reminder && (await notifyOwner(prisma, subscription.organisationId, reminder))) created += 1;
  }
  return { created };
}
