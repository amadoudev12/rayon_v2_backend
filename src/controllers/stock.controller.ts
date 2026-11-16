import type { Request, Response } from "express";
import * as stockService from "@/services/stock";
import { prisma } from "@/lib/prisma";
import { resolveRequestStoreId } from "@/lib/auth/store";
import { requireIdempotencyKey } from "@/lib/idempotency";
import { stockAdjustmentSchema } from "@/lib/validations/product";
import { stockThresholdSchema } from "@/lib/validations/inventory";
import { jsonData, jsonPage, routeId, searchParams } from "@/lib/api/response";
import { getPagination, paginationMeta } from "@/lib/api/pagination";
import { Errors } from "@/lib/api/errors";
import { recordAuditLog } from "@/lib/api/audit";
import { listStoreStock } from "@/services/stock-query";
import { movementFilters } from "@/services/stock-movements";
import * as stockReport from "@/services/stock-report";

/** Boutique demandée (`?storeId=`), sinon celle du sélecteur du site. */
function requestedStore(req: Request) {
  return resolveRequestStoreId(req.user, Number(searchParams(req).get("storeId")) || undefined);
}

export async function adjustStock(req: Request, res: Response) {
  const productId = routeId(req);
  const body = req.body as { boutiqueId?: unknown } | undefined;
  const parsed = stockAdjustmentSchema.parse(body);
  const storeId = await resolveRequestStoreId(req.user, Number(body?.boutiqueId) || undefined);
  const stock = await stockService.adjustStock(req.user, storeId, productId, parsed, requireIdempotencyKey(req));
  return jsonData(res, stock);
}

export async function getStock(req: Request, res: Response) {
  const params = searchParams(req);
  const storeId = await requestedStore(req);
  const pagination = getPagination(params);

  const { rows, total } = await listStoreStock({
    organisationId: req.user.organizationId,
    storeId,
    search: params.get("search") ?? "",
    lowStockOnly: params.get("lowStock") === "true",
    page: pagination.page,
    limit: pagination.limit,
  });
  return jsonPage(res, rows, paginationMeta(pagination, total));
}

export async function getStockMovements(req: Request, res: Response) {
  const pagination = getPagination(searchParams(req), 30);
  const { where } = await movementFilters(req.user, searchParams(req), { requirePeriod: false });

  const [movements, total] = await Promise.all([
    prisma.mouvementStock.findMany({
      where,
      include: {
        produit: { select: { id: true, nom: true, unite: true } },
        utilisateur: { select: { prenom: true, nom: true } },
      },
      orderBy: [{ creeLe: "desc" }, { id: "desc" }],
      skip: (pagination.page - 1) * pagination.limit,
      take: pagination.limit,
    }),
    prisma.mouvementStock.count({ where }),
  ]);

  return jsonPage(res, movements, paginationMeta(pagination, total));
}

/** Seuil d'alerte propre à une boutique (prioritaire sur le seuil du produit). */
export async function setThreshold(req: Request, res: Response) {
  const data = stockThresholdSchema.parse(req.body);
  const storeId = await resolveRequestStoreId(req.user, data.boutiqueId);
  const product = await prisma.produit.findFirst({
    where: { id: data.produitId, organisationId: req.user.organizationId },
    select: { id: true, nom: true },
  });
  if (!product) throw Errors.notFound("Produit introuvable.");

  const threshold = await prisma.seuilStockBoutique.upsert({
    where: { boutiqueId_produitId: { boutiqueId: storeId, produitId: data.produitId } },
    create: {
      organisationId: req.user.organizationId,
      boutiqueId: storeId,
      produitId: data.produitId,
      seuilAlerte: data.seuilAlerte,
    },
    update: { seuilAlerte: data.seuilAlerte },
  });
  await recordAuditLog({
    organisationId: req.user.organizationId,
    utilisateurId: req.user.userId,
    action: "stock.threshold_set",
    entite: "SeuilStockBoutique",
    entiteId: threshold.id,
    metadonnees: { boutiqueId: storeId, produit: product.nom, seuil: data.seuilAlerte },
  });
  return jsonData(res, threshold);
}

export async function getStockAlerts(req: Request, res: Response) {
  return jsonData(res, await stockReport.getStockAlerts(req.user, await requestedStore(req)));
}

export async function getStockValuation(req: Request, res: Response) {
  return jsonData(res, await stockReport.getStockValuation(req.user, await requestedStore(req)));
}
