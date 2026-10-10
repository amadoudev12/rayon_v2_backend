import { prisma } from "@/lib/prisma";
import { Errors } from "@/lib/api/errors";
import { StockMovementType } from "@/generated/prisma/enums";
import { Prisma } from "@/generated/prisma/client";
import { sumDecimals } from "@/lib/money";
import type { AuthContext } from "@/lib/auth/session";
import type { PurchaseFormData } from "@/lib/validations/purchase";

const purchaseInclude = {
  lignes: { include: { produit: { select: { id: true, nom: true, unite: true } } } },
  fournisseur: { select: { id: true, nom: true } },
} satisfies Prisma.AchatInclude;

export type PurchaseWithDetails = Prisma.AchatGetPayload<{ include: typeof purchaseInclude }>;

/**
 * Enregistre une livraison fournisseur : le stock est augmenté immédiatement
 * (réception à la saisie, sans étape « en attente ») et un mouvement de stock
 * est journalisé par ligne.
 */
export async function createPurchase(
  context: AuthContext,
  storeId: number,
  data: PurchaseFormData,
): Promise<PurchaseWithDetails> {
  const { organizationId, userId } = context;

  const products = await prisma.produit.findMany({
    where: { id: { in: data.lignes.map((line) => line.produitId) }, organisationId: organizationId },
    select: { id: true, nom: true },
  });
  const productsById = new Map(products.map((product) => [product.id, product]));
  if (productsById.size !== new Set(data.lignes.map((line) => line.produitId)).size) {
    throw Errors.notFound("Un ou plusieurs produits sont introuvables");
  }

  if (data.fournisseurId) {
    const supplier = await prisma.fournisseur.findFirst({
      where: { id: data.fournisseurId, organisationId: organizationId },
      select: { id: true },
    });
    if (!supplier) throw Errors.notFound("Fournisseur introuvable");
  }

  const lines = data.lignes.map((line) => ({
    ...line,
    produit: productsById.get(line.produitId)!,
    sousTotal: new Prisma.Decimal(line.coutUnitaire).times(line.quantite),
  }));
  const total = sumDecimals(lines.map((line) => line.sousTotal));

  return prisma.$transaction(async (tx) => {
    const purchase = await tx.achat.create({
      data: {
        organisationId: organizationId,
        boutiqueId: storeId,
        fournisseurId: data.fournisseurId ?? null,
        creeParId: userId,
        total,
        note: data.note || null,
        lignes: {
          create: lines.map((line) => ({
            produitId: line.produitId,
            quantite: line.quantite,
            coutUnitaire: line.coutUnitaire,
            sousTotal: line.sousTotal,
          })),
        },
      },
      include: purchaseInclude,
    });

    for (const line of lines) {
      await tx.stock.upsert({
        where: { boutiqueId_produitId: { boutiqueId: storeId, produitId: line.produitId } },
        create: { boutiqueId: storeId, produitId: line.produitId, quantite: line.quantite },
        update: { quantite: { increment: line.quantite } },
      });
    }

    await tx.mouvementStock.createMany({
      data: lines.map((line) => ({
        boutiqueId: storeId,
        produitId: line.produitId,
        utilisateurId: userId,
        type: StockMovementType.PURCHASE,
        variationQuantite: line.quantite,
        achatId: purchase.id,
      })),
    });

    return purchase;
  });
}
