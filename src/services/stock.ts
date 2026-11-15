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
    // Atomic delta prevents concurrent adjustments from overwriting one another.
    // The predicate also rejects a negative result when two removals race.
    await tx.$executeRaw`INSERT INTO "Stock" ("boutiqueId", "produitId", "quantite", "modifieLe")
      VALUES (${storeId}, ${productId}, 0, NOW()) ON CONFLICT ("boutiqueId", "produitId") DO NOTHING`;
    const changed = await tx.$queryRaw<Array<{ id: number; quantite: number }>>`UPDATE "Stock" SET "quantite" = "quantite" + ${data.variationQuantite}, "modifieLe" = NOW()
      WHERE "boutiqueId" = ${storeId} AND "produitId" = ${productId} AND "quantite" + ${data.variationQuantite} >= 0
      RETURNING "id", "quantite"`;
    if (changed.length !== 1) throw Errors.conflict("Cet ajustement ferait passer le stock sous zéro.");
    const quantiteApres = changed[0]!.quantite;
    const stock = await tx.stock.findUniqueOrThrow({ where: { boutiqueId_produitId: { boutiqueId: storeId, produitId: productId } } });

    await tx.mouvementStock.create({
      data: {
        boutiqueId: storeId,
        produitId: productId,
        utilisateurId: userId,
        type: StockMovementType.ADJUSTMENT,
        variationQuantite: data.variationQuantite,
        quantiteAvant: quantiteApres - data.variationQuantite,
        quantiteApres,
        creeLe: new Date(),
        note: data.note || null,
      },
    });

    return stock;
  });
}
