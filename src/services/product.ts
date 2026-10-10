import { prisma } from "@/lib/prisma";
import { Errors } from "@/lib/api/errors";
import { StockMovementType } from "@/generated/prisma/enums";
import type { ProductFormData, ProductImportRow } from "@/lib/validations/product";
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

/** Comparaison des noms et références sans tenir compte de la casse ni des espaces en trop. */
function normalizeKey(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("fr");
}

export type ProductImportResult = {
  crees: number;
  categoriesCreees: number;
  ignores: { ligne: number; nom: string; raison: string }[];
};

/**
 * Crée en une fois les produits d'un fichier importé, avec les mêmes règles
 * que `createProduct` (une ligne Stock par boutique, mouvement INITIAL pour le
 * stock de départ). Les catégories sont retrouvées par leur nom et créées au
 * besoin.
 *
 * Un produit déjà présent dans le catalogue (même référence, ou même nom s'il
 * n'a pas de référence) est ignoré et non dupliqué : réimporter le même
 * fichier ne crée donc rien en double. Tout est écrit dans une seule
 * transaction : soit toutes les lignes retenues sont créées, soit aucune.
 */
export async function importProducts(
  context: AuthContext,
  storeId: number,
  rows: ProductImportRow[],
): Promise<ProductImportResult> {
  const { organizationId, userId } = context;

  const [stores, existingProducts, existingCategories] = await Promise.all([
    prisma.boutique.findMany({ where: { organisationId: organizationId }, select: { id: true } }),
    prisma.produit.findMany({ where: { organisationId: organizationId }, select: { nom: true, reference: true } }),
    prisma.categorie.findMany({ where: { organisationId: organizationId }, select: { id: true, nom: true } }),
  ]);
  if (!stores.some((store) => store.id === storeId)) {
    throw Errors.forbidden("Boutique invalide");
  }

  const knownNames = new Set(existingProducts.map((product) => normalizeKey(product.nom)));
  const knownReferences = new Set(
    existingProducts.flatMap((product) => (product.reference ? [normalizeKey(product.reference)] : [])),
  );
  const fileNames = new Set<string>();
  const fileReferences = new Set<string>();

  const ignores: ProductImportResult["ignores"] = [];
  const accepted: ProductImportRow[] = [];

  rows.forEach((row, index) => {
    const name = normalizeKey(row.nom);
    const reference = row.reference ? normalizeKey(row.reference) : null;

    let raison: string | null = null;
    if (reference) {
      if (knownReferences.has(reference)) raison = "Référence déjà utilisée par un produit du catalogue";
      else if (fileReferences.has(reference)) raison = "Référence en double dans le fichier";
    } else if (knownNames.has(name)) {
      raison = "Produit déjà présent dans le catalogue";
    } else if (fileNames.has(name)) {
      raison = "Produit en double dans le fichier";
    }

    if (raison) {
      ignores.push({ ligne: row.ligne ?? index + 1, nom: row.nom, raison });
      return;
    }
    if (reference) fileReferences.add(reference);
    else fileNames.add(name);
    accepted.push(row);
  });

  if (accepted.length === 0) return { crees: 0, categoriesCreees: 0, ignores };

  const categoryIds = new Map(existingCategories.map((category) => [normalizeKey(category.nom), category.id]));
  const newCategories = new Map<string, string>();
  for (const row of accepted) {
    if (!row.categorie) continue;
    const key = normalizeKey(row.categorie);
    if (!categoryIds.has(key) && !newCategories.has(key)) newCategories.set(key, row.categorie);
  }

  // Une ligne retenue est identifiée par sa référence, sinon par son nom : les
  // doublons ayant été écartés, cette clé retrouve le produit créé.
  const rowKey = (row: { nom: string; reference?: string | null }) =>
    row.reference ? `ref:${normalizeKey(row.reference)}` : `nom:${normalizeKey(row.nom)}`;

  await prisma.$transaction(async (tx) => {
    if (newCategories.size > 0) {
      const created = await tx.categorie.createManyAndReturn({
        data: [...newCategories.values()].map((nom) => ({ organisationId: organizationId, nom })),
        select: { id: true, nom: true },
      });
      for (const category of created) categoryIds.set(normalizeKey(category.nom), category.id);
    }

    const products = await tx.produit.createManyAndReturn({
      data: accepted.map((row) => ({
        organisationId: organizationId,
        categorieId: row.categorie ? (categoryIds.get(normalizeKey(row.categorie)) ?? null) : null,
        nom: row.nom,
        description: row.description || null,
        reference: row.reference || null,
        codeBarres: row.codeBarres || null,
        unite: row.unite,
        prixAchat: row.prixAchat,
        prixVente: row.prixVente,
        seuilAlerte: row.seuilAlerte,
      })),
      select: { id: true, nom: true, reference: true },
    });

    const quantities = new Map(accepted.map((row) => [rowKey(row), row.quantiteInitiale ?? 0]));
    const initialStocks = products.map((product) => ({
      produitId: product.id,
      quantite: quantities.get(rowKey(product)) ?? 0,
    }));

    await tx.stock.createMany({
      data: initialStocks.flatMap(({ produitId, quantite }) =>
        stores.map((store) => ({
          boutiqueId: store.id,
          produitId,
          quantite: store.id === storeId ? quantite : 0,
        })),
      ),
    });

    const movements = initialStocks.filter(({ quantite }) => quantite > 0);
    if (movements.length > 0) {
      await tx.mouvementStock.createMany({
        data: movements.map(({ produitId, quantite }) => ({
          boutiqueId: storeId,
          produitId,
          utilisateurId: userId,
          type: StockMovementType.INITIAL,
          variationQuantite: quantite,
          note: "Stock initial à l'import du produit",
        })),
      });
    }
  });

  return { crees: accepted.length, categoriesCreees: newCategories.size, ignores };
}
