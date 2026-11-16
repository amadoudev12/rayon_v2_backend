import { createHash, randomUUID } from "node:crypto";
import { InventoryStatus, LossStatus, StockMovementType } from "@/generated/prisma/enums";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { Errors } from "@/lib/api/errors";
import { recordAuditLog } from "@/lib/api/audit";
import { runTransaction, type Tx } from "@/lib/transactions";
import type { AuthContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";
import { lossReasonLabel } from "@/lib/labels";
import type { LossCreateInput } from "@/lib/validations/loss";

/**
 * Pertes de stock (casse, péremption, vol…).
 *
 * - Déclarer retire le stock (jamais sous zéro) et laisse un mouvement LOSS
 *   valorisé au coût d'achat du moment, figé sur la déclaration.
 * - Idempotent : la même clé renvoie la déclaration déjà enregistrée.
 * - Annuler recrédite le stock par un mouvement LOSS_CANCELLATION ; refusé si
 *   un inventaire validé a compté le produit après la perte (le comptage a
 *   déjà intégré la perte : la recréditer créerait du stock fantôme).
 * - Chaque déclaration et annulation est tracée dans le journal d'audit, dans
 *   la même transaction.
 * - Valeur des pertes = Σ quantité × coût figé, exactement comme le résultat
 *   du tableau de bord (`finance.ts`).
 */

function fingerprintOf(data: LossCreateInput): string {
  const normalized = {
    boutiqueId: data.boutiqueId,
    produitId: data.produitId,
    quantite: data.quantite,
    motif: data.motif,
    description: data.description?.trim() || null,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

async function findByKey(organisationId: number, key: string, fingerprint: string) {
  const existing = await prisma.perteStock.findUnique({
    where: { organisationId_cleIdempotence: { organisationId, cleIdempotence: key } },
  });
  if (existing && existing.empreinteIdempotence !== fingerprint) {
    throw Errors.conflict("Cette clé d'idempotence a déjà été utilisée avec d'autres données.");
  }
  return existing;
}

export async function createLoss(context: AuthContext, data: LossCreateInput, key: string) {
  const { organizationId, userId, membershipStoreId } = context;
  if (membershipStoreId && membershipStoreId !== data.boutiqueId) {
    throw Errors.forbidden("Cette boutique ne vous est pas accessible.");
  }
  const fingerprint = fingerprintOf(data);

  const previous = await findByKey(organizationId, key, fingerprint);
  if (previous) return previous;

  try {
    return await runTransaction(async (tx) => {
      const product = await tx.produit.findFirst({
        where: { id: data.produitId, organisationId: organizationId, actif: true },
        select: { id: true, nom: true, prixAchat: true },
      });
      if (!product) throw Errors.notFound("Produit introuvable");
      const store = await tx.boutique.findFirst({
        where: { id: data.boutiqueId, organisationId: organizationId },
        select: { id: true },
      });
      if (!store) throw Errors.forbidden("Boutique invalide");

      await tx.$executeRaw`
        INSERT INTO "Stock" ("boutiqueId", "produitId", "quantite", "modifieLe")
        VALUES (${data.boutiqueId}, ${data.produitId}, 0, NOW())
        ON CONFLICT ("boutiqueId", "produitId") DO NOTHING`;
      const changed = await tx.$queryRaw<Array<{ quantite: number }>>`
        UPDATE "Stock"
        SET "quantite" = "quantite" - ${data.quantite}, "modifieLe" = NOW()
        WHERE "boutiqueId" = ${data.boutiqueId}
          AND "produitId" = ${data.produitId}
          AND "quantite" >= ${data.quantite}
        RETURNING "quantite"`;
      if (!changed.length) throw Errors.conflict("La quantité déclarée dépasse le stock disponible.");
      const after = changed[0]!.quantite;

      const loss = await tx.perteStock.create({
        data: {
          reference: `PER-${randomUUID().slice(0, 8).toUpperCase()}`,
          organisationId: organizationId,
          boutiqueId: data.boutiqueId,
          produitId: data.produitId,
          quantite: data.quantite,
          motif: data.motif,
          description: data.description?.trim() || null,
          coutUnitaire: product.prixAchat,
          cleIdempotence: key,
          empreinteIdempotence: fingerprint,
          declareParId: userId,
        },
      });
      await tx.mouvementStock.create({
        data: {
          boutiqueId: data.boutiqueId,
          produitId: data.produitId,
          utilisateurId: userId,
          type: StockMovementType.LOSS,
          variationQuantite: -data.quantite,
          quantiteAvant: after + data.quantite,
          quantiteApres: after,
          coutUnitaire: product.prixAchat,
          creeLe: new Date(),
          note: lossReasonLabel(data.motif),
          sourceReference: loss.reference,
          perteStockId: loss.id,
        },
      });
      await recordAuditLog(
        {
          organisationId: organizationId,
          utilisateurId: userId,
          action: "loss.created",
          entite: "PerteStock",
          entiteId: loss.id,
          metadonnees: {
            reference: loss.reference,
            produit: product.nom,
            quantite: data.quantite,
            motif: data.motif,
            valeur: product.prixAchat.times(data.quantite).toString(),
          },
        },
        tx,
      );
      return loss;
    });
  } catch (error) {
    // Deux envois simultanés de la même clé : le second voit l'index unique.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const replayed = await findByKey(organizationId, key, fingerprint);
      if (replayed) return replayed;
    }
    throw error;
  }
}

/** Inventaire validé ayant compté le produit après la perte (bloque l'annulation). */
async function inventoryCountedAfter(tx: Tx, loss: { produitId: number; boutiqueId: number; creeLe: Date }) {
  return tx.ligneInventaire.findFirst({
    where: {
      produitId: loss.produitId,
      compteLe: { gt: loss.creeLe },
      inventaire: { boutiqueId: loss.boutiqueId, statut: InventoryStatus.VALIDATED },
    },
    select: { inventaire: { select: { reference: true } } },
  });
}

export async function cancelLoss(context: AuthContext, id: number, motif: string) {
  return runTransaction(async (tx) => {
    // Verrou de la déclaration : deux annulations simultanées ne recréditent qu'une fois.
    const locked = await tx.$queryRaw<{ id: number }[]>`
      SELECT "id" FROM "PerteStock" WHERE "id" = ${id} AND "organisationId" = ${context.organizationId} FOR UPDATE`;
    const loss = locked.length
      ? await tx.perteStock.findFirst({
          where: { id, ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : {}) },
          include: { produit: { select: { nom: true } } },
        })
      : null;
    if (!loss) throw Errors.notFound("Déclaration de perte introuvable");
    if (loss.statut !== LossStatus.ACTIVE) throw Errors.conflict("Cette déclaration est déjà annulée.");

    const countedAfter = await inventoryCountedAfter(tx, loss);
    if (countedAfter) {
      throw Errors.conflict(
        `L'inventaire ${countedAfter.inventaire.reference} a compté ce produit après la perte et a déjà corrigé le stock : l'annulation recréerait du stock qui n'existe pas.`,
      );
    }

    await tx.$executeRaw`
      INSERT INTO "Stock" ("boutiqueId", "produitId", "quantite", "modifieLe")
      VALUES (${loss.boutiqueId}, ${loss.produitId}, 0, NOW())
      ON CONFLICT ("boutiqueId", "produitId") DO NOTHING`;
    const changed = await tx.$queryRaw<Array<{ quantite: number }>>`
      UPDATE "Stock"
      SET "quantite" = "quantite" + ${loss.quantite}, "modifieLe" = NOW()
      WHERE "boutiqueId" = ${loss.boutiqueId} AND "produitId" = ${loss.produitId}
      RETURNING "quantite"`;
    const after = changed[0]!.quantite;

    await tx.perteStock.update({
      where: { id },
      data: { statut: LossStatus.CANCELLED, annuleLe: new Date(), motifAnnulation: motif, annuleParId: context.userId },
    });
    await tx.mouvementStock.create({
      data: {
        boutiqueId: loss.boutiqueId,
        produitId: loss.produitId,
        utilisateurId: context.userId,
        type: StockMovementType.LOSS_CANCELLATION,
        variationQuantite: loss.quantite,
        quantiteAvant: after - loss.quantite,
        quantiteApres: after,
        coutUnitaire: loss.coutUnitaire,
        creeLe: new Date(),
        note: motif,
        sourceReference: loss.reference,
        perteStockId: loss.id,
      },
    });
    await recordAuditLog(
      {
        organisationId: context.organizationId,
        utilisateurId: context.userId,
        action: "loss.cancelled",
        entite: "PerteStock",
        entiteId: loss.id,
        metadonnees: { reference: loss.reference, produit: loss.produit.nom, quantite: loss.quantite, motif },
      },
      tx,
    );
    return tx.perteStock.findUniqueOrThrow({ where: { id } });
  });
}

/**
 * Déclarations d'une boutique, les plus récentes d'abord. `canCancel` dit, pour
 * CHAQUE ligne, si l'annulation est encore possible (droit, statut, et aucun
 * inventaire validé ne l'a absorbée).
 */
export async function listLosses(context: AuthContext, storeId: number, page = 1, limit = 50) {
  const where: Prisma.PerteStockWhereInput = { organisationId: context.organizationId, boutiqueId: storeId };
  const [rows, total] = await Promise.all([
    prisma.perteStock.findMany({
      where,
      include: {
        produit: { select: { id: true, nom: true, unite: true } },
        boutique: { select: { nom: true } },
        declarePar: { select: { prenom: true, nom: true } },
        annulePar: { select: { prenom: true, nom: true } },
      },
      orderBy: [{ creeLe: "desc" }, { id: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.perteStock.count({ where }),
  ]);

  const activeIds = rows.filter((row) => row.statut === LossStatus.ACTIVE).map((row) => row.id);
  const absorbed = activeIds.length
    ? await prisma.$queryRaw<{ id: number }[]>`
        SELECT ps."id"
        FROM "PerteStock" ps
        WHERE ps."id" = ANY(${activeIds}::int[])
          AND EXISTS (
            SELECT 1 FROM "LigneInventaire" li
            JOIN "Inventaire" i ON i."id" = li."inventaireId"
            WHERE li."produitId" = ps."produitId" AND i."boutiqueId" = ps."boutiqueId"
              AND i."statut" = 'VALIDATED' AND li."compteLe" > ps."creeLe"
          )`
    : [];
  const absorbedIds = new Set(absorbed.map((row) => row.id));
  const mayCancel = can(context.role, "loss:cancel");

  const data = rows.map((row) => ({
    ...row,
    motifLibelle: lossReasonLabel(row.motif),
    valeur: row.coutUnitaire.times(row.quantite),
    absorbeeParInventaire: absorbedIds.has(row.id),
    canCancel: mayCancel && row.statut === LossStatus.ACTIVE && !absorbedIds.has(row.id),
  }));
  return { data, total };
}

/**
 * Rapport des pertes ACTIVES d'une boutique sur une période (bornée par
 * l'appelant) : totaux et regroupement par motif et par produit, calculés en
 * SQL avec des montants exacts.
 */
export async function getLossReport(context: AuthContext, storeId: number, period: { start: Date; end: Date }) {
  const filter = Prisma.sql`
    ps."organisationId" = ${context.organizationId} AND ps."boutiqueId" = ${storeId}
    AND ps."statut" = 'ACTIVE' AND ps."creeLe" >= ${period.start} AND ps."creeLe" < ${period.end}`;

  const [totals, byReason, byProduct] = await Promise.all([
    prisma.$queryRaw<{ count: number; quantity: number; value: Prisma.Decimal | null }[]>`
      SELECT COUNT(*)::int AS count, COALESCE(SUM(ps."quantite"), 0)::int AS quantity,
             SUM(ps."quantite" * ps."coutUnitaire") AS value
      FROM "PerteStock" ps WHERE ${filter}`,
    prisma.$queryRaw<{ motif: string; count: number; quantity: number; value: Prisma.Decimal }[]>`
      SELECT ps."motif", COUNT(*)::int AS count, SUM(ps."quantite")::int AS quantity,
             SUM(ps."quantite" * ps."coutUnitaire") AS value
      FROM "PerteStock" ps WHERE ${filter}
      GROUP BY ps."motif" ORDER BY value DESC`,
    prisma.$queryRaw<{ produitId: number; produit: string; count: number; quantity: number; value: Prisma.Decimal }[]>`
      SELECT ps."produitId", p."nom" AS produit, COUNT(*)::int AS count, SUM(ps."quantite")::int AS quantity,
             SUM(ps."quantite" * ps."coutUnitaire") AS value
      FROM "PerteStock" ps JOIN "Produit" p ON p."id" = ps."produitId"
      WHERE ${filter}
      GROUP BY ps."produitId", p."nom" ORDER BY value DESC, p."nom" ASC
      LIMIT 200`,
  ]);

  const total = totals[0];
  return {
    declarations: total?.count ?? 0,
    quantiteTotale: total?.quantity ?? 0,
    valeurTotale: total?.value ?? new Prisma.Decimal(0),
    parMotif: byReason.map((row) => ({
      motif: row.motif,
      libelle: lossReasonLabel(row.motif),
      declarations: row.count,
      quantite: row.quantity,
      valeur: row.value,
    })),
    parProduit: byProduct.map((row) => ({
      produitId: row.produitId,
      produit: row.produit,
      declarations: row.count,
      quantite: row.quantity,
      valeur: row.value,
    })),
  };
}
