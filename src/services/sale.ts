import { prisma } from "@/lib/prisma";
import { Errors } from "@/lib/api/errors";
import { PaymentMethod, SaleStatus, StockMovementType } from "@/generated/prisma/enums";
import { Prisma } from "@/generated/prisma/client";
import { sumDecimals } from "@/lib/money";
import type { AuthContext } from "@/lib/auth/session";
import type { SaleFormData } from "@/lib/validations/sale";

const saleInclude = {
  lignes: { include: { produit: { select: { id: true, nom: true, unite: true } } } },
  client: { select: { id: true, nom: true } },
  vendeur: { select: { id: true, prenom: true, nom: true } },
  paiements: { orderBy: { date: "asc" } },
} satisfies Prisma.VenteInclude;

export type SaleWithDetails = Prisma.VenteGetPayload<{ include: typeof saleInclude }>;

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
 */
export async function createSale(
  context: AuthContext,
  storeId: number,
  data: SaleFormData,
): Promise<SaleWithDetails> {
  const { organizationId, userId } = context;

  const quantitiesByProduct = new Map<number, number>();
  for (const line of data.lignes) {
    quantitiesByProduct.set(line.produitId, (quantitiesByProduct.get(line.produitId) ?? 0) + line.quantite);
  }
  const lines = [...quantitiesByProduct].map(([produitId, quantite]) => ({ produitId, quantite }));

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

  return prisma.$transaction(async (tx) => {
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
      const sousTotal = produit.prixVente.times(line.quantite);
      return { ...line, produit, sousTotal };
    });

    for (const line of saleLines) {
      const updated = await tx.stock.updateMany({
        where: { boutiqueId: storeId, produitId: line.produitId, quantite: { gte: line.quantite } },
        data: { quantite: { decrement: line.quantite } },
      });
      if (updated.count !== 1) {
        throw Errors.conflict(`Stock insuffisant pour "${line.produit.nom}"`);
      }
    }

    const sousTotal = sumDecimals(saleLines.map((line) => line.sousTotal));
    const remise = new Prisma.Decimal(data.remise ?? 0);
    const totalBeforeFloor = sousTotal.minus(remise);
    const total = totalBeforeFloor.isNegative() ? new Prisma.Decimal(0) : totalBeforeFloor;
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
        lignes: {
          create: saleLines.map((line) => ({
            produitId: line.produitId,
            quantite: line.quantite,
            prixUnitaire: line.produit.prixVente,
            coutUnitaire: line.produit.prixAchat,
            sousTotal: line.sousTotal,
          })),
        },
        // Le paiement initial ouvre l'historique des paiements de la vente.
        paiements: montantPaye.isZero() ? undefined : { create: { montant: montantPaye, utilisateurId: userId } },
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
        venteId: sale.id,
      })),
    });

    return sale;
  });
}

/**
 * Annule une vente terminée : remet chaque ligne en stock et passe la vente
 * en CANCELLED. Ne peut pas être appliqué deux fois à la même vente.
 */
export async function cancelSale(context: AuthContext, saleId: number): Promise<SaleWithDetails> {
  const { organizationId, userId } = context;

  return prisma.$transaction(async (tx) => {
    const sale = await tx.vente.findFirst({
      where: { id: saleId, organisationId: organizationId },
      include: { lignes: true },
    });
    if (!sale) throw Errors.notFound("Vente introuvable");
    if (sale.statut === SaleStatus.CANCELLED) {
      throw Errors.conflict("Cette vente est déjà annulée.");
    }

    for (const line of sale.lignes) {
      await tx.stock.upsert({
        where: { boutiqueId_produitId: { boutiqueId: sale.boutiqueId, produitId: line.produitId } },
        create: { boutiqueId: sale.boutiqueId, produitId: line.produitId, quantite: line.quantite },
        update: { quantite: { increment: line.quantite } },
      });
    }

    await tx.mouvementStock.createMany({
      data: sale.lignes.map((line) => ({
        boutiqueId: sale.boutiqueId,
        produitId: line.produitId,
        utilisateurId: userId,
        type: StockMovementType.SALE_CANCELLATION,
        variationQuantite: line.quantite,
        venteId: sale.id,
        note: "Annulation de vente",
      })),
    });

    return tx.vente.update({
      where: { id: sale.id },
      data: { statut: SaleStatus.CANCELLED, annuleLe: new Date() },
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
export async function addSalePayment(context: AuthContext, saleId: number, amount: number): Promise<SaleWithDetails> {
  const { organizationId, userId } = context;
  const montant = new Prisma.Decimal(amount).toDecimalPlaces(2);
  if (!montant.greaterThan(0)) throw Errors.conflict("Le montant doit être supérieur à 0.");

  return prisma.$transaction(async (tx) => {
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

    await tx.paiementVente.create({ data: { venteId: sale.id, montant, utilisateurId: userId } });

    return tx.vente.findUniqueOrThrow({ where: { id: sale.id }, include: saleInclude });
  });
}
