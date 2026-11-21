import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { Tx } from "@/lib/transactions";

/**
 * Journal d'audit de l'administration centrale (`JournalAdministration`,
 * ajout seul) : administrateur responsable, date, action, ancienne valeur,
 * nouvelle valeur, motif. Écrit dans la transaction de l'intervention quand
 * il y en a une : l'intervention n'existe jamais sans sa trace.
 */
export type AdminAuditInput = {
  adminId: number;
  action: string;
  entity: string;
  entityId?: number | null;
  organizationId?: number | null;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
  reason?: string | null;
};

export async function recordAdminAudit(client: Tx | typeof prisma, input: AdminAuditInput) {
  await client.journalAdministration.create({
    data: {
      adminId: input.adminId,
      action: input.action,
      entite: input.entity,
      entiteId: input.entityId ?? null,
      organisationId: input.organizationId ?? null,
      ancienneValeur: input.before ?? undefined,
      nouvelleValeur: input.after ?? undefined,
      motif: input.reason ?? null,
    },
  });
}

/** Photo lisible d'un abonnement pour le journal (dates en ISO). */
export function subscriptionSnapshot(
  subscription: {
    plan: string;
    statut: string;
    periodeDebut: Date;
    periodeFin: Date;
    essaiFinLe: Date | null;
    forfaitProgramme?: string | null;
    forfaitProgrammeLe?: Date | null;
    motifSuspension?: string | null;
  } | null,
): Prisma.InputJsonValue | null {
  if (!subscription) return null;
  return {
    plan: subscription.plan,
    statut: subscription.statut,
    periodeDebut: subscription.periodeDebut.toISOString(),
    periodeFin: subscription.periodeFin.toISOString(),
    essaiFinLe: subscription.essaiFinLe?.toISOString() ?? null,
    forfaitProgramme: subscription.forfaitProgramme ?? null,
    forfaitProgrammeLe: subscription.forfaitProgrammeLe?.toISOString() ?? null,
    motifSuspension: subscription.motifSuspension ?? null,
  };
}
