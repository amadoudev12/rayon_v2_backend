import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { InventorySelectionType, InventoryStatus, StockMovementType } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { Errors } from "@/lib/api/errors";
import { recordAuditLog } from "@/lib/api/audit";
import { runTransaction, type Tx } from "@/lib/transactions";
import type { AuthContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";

/**
 * Inventaires physiques.
 *
 * Fiabilité :
 * - une seule opération d'inventaire à la fois par boutique (verrou
 *   consultatif PostgreSQL) et aucun inventaire en cours qui porterait sur
 *   les mêmes produits (sinon deux comptages corrigeraient deux fois le stock) ;
 * - validation ensembliste : un nombre FIXE de requêtes quel que soit le nombre
 *   de produits (catalogues de plusieurs milliers d'articles) ;
 * - cible de validation = quantité comptée + mouvements enregistrés APRÈS le
 *   comptage de la ligne : une vente ou un achat pendant l'inventaire n'est ni
 *   perdu ni compté deux fois ;
 * - chaque correction laisse un mouvement INVENTORY_ADJUSTMENT (avant, après,
 *   coût figé, ligne d'inventaire) et une trace d'audit.
 */

/** Espace de noms des verrous consultatifs d'inventaire (constante arbitraire). */
const INVENTORY_LOCK_NAMESPACE = 41_201;
const LONG_TRANSACTION = { timeout: 120_000 };
const INSERT_CHUNK = 1_000;

async function lockStoreInventories(tx: Tx, storeId: number) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${INVENTORY_LOCK_NAMESPACE}::int, ${storeId}::int)`;
}

export type InventoryCreateInput = {
  boutiqueId: number;
  libelle: string;
  selectionType: InventorySelectionType;
  categorieId?: number;
  produitIds?: number[];
};

export async function createInventory(context: AuthContext, data: InventoryCreateInput) {
  const { organizationId, userId, membershipStoreId } = context;
  if (membershipStoreId && membershipStoreId !== data.boutiqueId) throw Errors.forbidden("Cette boutique ne vous est pas accessible.");

  return runTransaction(async (tx) => {
    const store = await tx.boutique.findFirst({ where: { id: data.boutiqueId, organisationId: organizationId }, select: { id: true } });
    if (!store) throw Errors.forbidden("Boutique invalide");
    if (data.categorieId) {
      const category = await tx.categorie.findFirst({ where: { id: data.categorieId, organisationId: organizationId }, select: { id: true } });
      if (!category) throw Errors.notFound("Catégorie introuvable.");
    }
    await lockStoreInventories(tx, store.id);

    const products = await tx.produit.findMany({
      where: {
        organisationId: organizationId,
        actif: true,
        ...(data.selectionType === InventorySelectionType.CATEGORY ? { categorieId: data.categorieId } : {}),
        ...(data.selectionType === InventorySelectionType.MANUAL ? { id: { in: data.produitIds ?? [] } } : {}),
      },
      select: { id: true, nom: true, reference: true, prixAchat: true, categorie: { select: { nom: true } } },
      orderBy: { id: "asc" },
    });
    if (!products.length || (data.selectionType === InventorySelectionType.MANUAL && products.length !== new Set(data.produitIds).size)) {
      throw Errors.notFound("Un ou plusieurs produits sont introuvables.");
    }
    const productIds = products.map((product) => product.id);

    const overlapping = await tx.inventaire.findFirst({
      where: { organisationId: organizationId, boutiqueId: store.id, statut: InventoryStatus.IN_PROGRESS, lignes: { some: { produitId: { in: productIds } } } },
      select: { reference: true },
    });
    if (overlapping) {
      throw Errors.conflict(`L'inventaire ${overlapping.reference} est déjà en cours sur une partie de ces produits : validez-le ou annulez-le d'abord.`);
    }

    await tx.$executeRaw`INSERT INTO "Stock" ("boutiqueId", "produitId", "quantite", "modifieLe")
      SELECT ${store.id}, p, 0, NOW() FROM unnest(${productIds}::int[]) AS p
      ON CONFLICT ("boutiqueId", "produitId") DO NOTHING`;
    // Quantités théoriques figées sous verrou : instantané cohérent.
    const stocks = await tx.$queryRaw<{ produitId: number; quantite: number }[]>`
      SELECT "produitId", "quantite" FROM "Stock"
      WHERE "boutiqueId" = ${store.id} AND "produitId" = ANY(${productIds}::int[])
      ORDER BY "produitId" FOR UPDATE`;
    const quantityByProduct = new Map(stocks.map((row) => [row.produitId, row.quantite]));

    const inventory = await tx.inventaire.create({
      data: {
        reference: `INV-${randomUUID().slice(0, 8).toUpperCase()}`,
        libelle: data.libelle,
        selectionType: data.selectionType,
        categorieId: data.categorieId,
        produitIds: productIds,
        demarreLe: new Date(),
        organisationId: organizationId,
        boutiqueId: store.id,
        creeParId: userId,
      },
    });
    for (let index = 0; index < products.length; index += INSERT_CHUNK) {
      await tx.ligneInventaire.createMany({
        data: products.slice(index, index + INSERT_CHUNK).map((product) => ({
          inventaireId: inventory.id,
          produitId: product.id,
          produitNom: product.nom,
          produitReference: product.reference,
          categorieNom: product.categorie?.nom ?? null,
          quantiteTheorique: quantityByProduct.get(product.id) ?? 0,
          coutUnitaire: product.prixAchat,
        })),
      });
    }

    await recordAuditLog(
      { organisationId: organizationId, utilisateurId: userId, action: "inventory.created", entite: "Inventaire", entiteId: inventory.id, metadonnees: { produits: products.length } },
      tx,
    );
    return tx.inventaire.findUniqueOrThrow({ where: { id: inventory.id }, include: { lignes: { orderBy: { produitId: "asc" } } } });
  }, LONG_TRANSACTION);
}

export async function countInventoryLine(context: AuthContext, inventoryId: number, lineId: number, data: { quantiteComptee: number; version: number }) {
  if (!Number.isSafeInteger(lineId) || lineId <= 0) throw Errors.invalidId();
  return runTransaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: number }[]>`SELECT "id" FROM "Inventaire" WHERE "id" = ${inventoryId} AND "organisationId" = ${context.organizationId} FOR UPDATE`;
    const inv = rows.length
      ? await tx.inventaire.findFirst({ where: { id: inventoryId, ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : {}) }, select: { id: true, statut: true } })
      : null;
    if (!inv) throw Errors.notFound("Inventaire introuvable");
    if (inv.statut !== InventoryStatus.IN_PROGRESS) throw Errors.conflict("Cet inventaire n'est plus modifiable.");
    const update = await tx.ligneInventaire.updateMany({
      where: { id: lineId, inventaireId: inv.id, version: data.version },
      data: { quantiteComptee: data.quantiteComptee, compteLe: new Date(), compteParId: context.userId, version: { increment: 1 } },
    });
    if (update.count !== 1) throw Errors.conflict("La ligne a été modifiée par un autre utilisateur. Rechargez-la.");
    return tx.ligneInventaire.findUniqueOrThrow({ where: { id: lineId } });
  });
}

export async function getInventory(context: AuthContext, inventoryId: number) {
  const result = await prisma.inventaire.findFirst({
    where: { id: inventoryId, organisationId: context.organizationId, ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : {}) },
    include: {
      boutique: { select: { nom: true } },
      creePar: { select: { prenom: true, nom: true } },
      validePar: { select: { prenom: true, nom: true } },
      lignes: { orderBy: { produitNom: "asc" }, include: { comptePar: { select: { prenom: true, nom: true } } } },
    },
  });
  if (!result) throw Errors.notFound("Inventaire introuvable");
  return { ...result, canValidate: can(context.role, "inventory:validate"), canCancel: can(context.role, "inventory:cancel") };
}

export async function listInventories(context: AuthContext, boutiqueId?: number) {
  const rows = await prisma.inventaire.findMany({
    where: { organisationId: context.organizationId, ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : boutiqueId ? { boutiqueId } : {}) },
    include: { boutique: { select: { nom: true } }, creePar: { select: { prenom: true, nom: true } }, _count: { select: { lignes: true } } },
    orderBy: { creeLe: "desc" },
    take: 200,
  });
  return rows.map((row) => ({ ...row, canValidate: can(context.role, "inventory:validate"), canCancel: can(context.role, "inventory:cancel") }));
}

export async function cancelInventory(context: AuthContext, inventoryId: number, motif: string) {
  const updated = await runTransaction(async (tx) => {
    const result = await tx.inventaire.updateMany({
      where: {
        id: inventoryId,
        organisationId: context.organizationId,
        statut: { in: [InventoryStatus.DRAFT, InventoryStatus.IN_PROGRESS] },
        ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : {}),
      },
      data: { statut: InventoryStatus.CANCELLED, annuleLe: new Date(), motifAnnulation: motif, annuleParId: context.userId },
    });
    if (result.count === 1) {
      await recordAuditLog({ organisationId: context.organizationId, utilisateurId: context.userId, action: "inventory.cancelled", entite: "Inventaire", entiteId: inventoryId, metadonnees: { motif } }, tx);
    }
    return result.count;
  });
  if (!updated) throw Errors.conflict("Inventaire introuvable ou déjà validé/annulé.");
  return getInventory(context, inventoryId);
}

type ValidationRow = { ligneId: number; produitId: number; produitNom: string; compte: number; cout: Prisma.Decimal; avant: number; mouvements: number };

export async function validateInventory(context: AuthContext, inventoryId: number) {
  return runTransaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: number; boutiqueId: number }[]>`
      SELECT "id", "boutiqueId" FROM "Inventaire" WHERE "id" = ${inventoryId} AND "organisationId" = ${context.organizationId} FOR UPDATE`;
    const inv = locked[0];
    if (!inv || (context.membershipStoreId && context.membershipStoreId !== inv.boutiqueId)) throw Errors.notFound("Inventaire introuvable");
    await lockStoreInventories(tx, inv.boutiqueId);

    const header = await tx.inventaire.findUniqueOrThrow({ where: { id: inv.id }, select: { statut: true, reference: true } });
    if (header.statut !== InventoryStatus.IN_PROGRESS) throw Errors.conflict("Cet inventaire n'est pas en cours.");
    const uncounted = await tx.ligneInventaire.count({ where: { inventaireId: inv.id, OR: [{ quantiteComptee: null }, { compteLe: null }] } });
    if (uncounted > 0) throw Errors.conflict(`Comptez tous les produits avant de valider l'inventaire (${uncounted} restant(s)).`);

    // Verrouille toutes les lignes de stock concernées, dans l'ordre des produits.
    await tx.$queryRaw`SELECT s."id" FROM "Stock" s
      WHERE s."boutiqueId" = ${inv.boutiqueId}
        AND s."produitId" IN (SELECT l."produitId" FROM "LigneInventaire" l WHERE l."inventaireId" = ${inv.id})
      ORDER BY s."produitId" FOR UPDATE`;

    const rows = await tx.$queryRaw<ValidationRow[]>`
      SELECT l."id" AS "ligneId", l."produitId", l."produitNom", l."quantiteComptee" AS compte, l."coutUnitaire" AS cout,
             s."quantite" AS avant,
             COALESCE((
               SELECT SUM(m."variationQuantite") FROM "MouvementStock" m
               WHERE m."boutiqueId" = ${inv.boutiqueId} AND m."produitId" = l."produitId" AND m."creeLe" > l."compteLe"
             ), 0)::int AS mouvements
      FROM "LigneInventaire" l
      JOIN "Stock" s ON s."boutiqueId" = ${inv.boutiqueId} AND s."produitId" = l."produitId"
      WHERE l."inventaireId" = ${inv.id}
      ORDER BY l."produitId"`;

    const corrections = rows
      .map((row) => ({ ...row, attendu: row.compte + row.mouvements }))
      .filter((row) => row.attendu !== row.avant);
    const impossible = corrections.find((row) => row.attendu < 0);
    if (impossible) throw Errors.conflict(`Stock incohérent pour « ${impossible.produitNom} » ; recommencez le comptage de ce produit.`);

    if (corrections.length > 0) {
      await tx.$executeRaw`UPDATE "Stock" s SET "quantite" = d.q, "modifieLe" = NOW()
        FROM unnest(${corrections.map((row) => row.produitId)}::int[], ${corrections.map((row) => row.attendu)}::int[]) AS d(pid, q)
        WHERE s."boutiqueId" = ${inv.boutiqueId} AND s."produitId" = d.pid`;
      const now = new Date();
      for (let index = 0; index < corrections.length; index += INSERT_CHUNK) {
        await tx.mouvementStock.createMany({
          data: corrections.slice(index, index + INSERT_CHUNK).map((row) => ({
            boutiqueId: inv.boutiqueId,
            produitId: row.produitId,
            utilisateurId: context.userId,
            type: StockMovementType.INVENTORY_ADJUSTMENT,
            variationQuantite: row.attendu - row.avant,
            quantiteAvant: row.avant,
            quantiteApres: row.attendu,
            coutUnitaire: row.cout,
            creeLe: now,
            note: `Inventaire ${header.reference}`,
            sourceReference: header.reference,
            ligneInventaireId: row.ligneId,
          })),
        });
      }
    }

    await tx.inventaire.update({ where: { id: inv.id }, data: { statut: InventoryStatus.VALIDATED, valideLe: new Date(), valideParId: context.userId } });
    await recordAuditLog(
      {
        organisationId: context.organizationId,
        utilisateurId: context.userId,
        action: "inventory.validated",
        entite: "Inventaire",
        entiteId: inv.id,
        metadonnees: { lignes: rows.length, corrections: corrections.length, ecart: corrections.reduce((sum, row) => sum + (row.attendu - row.avant), 0) },
      },
      tx,
    );
    return tx.inventaire.findUniqueOrThrow({ where: { id: inv.id }, include: { lignes: true } });
  }, LONG_TRANSACTION);
}
