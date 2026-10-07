import { prisma } from "@/lib/prisma";
import { Errors } from "@/lib/api/errors";
import { StockMovementType } from "@/generated/prisma/enums";
import type { ProductFormData } from "@/lib/validations/product";
import type { AuthContext } from "@/lib/auth/session";

/**
 * Crée un produit dans le catalogue de l'organisation et initialise son
 * stock. Une ligne Stock à zéro est créée pour chaque boutique de
 * l'organisation, pour que les requêtes d'inventaire et de stock bas n'aient
 * jamais à deviner ce que signifie une ligne manquante.
 */
export async function createProduct(context: AuthContext, storeId: number, data: ProductFormData) {
  const { organizationId, userId } = context;

  const stores = await prisma.boutique.findMany({
    where: { organisationId: organizationId },
    select: { id: true },
  });
  if (!stores.some((store) => store.id === storeId)) {
    throw Errors.forbidden("Boutique invalide");
  }

  if (data.categorieId) {
    const category = await prisma.categorie.findFirst({
      where: { id: data.categorieId, organisationId: organizationId },
      select: { id: true },
    });
    if (!category) throw Errors.notFound("Catégorie introuvable");
  }

  const initialQuantity = data.quantiteInitiale ?? 0;

  return prisma.$transaction(async (tx) => {
    const product = await tx.produit.create({
      data: {
        organisationId: organizationId,
        categorieId: data.categorieId ?? null,
        nom: data.nom,
        description: data.description || null,
        reference: data.reference || null,
        codeBarres: data.codeBarres || null,
        unite: data.unite,
        prixAchat: data.prixAchat,
        prixVente: data.prixVente,
        seuilAlerte: data.seuilAlerte,
      },
    });

    await tx.stock.createMany({
      data: stores.map((store) => ({
        boutiqueId: store.id,
        produitId: product.id,
        quantite: store.id === storeId ? initialQuantity : 0,
      })),
    });

    if (initialQuantity > 0) {
      await tx.mouvementStock.create({
        data: {
          boutiqueId: storeId,
          produitId: product.id,
          utilisateurId: userId,
          type: StockMovementType.INITIAL,
          variationQuantite: initialQuantity,
          note: "Stock initial à la création du produit",
        },
      });
    }

    return product;
  });
}

export async function updateProduct(
  context: AuthContext,
  productId: number,
  data: Omit<ProductFormData, "quantiteInitiale">,
) {
  const { organizationId } = context;

  if (data.categorieId) {
    const category = await prisma.categorie.findFirst({
      where: { id: data.categorieId, organisationId: organizationId },
      select: { id: true },
    });
    if (!category) throw Errors.notFound("Catégorie introuvable");
  }

  const updated = await prisma.produit.updateMany({
    where: { id: productId, organisationId: organizationId },
    data: {
      nom: data.nom,
      // Champs absents du formulaire : laissés tels quels s'ils ne sont pas envoyés.
      description: data.description === undefined ? undefined : data.description || null,
      reference: data.reference === undefined ? undefined : data.reference || null,
      codeBarres: data.codeBarres === undefined ? undefined : data.codeBarres || null,
      unite: data.unite,
      categorieId: data.categorieId ?? null,
      prixAchat: data.prixAchat,
      prixVente: data.prixVente,
      seuilAlerte: data.seuilAlerte,
      actif: data.actif ?? true,
    },
  });

  if (updated.count === 0) throw Errors.notFound("Produit introuvable");

  return prisma.produit.findUnique({ where: { id: productId } });
}

export async function deleteProduct(context: AuthContext, productId: number) {
  const deleted = await prisma.produit.deleteMany({
    where: { id: productId, organisationId: context.organizationId },
  });
  if (deleted.count === 0) throw Errors.notFound("Produit introuvable");
}
