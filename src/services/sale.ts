import { prisma } from "@/lib/prisma";
import { Errors } from "@/lib/api/errors";
import { PaymentMethod, SaleStatus, StockMovementType } from "@/generated/prisma/enums";
import { Prisma } from "@/generated/prisma/client";
import { sumDecimals } from "@/lib/money";
import { createHash } from "node:crypto";
import type { AuthContext } from "@/lib/auth/session";
import type { SaleFormData } from "@/lib/validations/sale";

const saleInclude = {
  lignes: { include: { produit: { select: { id: true, nom: true, unite: true } } } },
  client: { select: { id: true, nom: true } },
  vendeur: { select: { id: true, prenom: true, nom: true } },
  paiements: { orderBy: { date: "asc" } },
  remboursements: { include: { versements: { orderBy: { date: "asc" } } }, orderBy: { creeLe: "asc" } },
} satisfies Prisma.VenteInclude;

export type SaleWithDetails = Prisma.VenteGetPayload<{ include: typeof saleInclude }>;

/**
 * Regroupe les lignes d'un même produit (quantités additionnées) et garde le
 * prix négocié éventuel. Deux prix différents pour un même produit sont refusés.
 */
export function groupLines(lignes: SaleFormData["lignes"]) {
  const byProduct = new Map<number, { produitId: number; quantite: number; prixUnitaire?: number }>();
  for (const line of lignes) {
    const existing = byProduct.get(line.produitId);
    if (!existing) {
      byProduct.set(line.produitId, { ...line });
      continue;
    }
    if (line.prixUnitaire !== undefined && existing.prixUnitaire !== undefined && line.prixUnitaire !== existing.prixUnitaire) {
      throw Errors.conflict("Un même produit ne peut pas avoir deux prix différents dans le panier.");
    }
    existing.quantite += line.quantite;
    existing.prixUnitaire ??= line.prixUnitaire;
  }
  return [...byProduct.values()];
}

/** Prix appliqué à une ligne : le prix négocié s'il est fourni, sinon le prix de vente du produit. */
export function unitPriceOf(line: { prixUnitaire?: number }, produit: { prixVente: Prisma.Decimal }): Prisma.Decimal {
  return line.prixUnitaire !== undefined ? new Prisma.Decimal(line.prixUnitaire).toDecimalPlaces(2) : produit.prixVente;
}

/** Reste à payer d'une vente : total − somme des paiements (jamais négatif). */
export function remainingOf(sale: { total: Prisma.Decimal; montantPaye: Prisma.Decimal }): Prisma.Decimal {
  const remaining = sale.total.minus(sale.montantPaye);
  return remaining.isNegative() ? new Prisma.Decimal(0) : remaining;
}

/**
 * Montant encaissé à la création de la vente :
 * - vente à crédit : le premier versement (0 par défaut), au plus le total ;
 * - autres modes : la vente est payée en totalité (un montant remis supérieur
 *   au total est de la monnaie rendue, pas un encaissement).
 */
function initialPayment(data: SaleFormData, total: Prisma.Decimal): Prisma.Decimal {
  if (data.modePaiement === PaymentMethod.CREDIT) {
    const paid = new Prisma.Decimal(data.montantPaye ?? 0).toDecimalPlaces(2);
    if (paid.greaterThan(total)) {
      throw Errors.conflict("Le premier versement ne peut pas dépasser le total de la vente.");
    }
    return paid;
  }
  if (data.montantPaye !== undefined && new Prisma.Decimal(data.montantPaye).lessThan(total)) {
    throw Errors.conflict("Paiement partiel : choisissez le mode « Crédit client ».");
  }
  return total;
}

/**
 * Enregistre une vente de bout en bout : vérifie que chaque produit appartient
 * à l'organisation, décrémente le stock de façon atomique (la vente entière est
 * refusée si une ligne manque de stock), fige le prix et le coût sur chaque
 * ligne et journalise un mouvement de stock par ligne, le tout dans une seule
 * transaction pour ne jamais laisser une vente à moitié appliquée.
 *
 * Le prix d'une ligne peut être négocié avec le client (`prixUnitaire`) ; la
 * remise globale s'applique ensuite sur le sous-total. La marge est calculée
 * sur le prix réellement pratiqué.
 */
export async function createSale(
  context: AuthContext,
  storeId: number,
  data: SaleFormData,
  idempotencyKey?: string,
): Promise<SaleWithDetails> {
  const { organizationId, userId } = context;
  const fingerprint = idempotencyKey ? createHash("sha256").update(JSON.stringify({ storeId, data })).digest("hex") : null;
  if (idempotencyKey) {
    const existing = await prisma.vente.findFirst({ where: { organisationId: organizationId, boutiqueId: storeId, cleIdempotence: idempotencyKey }, include: saleInclude });
    if (existing) {
      if (existing.empreinteIdempotence !== fingerprint) throw Errors.conflict("Cette clé d’idempotence a déjà servi pour une autre vente.");
      return existing;
    }
  }

  const lines = groupLines(data.lignes);

  // Une créance doit pouvoir être réclamée : le client est obligatoire.
  if (data.modePaiement === PaymentMethod.CREDIT && !data.clientId) {
    throw Errors.conflict("Sélectionnez le client pour une vente à crédit.");
  }

  if (data.clientId) {
    const customer = await prisma.client.findFirst({
      where: { id: data.clientId, organisationId: organizationId },
      select: { id: true },
    });
    if (!customer) throw Errors.notFound("Client introuvable");
  }

  try {
    return await prisma.$transaction(async (tx) => {
    const products = await tx.produit.findMany({
      where: { id: { in: lines.map((line) => line.produitId) }, organisationId: organizationId, actif: true },
      select: { id: true, nom: true, prixVente: true, prixAchat: true },
    });
    const productsById = new Map(products.map((product) => [product.id, product]));

    if (productsById.size !== lines.length) {
      throw Errors.notFound("Un ou plusieurs produits sont introuvables ou inactifs");
    }

    const saleLines = lines.map((line) => {
      const produit = productsById.get(line.produitId)!;
      const prixUnitaire = unitPriceOf(line, produit);
      return { ...line, produit, prixUnitaire, sousTotal: prixUnitaire.times(line.quantite) };
    });

    const quantitiesAfter = new Map<number, number>();
    for (const line of [...saleLines].sort((a, b) => a.produitId - b.produitId)) {
      const updated = await tx.$queryRaw<Array<{ quantite: number }>>`UPDATE "Stock" SET "quantite" = "quantite" - ${line.quantite}, "modifieLe" = NOW() WHERE "boutiqueId" = ${storeId} AND "produitId" = ${line.produitId} AND "quantite" >= ${line.quantite} RETURNING "quantite"`;
      if (updated.length !== 1) {
        throw Errors.conflict(`Stock insuffisant pour "${line.produit.nom}"`);
      }
      quantitiesAfter.set(line.produitId, updated[0]!.quantite);
    }

    const sousTotal = sumDecimals(saleLines.map((line) => line.sousTotal));
    const remise = new Prisma.Decimal(data.remise ?? 0);
    if (remise.greaterThan(sousTotal)) throw Errors.conflict("La remise ne peut pas dépasser le sous-total.");
    const total = sousTotal.minus(remise).toDecimalPlaces(2);
    const montantPaye = initialPayment(data, total);

    const sale = await tx.vente.create({
      data: {
        organisationId: organizationId,
        boutiqueId: storeId,
        vendeurId: userId,
        clientId: data.clientId ?? null,
        modePaiement: data.modePaiement,
        sousTotal,
        remise,
        total,
        montantPaye,
        note: data.note || null,
        cleIdempotence: idempotencyKey,
        empreinteIdempotence: fingerprint,
        lignes: {
          create: saleLines.map((line) => ({
            produitId: line.produitId,
            quantite: line.quantite,
            prixUnitaire: line.prixUnitaire,
            coutUnitaire: line.produit.prixAchat,
            sousTotal: line.sousTotal,
          })),
        },
        // Le paiement initial ouvre l'historique des paiements de la vente.
        paiements: montantPaye.isZero() ? undefined : { create: { montant: montantPaye, modePaiement: data.modePaiement === PaymentMethod.CREDIT ? (data.modePaiementAcompte ?? PaymentMethod.CASH) : data.modePaiement, utilisateurId: userId } },
      },
      include: saleInclude,
    });

    await tx.mouvementStock.createMany({
      data: saleLines.map((line) => ({
        boutiqueId: storeId,
        produitId: line.produitId,
        utilisateurId: userId,
        type: StockMovementType.SALE,
        variationQuantite: -line.quantite,
        quantiteAvant: quantitiesAfter.get(line.produitId)! + line.quantite,
        quantiteApres: quantitiesAfter.get(line.produitId)!,
        coutUnitaire: line.produit.prixAchat,
        creeLe: new Date(),
        sourceReference: `Vente #${sale.id}`,
        venteId: sale.id,
      })),
    });

    // Devis transformé : il est relié à la vente, une seule fois. Sinon toute
    // la vente est annulée (stock compris) par l'échec de la transaction.
    if (data.devisId) {
      const linked = await tx.devis.updateMany({
        where: { id: data.devisId, organisationId: organizationId, boutiqueId: storeId, venteId: null },
        data: { venteId: sale.id },
      });
      if (linked.count !== 1) {
        throw Errors.conflict("Ce devis est introuvable ou a déjà été transformé en vente.");
      }
    }

      return sale;
    });
  } catch (error) {
    if (idempotencyKey && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await prisma.vente.findFirst({ where: { organisationId: organizationId, cleIdempotence: idempotencyKey }, include: saleInclude });
      if (existing?.empreinteIdempotence === fingerprint) return existing;
      if (existing) throw Errors.conflict("Cette clé d’idempotence a déjà servi pour une autre vente.");
    }
    throw error;
  }
}

/**
 * Annule une vente terminée : remet chaque ligne en stock et passe la vente
 * en CANCELLED. Ne peut pas être appliqué deux fois à la même vente. Le devis
 * dont elle provenait redevient transformable.
 */
export async function cancelSale(context: AuthContext, saleId: number, motif = "Annulation demandée"): Promise<SaleWithDetails> {
  const { organizationId, userId } = context;

  return prisma.$transaction(async (tx) => {
    const claim = await tx.vente.updateMany({
      where: { id: saleId, organisationId: organizationId, statut: SaleStatus.COMPLETED,
        ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : {}) },
      data: { statut: SaleStatus.CANCELLED, annuleLe: new Date(), annuleParId: userId, motifAnnulation: motif },
    });
    if (claim.count !== 1) {
      const exists = await tx.vente.findFirst({ where: { id: saleId, organisationId: organizationId,
        ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : {}) }, select: { id: true } });
      if (!exists) throw Errors.notFound("Vente introuvable");
      throw Errors.conflict("Cette vente est déjà annulée ou a été modifiée.");
    }
    const sale = await tx.vente.findFirst({
      where: { id: saleId, organisationId: organizationId },
      include: { lignes: true },
    });
    if (!sale) throw Errors.notFound("Vente introuvable");
    const quantitiesAfter = new Map<number, number>();
    for (const line of [...sale.lignes].sort((a, b) => a.produitId - b.produitId)) {
      await tx.$executeRaw`INSERT INTO "Stock" ("boutiqueId", "produitId", "quantite", "modifieLe") VALUES (${sale.boutiqueId}, ${line.produitId}, 0, NOW()) ON CONFLICT ("boutiqueId", "produitId") DO NOTHING`;
      const updated = await tx.$queryRaw<Array<{ quantite: number }>>`UPDATE "Stock" SET "quantite" = "quantite" + ${line.quantite}, "modifieLe" = NOW() WHERE "boutiqueId" = ${sale.boutiqueId} AND "produitId" = ${line.produitId} RETURNING "quantite"`;
      quantitiesAfter.set(line.produitId, updated[0]!.quantite);
    }

    await tx.mouvementStock.createMany({
      data: sale.lignes.map((line) => ({
        boutiqueId: sale.boutiqueId,
        produitId: line.produitId,
        utilisateurId: userId,
        type: StockMovementType.SALE_CANCELLATION,
        variationQuantite: line.quantite,
        quantiteAvant: quantitiesAfter.get(line.produitId)! - line.quantite,
        quantiteApres: quantitiesAfter.get(line.produitId)!,
        coutUnitaire: line.coutUnitaire,
        creeLe: new Date(),
        sourceReference: `Annulation vente #${sale.id}`,
        venteId: sale.id,
        note: "Annulation de vente",
      })),
    });

    await tx.devis.updateMany({ where: { venteId: sale.id }, data: { venteId: null } });

    const priorRefunds = await tx.remboursementVente.aggregate({ where: { venteId: sale.id }, _sum: { montant: true } });
    const refundDue = sale.montantPaye.minus(priorRefunds._sum.montant ?? 0);
    if (refundDue.greaterThan(0)) {
      await tx.remboursementVente.create({ data: {
        montant: refundDue, motif: `Annulation de vente: ${motif}`,
        cleIdempotence: `annulation-${sale.id}`, venteId: sale.id, demandeParId: userId,
      } });
    }

    return tx.vente.findUniqueOrThrow({
      where: { id: sale.id },
      include: saleInclude,
    });
  });
}

/**
 * Enregistre un versement d'un client sur une vente (remboursement d'une
 * créance). Le paiement est historisé et le montant payé de la vente est
 * augmenté dans la même transaction : reste = total − somme des paiements.
 * Le chiffre d'affaires n'est pas touché, seul l'encaissé augmente.
 */
export async function addSalePayment(context: AuthContext, saleId: number, amount: number, modePaiement: PaymentMethod = PaymentMethod.CASH, idempotencyKey?: string): Promise<SaleWithDetails> {
  const { organizationId, userId } = context;
  const montant = new Prisma.Decimal(amount).toDecimalPlaces(2);
  if (!montant.greaterThan(0)) throw Errors.conflict("Le montant doit être supérieur à 0.");

  return prisma.$transaction(async (tx) => {
    if (idempotencyKey) {
      const priorPayment = await tx.paiementVente.findFirst({ where: { venteId: saleId, cleIdempotence: idempotencyKey,
        vente: { organisationId: organizationId, ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : {}) } }, include: { vente: true } });
      if (priorPayment) {
        if (!priorPayment.montant.equals(montant) || priorPayment.modePaiement !== modePaiement) throw Errors.conflict("Cette clé d’idempotence a déjà servi pour un autre paiement.");
        return tx.vente.findUniqueOrThrow({ where: { id: saleId }, include: saleInclude });
      }
    }
    const sale = await tx.vente.findFirst({
      where: {
        id: saleId,
        organisationId: organizationId,
        // Un membre limité à une boutique n'encaisse que les ventes de sa boutique.
        ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : {}),
      },
      select: { id: true, statut: true, total: true, montantPaye: true },
    });
    if (!sale) throw Errors.notFound("Vente introuvable");
    if (sale.statut === SaleStatus.CANCELLED) {
      throw Errors.conflict("Cette vente est annulée : aucun paiement ne peut être enregistré.");
    }

    const remaining = remainingOf(sale);
    if (remaining.isZero()) throw Errors.conflict("Cette vente est déjà réglée.");
    if (montant.greaterThan(remaining)) {
      throw Errors.conflict(`Le montant dépasse le reste à payer (${remaining.toNumber().toLocaleString("fr-FR")}).`);
    }

    // Mise à jour conditionnelle : si un autre paiement a été enregistré entre
    // la lecture et l'écriture, rien n'est modifié et l'utilisateur réessaie.
    const updated = await tx.vente.updateMany({
      where: { id: sale.id, montantPaye: sale.montantPaye, statut: SaleStatus.COMPLETED },
      data: { montantPaye: { increment: montant } },
    });
    if (updated.count !== 1) {
      throw Errors.conflict("La vente vient d'être modifiée. Rechargez la page puis réessayez.");
    }

    await tx.paiementVente.create({ data: { venteId: sale.id, montant, modePaiement, cleIdempotence: idempotencyKey, utilisateurId: userId } });

    return tx.vente.findUniqueOrThrow({ where: { id: sale.id }, include: saleInclude });
  });
}

export async function createRefundRequest(context: AuthContext, saleId: number, amount: number, motif: string, key: string) {
  const amountDecimal = new Prisma.Decimal(amount).toDecimalPlaces(2);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Vente" WHERE "id" = ${saleId} AND "organisationId" = ${context.organizationId} FOR UPDATE`;
    const sale = await tx.vente.findFirst({ where: { id: saleId, organisationId: context.organizationId,
      ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : {}) }, include: { paiements: true, remboursements: { include: { versements: true } } } });
    if (!sale) throw Errors.notFound("Vente introuvable");
    const duplicate = await tx.remboursementVente.findUnique({ where: { venteId_cleIdempotence: { venteId: saleId, cleIdempotence: key } } });
    if (duplicate) {
      if (!duplicate.montant.equals(amountDecimal) || duplicate.motif !== motif) throw Errors.conflict("Cette clé d’idempotence a déjà servi pour une autre demande.");
      return duplicate;
    }
    if (sale.statut !== SaleStatus.COMPLETED) throw Errors.conflict("Une vente annulée ne peut pas recevoir une nouvelle demande de remboursement.");
    const prior = sale.remboursements.reduce((sum, item) => sum.plus(item.montant), new Prisma.Decimal(0));
    const received = sale.paiements.reduce((sum, item) => sum.plus(item.montant), new Prisma.Decimal(0));
    if (prior.plus(amountDecimal).greaterThan(received)) throw Errors.conflict("Le remboursement dépasse le montant réellement encaissé.");
    return tx.remboursementVente.create({ data: { venteId: sale.id, montant: amountDecimal, motif,
      cleIdempotence: key, demandeParId: context.userId } });
  });
}

export async function payRefund(context: AuthContext, refundId: number, amount: number, modePaiement: PaymentMethod, key: string) {
  const montant = new Prisma.Decimal(amount).toDecimalPlaces(2);
  return prisma.$transaction(async (tx) => {
    const initial = await tx.remboursementVente.findFirst({ where: { id: refundId,
      vente: { organisationId: context.organizationId, ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : {}) } }, select: { venteId: true } });
    if (!initial) throw Errors.notFound("Remboursement introuvable");
    await tx.$queryRaw`SELECT "id" FROM "Vente" WHERE "id" = ${initial.venteId} FOR UPDATE`;
    const refund = await tx.remboursementVente.findUniqueOrThrow({ where: { id: refundId }, include: { versements: true } });
    const duplicate = refund.versements.find((item) => item.cleIdempotence === key);
    if (duplicate) {
      if (!duplicate.montant.equals(montant) || duplicate.modePaiement !== modePaiement) throw Errors.conflict("Cette clé d’idempotence a déjà servi pour un autre versement.");
      return refund;
    }
    const paid = refund.versements.reduce((sum, item) => sum.plus(item.montant), new Prisma.Decimal(0));
    const remaining = refund.montant.minus(paid);
    if (!montant.greaterThan(0) || montant.greaterThan(remaining)) throw Errors.conflict("Le versement dépasse le solde du remboursement.");
    await tx.versementRemboursement.create({ data: { remboursementVenteId: refundId, montant, modePaiement,
      cleIdempotence: key, utilisateurId: context.userId } });
    const status = montant.equals(remaining) ? "COMPLETED" : "PARTIALLY_REFUNDED";
    return tx.remboursementVente.update({ where: { id: refundId }, data: { statut: status }, include: { versements: true } });
  });
}
