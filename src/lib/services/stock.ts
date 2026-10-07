import { prisma } from "@/lib/prisma";
import { Errors } from "@/lib/api/errors";
import { StockMovementType } from "@/generated/prisma/enums";
import type { AuthContext } from "@/lib/auth/session";
import type { StockAdjustmentFormData } from "@/lib/validations/product";

/**
 * Applique une correction manuelle de stock (inventaire, casse, don, etc.) et
 * l'enregistre dans l'historique immuable des mouvements. Refuse de faire
 * passer le stock d'une boutique sous zéro.
 */
export async function adjustStock(
  context: AuthContext,
  storeId: number,
  productId: number,
  data: StockAdjustmentFormData,
) {
  const { organizationId, userId } = context;

  const product = await prisma.produit.findFirst({
    where: { id: productId, organisationId: organizationId },
    select: { id: true },
  });
  if (!product) throw Errors.notFound("Produit introuvable");

  const store = await prisma.boutique.findFirst({
    where: { id: storeId, organisationId: organizationId },
    select: { id: true },
  });
  if (!store) throw Errors.forbidden("Boutique invalide");

  return prisma.$transaction(async (tx) => {
    const existingStock = await tx.stock.findUnique({
      where: { boutiqueId_produitId: { boutiqueId: storeId, produitId: productId } },
    });
    const currentQuantity = existingStock?.quantite ?? 0;
    const nextQuantity = currentQuantity + data.variationQuantite;

    if (nextQuantity < 0) {
      throw Errors.conflict("Cet ajustement ferait passer le stock sous zéro.");
    }

    const stock = await tx.stock.upsert({
      where: { boutiqueId_produitId: { boutiqueId: storeId, produitId: productId } },
      create: { boutiqueId: storeId, produitId: productId, quantite: nextQuantity },
      update: { quantite: nextQuantity },
    });

    await tx.mouvementStock.create({
      data: {
        boutiqueId: storeId,
        produitId: productId,
        utilisateurId: userId,
        type: StockMovementType.ADJUSTMENT,
        variationQuantite: data.variationQuantite,
        note: data.note || null,
      },
    });

    return stock;
  });
}
