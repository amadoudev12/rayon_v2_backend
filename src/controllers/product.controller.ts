import type { Request, Response } from "express";
import * as productService from "@/services/product";
import { prisma } from "@/lib/prisma";
import { containsText } from "@/lib/search";
import { requirePermission, resolveActiveStoreId } from "@/lib/auth/session";
import { getActiveStoreId } from "@/lib/auth/store";
import { productImportSchema, productSchema } from "@/lib/validations/product";
import { SaleStatus } from "@/generated/prisma/enums";
import { jsonData, jsonMessage, jsonPage, routeId, searchParams } from "@/lib/api/response";
import { getPagination, getSort, paginationMeta } from "@/lib/api/pagination";
import { Errors } from "@/lib/api/errors";

const SORT_FIELDS = ["creeLe", "nom", "prixVente"] as const;

export async function getAllProducts(req: Request, res: Response) {
  const context = req.user;
  const params = searchParams(req);

  const storeId = await resolveActiveStoreId(context, Number(params.get("storeId")) || undefined);
  const search = params.get("search")?.trim() ?? "";
  const categoryId = Number(params.get("categoryId")) || undefined;
  const status = params.get("status"); // "active" | "archived" | null (all)
  const pagination = getPagination(params);
  const { sort, order } = getSort(params, SORT_FIELDS, "creeLe");

  const where = {
    organisationId: context.organizationId,
    ...(categoryId ? { categorieId: categoryId } : {}),
    ...(status === "active" ? { actif: true } : status === "archived" ? { actif: false } : {}),
    ...(search
      ? {
          OR: [
            { nom: containsText(search) },
            { reference: containsText(search) },
            { codeBarres: containsText(search) },
          ],
        }
      : {}),
  };

  const [products, total] = await Promise.all([
    prisma.produit.findMany({
      where,
      orderBy: { [sort]: order },
      skip: (pagination.page - 1) * pagination.limit,
      take: pagination.limit,
      include: {
        categorie: { select: { id: true, nom: true } },
        stocks: { where: { boutiqueId: storeId }, select: { quantite: true } },
      },
    }),
    prisma.produit.count({ where }),
  ]);

  const data = products.map(({ stocks, ...product }) => ({
    ...product,
    quantiteStock: stocks[0]?.quantite ?? 0,
  }));

  return jsonPage(res, data, paginationMeta(pagination, total));
}

export async function createProduct(req: Request, res: Response) {
  const context = req.user;

  const parsed = productSchema.parse(req.body);
  // Le stock initial va dans la boutique demandée explicitement (mobile),
  // sinon dans la boutique active de l'utilisateur (sélecteur du web).
  const requestedStoreId = Number(searchParams(req).get("storeId")) || undefined;
  const storeId = requestedStoreId
    ? await resolveActiveStoreId(context, requestedStoreId)
    : await getActiveStoreId(context);
  const product = await productService.createProduct(context, storeId, parsed);

  return jsonData(res, product, { status: 201 });
}

// Import d'une liste de produits lue dans un fichier Excel : le site lit le
// fichier et envoie ses lignes ; le stock initial suit la même règle de
// boutique que la création d'un produit.
export async function importProducts(req: Request, res: Response) {
  const context = req.user;

  const parsed = productImportSchema.parse(req.body);
  // Les catégories absentes du catalogue sont créées par l'import.
  if (parsed.lignes.some((row) => row.categorie)) requirePermission(context, "category:manage");

  const requestedStoreId = Number(searchParams(req).get("storeId")) || undefined;
  const storeId = requestedStoreId
    ? await resolveActiveStoreId(context, requestedStoreId)
    : await getActiveStoreId(context);
  const result = await productService.importProducts(context, storeId, parsed.lignes);

  return jsonData(res, result, { status: 201 });
}

export async function getProductById(req: Request, res: Response) {
  const context = req.user;
  const productId = routeId(req);

  // Boutique demandée explicitement, sinon la boutique active de l'utilisateur.
  const requestedStoreId = Number(searchParams(req).get("storeId")) || undefined;
  const storeId = requestedStoreId
    ? await resolveActiveStoreId(context, requestedStoreId)
    : await getActiveStoreId(context);

  // Un membre limité à une boutique ne voit que le stock, les mouvements et
  // les ventes de sa boutique.
  const storeFilter = context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : {};

  const product = await prisma.produit.findFirst({
    where: { id: productId, organisationId: context.organizationId },
    include: {
      categorie: { select: { id: true, nom: true } },
      stocks: {
        where: storeFilter,
        select: { quantite: true, boutique: { select: { id: true, nom: true } } },
        orderBy: { boutique: { nom: "asc" } },
      },
      mouvementsStock: {
        where: storeFilter,
        orderBy: { creeLe: "desc" },
        take: 5,
        select: {
          id: true,
          type: true,
          variationQuantite: true,
          note: true,
          creeLe: true,
          boutique: { select: { nom: true } },
          utilisateur: { select: { prenom: true, nom: true } },
        },
      },
    },
  });
  if (!product) throw Errors.notFound("Produit introuvable");

  // Ventes terminées uniquement : les ventes annulées ne comptent pas.
  const sales = await prisma.ligneVente.aggregate({
    where: {
      produitId: productId,
      vente: { organisationId: context.organizationId, statut: SaleStatus.COMPLETED, ...storeFilter },
    },
    _sum: { quantite: true, sousTotal: true },
    _count: true,
  });

  return jsonData(res, {
    ...product,
    quantiteStock: product.stocks.find((stock) => stock.boutique.id === storeId)?.quantite ?? 0,
    ventes: {
      nombre: sales._count,
      quantite: sales._sum.quantite ?? 0,
      montant: sales._sum.sousTotal ?? 0,
    },
  });
}

export async function updateProduct(req: Request, res: Response) {
  const context = req.user;

  const productId = routeId(req);

  const parsed = productSchema.parse(req.body);
  const product = await productService.updateProduct(context, productId, parsed);

  return jsonData(res, product);
}

export async function deleteProduct(req: Request, res: Response) {
  const context = req.user;

  const productId = routeId(req);

  await productService.deleteProduct(context, productId);
  return jsonMessage(res, "Produit supprimé");
}
