import { Prisma } from "@/generated/prisma/client";
import { PaymentMethod, RefundStatus, SaleStatus, StockMovementType } from "@/generated/prisma/enums";
import { Errors } from "@/lib/api/errors";
import { recordAuditLog } from "@/lib/api/audit";
import { sumDecimals } from "@/lib/money";
import { runTransaction } from "@/lib/transactions";
import type { AuthContext } from "@/lib/auth/session";
import { customerBalance, netLineAmounts } from "@/services/sale-balance";
import { fingerprintOf, loadSale, lockSale, type SaleWithDetails } from "@/services/sale";

export type SaleReturnInput = {
  motif: string;
  lignes: { ligneVenteId: number; quantite: number; remiseEnStock: boolean }[];
  /** Si le retour crée un remboursement : le verser tout de suite avec ce mode. */
  remboursementImmediat?: { modePaiement: Exclude<PaymentMethod, "CREDIT"> };
};

/**
 * Retour d'articles sur une vente terminée, en une seule transaction :
 *
 * 1. contrôle : on ne retourne jamais plus que la quantité vendue, moins les
 *    retours précédents ;
 * 2. avoir : prix net de chaque ligne (remise globale répartie au prorata),
 *    au centime ; le dernier retour d'une ligne reprend exactement le reste
 *    de sa part, sans écart d'arrondi ;
 * 3. stock : les articles revendables sont remis en stock (mouvement
 *    SALE_RETURN) ; les autres sont comptés en pertes dans les statistiques ;
 * 4. solde : l'avoir réduit d'abord ce que le client doit encore ; s'il a
 *    payé plus que le nouveau total, l'excédent devient une obligation de
 *    remboursement (versée tout de suite ou plus tard). Aucun avoir client
 *    n'est créé automatiquement.
 */
export async function createSaleReturn(
  context: AuthContext,
  saleId: number,
  input: SaleReturnInput,
  idempotencyKey: string,
): Promise<SaleWithDetails> {
  const fingerprint = fingerprintOf(input);

  return runTransaction(async (tx) => {
    const sale = await lockSale(tx, context, saleId);

    const existing = await tx.retourVente.findUnique({ where: { venteId_cleIdempotence: { venteId: sale.id, cleIdempotence: idempotencyKey } } });
    if (existing) {
      if (existing.empreinteIdempotence !== fingerprint) throw Errors.conflict("Cette clé d’idempotence a déjà servi pour un autre retour.");
      return loadSale(tx, sale.id);
    }

    if (sale.statut !== SaleStatus.COMPLETED) throw Errors.conflict("Une vente annulée ne peut pas faire l'objet d'un retour.");

    const requested = new Set<number>();
    for (const line of input.lignes) {
      if (requested.has(line.ligneVenteId)) throw Errors.conflict("Une même ligne de vente apparaît deux fois dans le retour.");
      requested.add(line.ligneVenteId);
    }

    const linesById = new Map(sale.lignes.map((line) => [line.id, line]));
    const netShares = netLineAmounts(sale.lignes, sale.sousTotal, sale.total);
    const creditedByLine = await tx.ligneRetourVente.groupBy({
      by: ["ligneVenteId"],
      where: { ligneVenteId: { in: [...requested] } },
      _sum: { montant: true },
    });
    const alreadyCredited = new Map(creditedByLine.map((row) => [row.ligneVenteId, row._sum.montant ?? new Prisma.Decimal(0)]));

    const returnLines = input.lignes.map((requestedLine) => {
      const line = linesById.get(requestedLine.ligneVenteId);
      if (!line) throw Errors.notFound("Une ligne du retour n'appartient pas à cette vente.");
      const available = line.quantite - line.quantiteRetournee;
      if (requestedLine.quantite > available) {
        throw Errors.conflict(`Quantité retournée trop élevée : ${available} article(s) au plus peuvent encore être retournés sur cette ligne.`);
      }
      const share = netShares.get(line.id)!;
      const closesLine = line.quantiteRetournee + requestedLine.quantite === line.quantite;
      const montant = closesLine
        ? share.minus(alreadyCredited.get(line.id) ?? 0)
        : share.times(requestedLine.quantite).dividedBy(line.quantite).toDecimalPlaces(2);
      return { line, quantite: requestedLine.quantite, remiseEnStock: requestedLine.remiseEnStock, montant };
    });

    const montant = sumDecimals(returnLines.map((entry) => entry.montant));
    const coutTotal = sumDecimals(returnLines.map((entry) => entry.line.coutUnitaire.times(entry.quantite))).toDecimalPlaces(2);

    const retour = await tx.retourVente.create({
      data: {
        montant,
        coutTotal,
        motif: input.motif,
        cleIdempotence: idempotencyKey,
        empreinteIdempotence: fingerprint,
        organisationId: sale.organisationId,
        boutiqueId: sale.boutiqueId,
        venteId: sale.id,
        creeParId: context.userId,
        lignes: {
          create: returnLines.map((entry) => ({
            quantite: entry.quantite,
            montant: entry.montant,
            coutUnitaire: entry.line.coutUnitaire,
            remiseEnStock: entry.remiseEnStock,
            ligneVenteId: entry.line.id,
            produitId: entry.line.produitId,
          })),
        },
      },
    });

    for (const entry of returnLines) {
      // Garde-fou : la ligne n'a pas changé depuis sa lecture (la vente est verrouillée).
      const updated = await tx.ligneVente.updateMany({
        where: { id: entry.line.id, quantiteRetournee: entry.line.quantiteRetournee },
        data: { quantiteRetournee: { increment: entry.quantite } },
      });
      if (updated.count !== 1) throw Errors.conflict("La vente vient d'être modifiée. Rechargez puis réessayez.");
    }

    const restocked = returnLines.filter((entry) => entry.remiseEnStock).sort((a, b) => a.line.produitId - b.line.produitId);
    for (const entry of restocked) {
      await tx.$executeRaw`INSERT INTO "Stock" ("boutiqueId", "produitId", "quantite", "modifieLe") VALUES (${sale.boutiqueId}, ${entry.line.produitId}, 0, NOW()) ON CONFLICT ("boutiqueId", "produitId") DO NOTHING`;
      const rows = await tx.$queryRaw<Array<{ quantite: number }>>`UPDATE "Stock" SET "quantite" = "quantite" + ${entry.quantite}, "modifieLe" = NOW() WHERE "boutiqueId" = ${sale.boutiqueId} AND "produitId" = ${entry.line.produitId} RETURNING "quantite"`;
      const after = rows[0]!.quantite;
      await tx.mouvementStock.create({
        data: {
          boutiqueId: sale.boutiqueId,
          produitId: entry.line.produitId,
          utilisateurId: context.userId,
          type: StockMovementType.SALE_RETURN,
          variationQuantite: entry.quantite,
          quantiteAvant: after - entry.quantite,
          quantiteApres: after,
          coutUnitaire: entry.line.coutUnitaire,
          creeLe: new Date(),
          sourceReference: `Retour vente #${sale.id}`,
          note: input.motif,
          venteId: sale.id,
          retourVenteId: retour.id,
        },
      });
    }

    // Nouveau solde : l'avoir réduit d'abord la dette du client ; le reste
    // est ce qu'il a payé en trop, donc dû en remboursement.
    const montantRetourne = sale.montantRetourne.plus(montant);
    const refundDue = Prisma.Decimal.max(montant.minus(sale.resteAPayer), 0).toDecimalPlaces(2);
    const montantARembourser = sale.montantARembourser.plus(refundDue);

    if (refundDue.greaterThan(0)) {
      const refund = await tx.remboursementVente.create({
        data: {
          montant: refundDue,
          motif: `Retour d'articles : ${input.motif}`,
          cleIdempotence: `retour:${idempotencyKey}`,
          venteId: sale.id,
          demandeParId: context.userId,
          retourVenteId: retour.id,
        },
      });
      if (input.remboursementImmediat) {
        await tx.versementRemboursement.create({
          data: {
            remboursementVenteId: refund.id,
            montant: refundDue,
            modePaiement: input.remboursementImmediat.modePaiement,
            cleIdempotence: `retour:${idempotencyKey}`,
            utilisateurId: context.userId,
          },
        });
        await tx.remboursementVente.update({ where: { id: refund.id }, data: { statut: RefundStatus.COMPLETED } });
      }
    }

    await tx.vente.update({
      where: { id: sale.id },
      data: {
        montantRetourne,
        montantARembourser,
        resteAPayer: customerBalance({ ...sale, montantRetourne, montantARembourser }),
      },
    });

    await recordAuditLog(
      {
        organisationId: sale.organisationId,
        utilisateurId: context.userId,
        action: "sale.returned",
        entite: "RetourVente",
        entiteId: retour.id,
        metadonnees: {
          venteId: sale.id,
          avoir: montant.toString(),
          remboursementDu: refundDue.toString(),
          lignes: returnLines.map((entry) => ({ ligneVenteId: entry.line.id, quantite: entry.quantite, remiseEnStock: entry.remiseEnStock })),
        },
      },
      tx,
    );

    return loadSale(tx, sale.id);
  });
}
