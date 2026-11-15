import { randomUUID } from "node:crypto";
import { InventorySelectionType, InventoryStatus, StockMovementType } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { Errors } from "@/lib/api/errors";
import type { AuthContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";

export async function createInventory(context: AuthContext, data: { boutiqueId: number; libelle: string; selectionType: InventorySelectionType; categorieId?: number; produitIds?: number[] }) {
  const { organizationId, userId, membershipStoreId: restrictedStoreId } = context;
  if (restrictedStoreId && restrictedStoreId !== data.boutiqueId) throw Errors.forbidden("Cette boutique ne vous est pas accessible.");
  return prisma.$transaction(async (tx) => {
    const store = await tx.boutique.findFirst({ where: { id: data.boutiqueId, organisationId: organizationId }, select: { id: true } });
    if (!store) throw Errors.forbidden("Boutique invalide");
    const products = await tx.produit.findMany({
      where: { organisationId: organizationId, actif: true, ...(data.selectionType === InventorySelectionType.CATEGORY ? { categorieId: data.categorieId } : {}), ...(data.selectionType === InventorySelectionType.MANUAL ? { id: { in: data.produitIds ?? [] } } : {}) },
      select: { id: true, nom: true, reference: true, prixAchat: true, categorie: { select: { nom: true } } }, orderBy: { id: "asc" },
    });
    if (!products.length || (data.selectionType === InventorySelectionType.MANUAL && products.length !== new Set(data.produitIds).size)) throw Errors.notFound("Un ou plusieurs produits sont introuvables.");
    await tx.$executeRaw`INSERT INTO "Stock" ("boutiqueId", "produitId", "quantite", "modifieLe") SELECT ${data.boutiqueId}, p."id", 0, NOW() FROM "Produit" p WHERE p."id" = ANY(${products.map((p) => p.id)}) ON CONFLICT ("boutiqueId", "produitId") DO NOTHING`;
    await tx.$queryRaw`SELECT "id" FROM "Stock" WHERE "boutiqueId" = ${data.boutiqueId} AND "produitId" = ANY(${products.map((p) => p.id)}) ORDER BY "produitId" FOR UPDATE`;
    const stocks = await tx.stock.findMany({ where: { boutiqueId: data.boutiqueId, produitId: { in: products.map((p) => p.id) } }, select: { produitId: true, quantite: true } });
    const byProduct = new Map(stocks.map((s) => [s.produitId, s.quantite]));
    const demarreLe = new Date();
    const inv = await tx.inventaire.create({ data: {
      reference: `INV-${randomUUID().slice(0, 8).toUpperCase()}`, libelle: data.libelle, selectionType: data.selectionType,
      categorieId: data.categorieId, produitIds: products.map((p) => p.id), demarreLe,
      organisationId: organizationId, boutiqueId: data.boutiqueId, creeParId: userId,
      lignes: { create: products.map((p) => ({ produitId: p.id, produitNom: p.nom, produitReference: p.reference, categorieNom: p.categorie?.nom ?? null, quantiteTheorique: byProduct.get(p.id) ?? 0, coutUnitaire: p.prixAchat })) },
    }, include: { lignes: true } });
    return inv;
  }, { isolationLevel: "Serializable" });
}

export async function countInventoryLine(context: AuthContext, inventoryId: number, lineId: number, data: { quantiteComptee: number; version: number }) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Inventaire" WHERE "id" = ${inventoryId} FOR UPDATE`;
    const inv = await tx.inventaire.findFirst({ where: { id: inventoryId, organisationId: context.organizationId, ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : {}) }, select: { id: true, statut: true } });
    if (!inv) throw Errors.notFound("Inventaire introuvable");
    if (inv.statut !== InventoryStatus.IN_PROGRESS) throw Errors.conflict("Cet inventaire n'est plus modifiable.");
    const update = await tx.ligneInventaire.updateMany({ where: { id: lineId, inventaireId: inv.id, version: data.version }, data: { quantiteComptee: data.quantiteComptee, compteLe: new Date(), compteParId: context.userId, version: { increment: 1 } } });
    if (update.count !== 1) throw Errors.conflict("La ligne a été modifiée par un autre utilisateur. Rechargez-la.");
    return tx.ligneInventaire.findUniqueOrThrow({ where: { id: lineId } });
  }, { isolationLevel: "Serializable" });
}

export async function getInventory(context: AuthContext, inventoryId: number) {
  const result = await prisma.inventaire.findFirst({ where: { id: inventoryId, organisationId: context.organizationId, ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : {}) }, include: { boutique: { select: { nom: true } }, creePar: { select: { prenom: true, nom: true } }, validePar: { select: { prenom: true, nom: true } }, lignes: { orderBy: { produitNom: "asc" }, include: { comptePar: { select: { prenom: true, nom: true } } } } } });
  if (!result) throw Errors.notFound("Inventaire introuvable");
  return { ...result, canValidate: can(context.role, "inventory:validate"), canCancel: can(context.role, "inventory:cancel") };
}

export async function listInventories(context: AuthContext, boutiqueId?: number) {
  return prisma.inventaire.findMany({ where: { organisationId: context.organizationId, ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : boutiqueId ? { boutiqueId } : {}) }, include: { boutique: { select: { nom: true } }, creePar: { select: { prenom: true, nom: true } }, _count: { select: { lignes: true } } }, orderBy: { creeLe: "desc" } }).then((rows) => rows.map((row) => ({ ...row, canValidate: can(context.role, "inventory:validate"), canCancel: can(context.role, "inventory:cancel") })));
}

export async function cancelInventory(context: AuthContext, inventoryId: number, motif: string) {
  const updated = await prisma.inventaire.updateMany({ where: { id: inventoryId, organisationId: context.organizationId, statut: { in: [InventoryStatus.DRAFT, InventoryStatus.IN_PROGRESS] }, ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : {}) }, data: { statut: InventoryStatus.CANCELLED, annuleLe: new Date(), motifAnnulation: motif, annuleParId: context.userId } });
  if (!updated.count) throw Errors.conflict("Inventaire introuvable ou déjà validé/annulé.");
  return getInventory(context, inventoryId);
}

export async function validateInventory(context: AuthContext, inventoryId: number) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Inventaire" WHERE "id" = ${inventoryId} FOR UPDATE`;
    const inv = await tx.inventaire.findFirst({ where: { id: inventoryId, organisationId: context.organizationId, ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : {}) }, include: { lignes: { orderBy: { produitId: "asc" } } } });
    if (!inv) throw Errors.notFound("Inventaire introuvable");
    if (inv.statut !== InventoryStatus.IN_PROGRESS) throw Errors.conflict("Cet inventaire n'est pas en cours.");
    if (inv.lignes.some((line) => line.quantiteComptee === null || line.compteLe === null)) throw Errors.conflict("Comptez tous les produits avant de valider l'inventaire.");
    await tx.$queryRaw`SELECT "id" FROM "Stock" WHERE "boutiqueId" = ${inv.boutiqueId} AND "produitId" = ANY(${inv.lignes.map((l) => l.produitId)}) ORDER BY "produitId" FOR UPDATE`;
    for (const line of inv.lignes) {
      const since = line.compteLe!;
      const aggregate = await tx.mouvementStock.aggregate({ where: { boutiqueId: inv.boutiqueId, produitId: line.produitId, creeLe: { gt: since } }, _sum: { variationQuantite: true } });
      const attendu = line.quantiteComptee! + (aggregate._sum.variationQuantite ?? 0);
      const current = await tx.stock.findUnique({ where: { boutiqueId_produitId: { boutiqueId: inv.boutiqueId, produitId: line.produitId } } });
      const avant = current?.quantite ?? 0;
      if (attendu < 0 || avant < 0) throw Errors.conflict(`Stock incohérent pour ${line.produitNom}; recommencez le comptage.`);
      const delta = attendu - avant;
      if (delta !== 0) {
        await tx.stock.update({ where: { boutiqueId_produitId: { boutiqueId: inv.boutiqueId, produitId: line.produitId } }, data: { quantite: attendu } });
        await tx.mouvementStock.create({ data: { boutiqueId: inv.boutiqueId, produitId: line.produitId, utilisateurId: context.userId, type: StockMovementType.INVENTORY_ADJUSTMENT, variationQuantite: delta, quantiteAvant: avant, quantiteApres: attendu, coutUnitaire: line.coutUnitaire, creeLe: new Date(), note: `Inventaire ${inv.reference}`, sourceReference: inv.reference, ligneInventaireId: line.id } });
      }
    }
    const updated = await tx.inventaire.updateMany({ where: { id: inventoryId, statut: InventoryStatus.IN_PROGRESS }, data: { statut: InventoryStatus.VALIDATED, valideLe: new Date(), valideParId: context.userId } });
    if (updated.count !== 1) throw Errors.conflict("Cet inventaire a été validé par un autre utilisateur.");
    return tx.inventaire.findUniqueOrThrow({ where: { id: inventoryId }, include: { lignes: true } });
  }, { isolationLevel: "Serializable" });
}
