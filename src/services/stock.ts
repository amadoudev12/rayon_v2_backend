import { Prisma } from "@/generated/prisma/client";
import { StockMovementType } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { Errors } from "@/lib/api/errors";
import { recordAuditLog } from "@/lib/api/audit";
import { runTransaction } from "@/lib/transactions";
import type { AuthContext } from "@/lib/auth/session";
import type { StockAdjustmentFormData } from "@/lib/validations/product";

/**
 * Applique une correction manuelle de stock et l'enregistre dans l'historique
 * immuable des mouvements, avec sa trace d'audit (même transaction).
 *
 * - Variation appliquée en SQL (`quantite = quantite + Δ`) : deux ajustements
 *   simultanés s'additionnent au lieu de s'écraser.
 * - Le stock d'une boutique ne passe jamais sous zéro.
 * - Idempotent : la même clé renvoie le mouvement déjà enregistré (double
 *   clic, nouvel essai après une coupure réseau) ; réutilisée avec d'autres
 *   données, elle est refusée.
 * - Le mouvement est valorisé au coût d'achat courant, comme une perte.
 */
export async function adjustStock(
  context: AuthContext,
  storeId: number,
  productId: number,
  data: StockAdjustmentFormData,
  idempotencyKey: string,
) {
  const { organizationId, userId } = context;

  const product = await prisma.produit.findFirst({
    where: { id: productId, organisationId: organizationId },
    select: { id: true, nom: true, prixAchat: true },
  });
  if (!product) throw Errors.notFound("Produit introuvable");

  const store = await prisma.boutique.findFirst({
    where: { id: storeId, organisationId: organizationId },
    select: { id: true },
  });
  if (!store) throw Errors.forbidden("Boutique invalide");

  const note = data.note?.trim() || null;

  const replay = async () => {
    const existing = await prisma.mouvementStock.findUnique({
      where: { boutiqueId_cleIdempotence: { boutiqueId: storeId, cleIdempotence: idempotencyKey } },
    });
    if (!existing) return null;
    const sameRequest =
      existing.type === StockMovementType.ADJUSTMENT &&
      existing.produitId === productId &&
      existing.variationQuantite === data.variationQuantite &&
      existing.note === note;
    if (!sameRequest) throw Errors.conflict("Cette clé d'idempotence a déjà été utilisée avec d'autres données.");
    return prisma.stock.findUniqueOrThrow({ where: { boutiqueId_produitId: { boutiqueId: storeId, produitId: productId } } });
  };

  const previous = await replay();
  if (previous) return previous;

  try {
    return await runTransaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "Stock" ("boutiqueId", "produitId", "quantite", "modifieLe")
        VALUES (${storeId}, ${productId}, 0, NOW())
        ON CONFLICT ("boutiqueId", "produitId") DO NOTHING`;
      const changed = await tx.$queryRaw<Array<{ quantite: number }>>`
        UPDATE "Stock"
        SET "quantite" = "quantite" + ${data.variationQuantite}, "modifieLe" = NOW()
        WHERE "boutiqueId" = ${storeId}
          AND "produitId" = ${productId}
          AND "quantite" + ${data.variationQuantite} >= 0
        RETURNING "quantite"`;
      if (changed.length !== 1) throw Errors.conflict("Cet ajustement ferait passer le stock sous zéro.");
      const quantiteApres = changed[0]!.quantite;
      const quantiteAvant = quantiteApres - data.variationQuantite;

      const movement = await tx.mouvementStock.create({
        data: {
          boutiqueId: storeId,
          produitId: productId,
          utilisateurId: userId,
          type: StockMovementType.ADJUSTMENT,
          variationQuantite: data.variationQuantite,
          quantiteAvant,
          quantiteApres,
          coutUnitaire: product.prixAchat,
          cleIdempotence: idempotencyKey,
          creeLe: new Date(),
          note,
        },
      });

      await recordAuditLog(
        {
          organisationId: organizationId,
          utilisateurId: userId,
          action: "stock.adjusted",
          entite: "MouvementStock",
          entiteId: movement.id,
          metadonnees: {
            boutiqueId: storeId,
            produitId: productId,
            produit: product.nom,
            variation: data.variationQuantite,
            avant: quantiteAvant,
            apres: quantiteApres,
            note,
          },
        },
        tx,
      );

      return tx.stock.findUniqueOrThrow({ where: { boutiqueId_produitId: { boutiqueId: storeId, produitId: productId } } });
    });
  } catch (error) {
    // Deux envois simultanés de la même clé : le second voit l'index unique.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const replayed = await replay();
      if (replayed) return replayed;
    }
    throw error;
  }
}
