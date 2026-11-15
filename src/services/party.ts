import { Errors } from "@/lib/api/errors";
import { recordAuditLog } from "@/lib/api/audit";
import { runTransaction } from "@/lib/transactions";
import type { AuthContext } from "@/lib/auth/session";

/**
 * Retrait d'un client ou d'un fournisseur sans jamais perdre l'historique
 * commercial ni comptable :
 * - sans aucune opération : suppression définitive ;
 * - avec des ventes, devis ou achats (créances et dettes comprises) :
 *   archivage. Il disparaît des listes et des nouvelles opérations, mais ses
 *   documents gardent leur tiers. La base l'impose aussi (clé étrangère
 *   RESTRICT), même si ce service était contourné.
 */
export type RemovalResult = { mode: "deleted" | "archived" };

export async function removeCustomer(context: AuthContext, customerId: number): Promise<RemovalResult> {
  return runTransaction(async (tx) => {
    const customer = await tx.client.findFirst({
      where: { id: customerId, organisationId: context.organizationId },
      select: { id: true, nom: true, archive: true, _count: { select: { ventes: true, devis: true } } },
    });
    if (!customer) throw Errors.notFound("Client introuvable");

    const hasHistory = customer._count.ventes + customer._count.devis > 0;
    if (hasHistory) {
      if (!customer.archive) await tx.client.update({ where: { id: customer.id }, data: { archive: true, archiveLe: new Date() } });
    } else {
      await tx.client.delete({ where: { id: customer.id } });
    }
    await recordAuditLog(
      {
        organisationId: context.organizationId,
        utilisateurId: context.userId,
        action: hasHistory ? "customer.archived" : "customer.deleted",
        entite: "Client",
        entiteId: customer.id,
        metadonnees: { nom: customer.nom, ventes: customer._count.ventes, devis: customer._count.devis },
      },
      tx,
    );
    return { mode: hasHistory ? "archived" : "deleted" };
  });
}

export async function restoreCustomer(context: AuthContext, customerId: number) {
  const updated = await runTransaction(async (tx) => {
    const result = await tx.client.updateMany({
      where: { id: customerId, organisationId: context.organizationId, archive: true },
      data: { archive: false, archiveLe: null },
    });
    if (result.count === 1) {
      await recordAuditLog({ organisationId: context.organizationId, utilisateurId: context.userId, action: "customer.restored", entite: "Client", entiteId: customerId }, tx);
    }
    return result.count;
  });
  if (updated === 0) throw Errors.notFound("Client archivé introuvable");
}

export async function removeSupplier(context: AuthContext, supplierId: number): Promise<RemovalResult> {
  return runTransaction(async (tx) => {
    const supplier = await tx.fournisseur.findFirst({
      where: { id: supplierId, organisationId: context.organizationId },
      select: { id: true, nom: true, archive: true, _count: { select: { achats: true } } },
    });
    if (!supplier) throw Errors.notFound("Fournisseur introuvable");

    const hasHistory = supplier._count.achats > 0;
    if (hasHistory) {
      if (!supplier.archive) await tx.fournisseur.update({ where: { id: supplier.id }, data: { archive: true, archiveLe: new Date() } });
    } else {
      await tx.fournisseur.delete({ where: { id: supplier.id } });
    }
    await recordAuditLog(
      {
        organisationId: context.organizationId,
        utilisateurId: context.userId,
        action: hasHistory ? "supplier.archived" : "supplier.deleted",
        entite: "Fournisseur",
        entiteId: supplier.id,
        metadonnees: { nom: supplier.nom, achats: supplier._count.achats },
      },
      tx,
    );
    return { mode: hasHistory ? "archived" : "deleted" };
  });
}

export async function restoreSupplier(context: AuthContext, supplierId: number) {
  const updated = await runTransaction(async (tx) => {
    const result = await tx.fournisseur.updateMany({
      where: { id: supplierId, organisationId: context.organizationId, archive: true },
      data: { archive: false, archiveLe: null },
    });
    if (result.count === 1) {
      await recordAuditLog({ organisationId: context.organizationId, utilisateurId: context.userId, action: "supplier.restored", entite: "Fournisseur", entiteId: supplierId }, tx);
    }
    return result.count;
  });
  if (updated === 0) throw Errors.notFound("Fournisseur archivé introuvable");
}

/** Filtre de liste : actifs par défaut, archivés avec `?archives=true`. */
export function archiveFilter(params: URLSearchParams) {
  return { archive: params.get("archives") === "true" };
}
