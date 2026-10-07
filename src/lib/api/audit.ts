import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

type AuditInput = {
  organisationId: number;
  utilisateurId: number | null;
  action: string;
  entite: string;
  entiteId?: number | null;
  metadonnees?: Prisma.InputJsonValue;
};

/**
 * Enregistre une action sensible dans le journal d'audit (ajout seul). Ne
 * bloque ni ne fait échouer la requête appelante : l'audit sert à
 * l'observation, ce n'est pas une règle métier.
 */
export async function recordAuditLog(input: AuditInput): Promise<void> {
  try {
    await prisma.journalAudit.create({
      data: {
        organisationId: input.organisationId,
        utilisateurId: input.utilisateurId,
        action: input.action,
        entite: input.entite,
        entiteId: input.entiteId ?? null,
        metadonnees: input.metadonnees,
      },
    });
  } catch (error) {
    console.error("Échec de l'écriture du journal d'audit", error);
  }
}
