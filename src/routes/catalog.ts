import { Router } from "express";
import { prisma } from "@/lib/prisma";
import { containsText } from "@/lib/search";
import { requireAuthContext, requirePermission, resolveActiveStoreId } from "@/lib/auth/session";
import { getActiveStoreId } from "@/lib/auth/store";
import { categorySchema, productSchema, stockAdjustmentSchema } from "@/lib/validations/product";
import { createProduct, deleteProduct, updateProduct } from "@/lib/services/product";
import { adjustStock } from "@/lib/services/stock";
import { SaleStatus } from "@/generated/prisma/enums";
import { apiRoute, jsonData, jsonMessage, jsonPage, routeId, searchParams } from "@/lib/api/response";
import { getPagination, getSort, paginationMeta } from "@/lib/api/pagination";
import { Errors } from "@/lib/api/errors";

export const catalogRouter = Router();

// ---------------------------------------------------------------------------
// Catégories
// ---------------------------------------------------------------------------

catalogRouter.get(
  "/categories",
  apiRoute(async (_req, res) => {
    const context = await requireAuthContext();

    const categories = await prisma.categorie.findMany({
      where: { organisationId: context.organizationId },
      orderBy: { nom: "asc" },
      include: { _count: { select: { produits: true } } },
    });

    return jsonData(res, categories);
  }),
);

catalogRouter.post(
  "/categories",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    requirePermission(context, "category:manage");

    const parsed = categorySchema.parse(req.body);
    const category = await prisma.categorie.create({
      data: {
        organisationId: context.organizationId,
        nom: parsed.nom,
        description: parsed.description || null,
      },
    });

    return jsonData(res, category, { status: 201 });
  }),
);

catalogRouter.put(
  "/categories/:id",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    requirePermission(context, "category:manage");

    const categoryId = routeId(req);

    const parsed = categorySchema.parse(req.body);
    const updated = await prisma.categorie.updateMany({
      where: { id: categoryId, organisationId: context.organizationId },
      data: { nom: parsed.nom, description: parsed.description || null },
    });
    if (updated.count === 0) throw Errors.notFound("Catégorie introuvable");

    const category = await prisma.categorie.findUnique({ where: { id: categoryId } });
    return jsonData(res, category);
  }),
);

catalogRouter.delete(
  "/categories/:id",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    requirePermission(context, "category:manage");

    const categoryId = routeId(req);

    const deleted = await prisma.categorie.deleteMany({
      where: { id: categoryId, organisationId: context.organizationId },
    });
    if (deleted.count === 0) throw Errors.notFound("Catégorie introuvable");

    return jsonMessage(res, "Catégorie supprimée");
  }),
);

// ---------------------------------------------------------------------------
// Produits
// ---------------------------------------------------------------------------

const SORT_FIELDS = ["creeLe", "nom", "prixVente"] as const;

catalogRouter.get(
  "/products",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
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
  }),
);

catalogRouter.post(
  "/products",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    requirePermission(context, "product:manage");

    const parsed = productSchema.parse(req.body);
    // Le stock initial va dans la boutique demandée explicitement (mobile),
    // sinon dans la boutique active de l'utilisateur (sélecteur du web).
    const requestedStoreId = Number(searchParams(req).get("storeId")) || undefined;
    const storeId = requestedStoreId
      ? await resolveActiveStoreId(context, requestedStoreId)
      : await getActiveStoreId(context);
    const product = await createProduct(context, storeId, parsed);

    return jsonData(res, product, { status: 201 });
  }),
);

catalogRouter.get(
  "/products/:id",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
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
  }),
);

catalogRouter.put(
  "/products/:id",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    requirePermission(context, "product:manage");

    const productId = routeId(req);

    const parsed = productSchema.parse(req.body);
    const product = await updateProduct(context, productId, parsed);

    return jsonData(res, product);
  }),
);

catalogRouter.delete(
  "/products/:id",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    requirePermission(context, "product:manage");

    const productId = routeId(req);

    await deleteProduct(context, productId);
    return jsonMessage(res, "Produit supprimé");
  }),
);

catalogRouter.post(
  "/products/:id/stock",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    requirePermission(context, "stock:adjust");

    const productId = routeId(req);

    const body = req.body as { boutiqueId?: unknown } | undefined;
    const parsed = stockAdjustmentSchema.parse(body);
    const storeId = await resolveActiveStoreId(context, body?.boutiqueId ? Number(body.boutiqueId) : undefined);

    const stock = await adjustStock(context, storeId, productId, parsed);
    return jsonData(res, stock);
  }),
);

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

catalogRouter.get(
  "/stock",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    const params = searchParams(req);

    const storeId = await resolveActiveStoreId(context, Number(params.get("storeId")) || undefined);
    const search = params.get("search")?.trim() ?? "";
    const lowStockOnly = params.get("lowStock") === "true";
    const pagination = getPagination(params);

    const where = {
      boutiqueId: storeId,
      produit: {
        organisationId: context.organizationId,
        actif: true,
        ...(search ? { nom: containsText(search) } : {}),
      },
    };

    const [stocks, total] = await Promise.all([
      prisma.stock.findMany({
        where,
        include: { produit: { select: { id: true, nom: true, unite: true, seuilAlerte: true, prixVente: true } } },
        orderBy: { quantite: "asc" },
        skip: (pagination.page - 1) * pagination.limit,
        take: pagination.limit,
      }),
      prisma.stock.count({ where }),
    ]);

    const filtered = lowStockOnly ? stocks.filter((stock) => stock.quantite <= stock.produit.seuilAlerte) : stocks;

    return jsonPage(res, filtered, paginationMeta(pagination, lowStockOnly ? filtered.length : total));
  }),
);

catalogRouter.get(
  "/stock/movements",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    const params = searchParams(req);

    const storeId = await resolveActiveStoreId(context, Number(params.get("storeId")) || undefined);
    const productId = Number(params.get("productId")) || undefined;
    const pagination = getPagination(params, 30);

    const where = { boutiqueId: storeId, ...(productId ? { produitId: productId } : {}) };

    const [movements, total] = await Promise.all([
      prisma.mouvementStock.findMany({
        where,
        include: {
          produit: { select: { id: true, nom: true, unite: true } },
          utilisateur: { select: { prenom: true, nom: true } },
        },
        orderBy: { creeLe: "desc" },
        skip: (pagination.page - 1) * pagination.limit,
        take: pagination.limit,
      }),
      prisma.mouvementStock.count({ where }),
    ]);

    return jsonPage(res, movements, paginationMeta(pagination, total));
  }),
);
