import type { Tx } from "@/lib/transactions";

/**
 * Verrouille la ligne de l'organisation jusqu'à la fin de la transaction.
 *
 * Sérialise les opérations qui dépendent d'un comptage ou de l'état de
 * l'abonnement (création d'une boutique ou d'un membre sous quota,
 * application d'un paiement) : deux requêtes simultanées ne peuvent pas
 * toutes deux passer le contrôle puis dépasser la limite.
 */
export async function lockOrganization(tx: Tx, organizationId: number): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Organisation" WHERE "id" = ${organizationId} FOR UPDATE`;
}
