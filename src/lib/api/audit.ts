import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { Tx } from "@/lib/transactions";

type AuditInput = {
  organisationId: number;
  utilisateurId: number | null;
  action: string;
  entite: string;
  entiteId?: number | null;
  metadonnees?: Prisma.InputJsonValue;
};

/**
 * Enregistre une action sensible dans le journal d'audit (ajout seul).
 *
 * - Avec `tx` : écrit DANS la transaction de l'opération. L'opération et sa
 *   trace sont validées ou annulées ensemble : une opération financière ne
 *   peut pas exister sans sa trace.
 * - Sans `tx` : écriture indépendante, qui ne fait jamais échouer la requête
 *   (événements d'observation, ex : connexion refusée).
 */
export async function recordAuditLog(input: AuditInput, tx?: Tx): Promise<void> {
  const data = {
    organisationId: input.organisationId,
    utilisateurId: input.utilisateurId,
    action: input.action,
    entite: input.entite,
    entiteId: input.entiteId ?? null,
    metadonnees: input.metadonnees,
  };
  if (tx) {
    await tx.journalAudit.create({ data });
    return;
  }
  try {
    await prisma.journalAudit.create({ data });
  } catch (error) {
    console.error("Échec de l'écriture du journal d'audit", error);
  }
}
