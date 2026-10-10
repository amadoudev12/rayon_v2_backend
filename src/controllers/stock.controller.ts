import type { Request, Response } from "express";
import * as stockService from "@/services/stock";
import { prisma } from "@/lib/prisma";
import { containsText } from "@/lib/search";
import { resolveActiveStoreId } from "@/lib/auth/session";
import { stockAdjustmentSchema } from "@/lib/validations/product";
import { jsonData, jsonPage, routeId, searchParams } from "@/lib/api/response";
import { getPagination, paginationMeta } from "@/lib/api/pagination";

export async function adjustStock(req: Request, res: Response) {
  const context = req.user;

  const productId = routeId(req);

  const body = req.body as { boutiqueId?: unknown } | undefined;
  const parsed = stockAdjustmentSchema.parse(body);
  const storeId = await resolveActiveStoreId(context, body?.boutiqueId ? Number(body.boutiqueId) : undefined);

  const stock = await stockService.adjustStock(context, storeId, productId, parsed);
  return jsonData(res, stock);
}

export async function getStock(req: Request, res: Response) {
  const context = req.user;
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
}

export async function getStockMovements(req: Request, res: Response) {
  const context = req.user;
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
}
