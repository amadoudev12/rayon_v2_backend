import type { Request, Response } from "express";
import * as stockService from "@/services/stock";
import { prisma } from "@/lib/prisma";
import { containsText } from "@/lib/search";
import { resolveActiveStoreId } from "@/lib/auth/session";
import { stockAdjustmentSchema } from "@/lib/validations/product";
import { jsonData, jsonPage, routeId, searchParams } from "@/lib/api/response";
import { getPagination, paginationMeta } from "@/lib/api/pagination";
import { stockThresholdSchema } from "@/lib/validations/inventory";
import { Errors } from "@/lib/api/errors";
import { StockMovementType } from "@/generated/prisma/enums";
import { z } from "zod";

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
      ...(lowStockOnly ? {} : { skip: (pagination.page - 1) * pagination.limit, take: pagination.limit }),
    }),
    prisma.stock.count({ where }),
  ]);
  const thresholds = await prisma.seuilStockBoutique.findMany({ where: { boutiqueId: storeId, organisationId: context.organizationId } });
  const thresholdMap = new Map(thresholds.map((item) => [item.produitId, item.seuilAlerte]));
  const decorated = stocks.map((stock) => ({ ...stock, seuilAlerte: thresholdMap.get(stock.produitId) ?? stock.produit.seuilAlerte, niveau: stock.quantite <= 0 ? "OUT" : stock.quantite <= (thresholdMap.get(stock.produitId) ?? stock.produit.seuilAlerte) ? "LOW" : "NORMAL" }));
  const filtered = lowStockOnly ? decorated.filter((stock) => stock.niveau !== "NORMAL") : decorated;
  const pageRows = lowStockOnly ? filtered.slice((pagination.page - 1) * pagination.limit, pagination.page * pagination.limit) : filtered;

  return jsonPage(res, pageRows, paginationMeta(pagination, lowStockOnly ? filtered.length : total));
}

export async function getStockMovements(req: Request, res: Response) {
  const context = req.user;
  const params = searchParams(req);

  const storeId = await resolveActiveStoreId(context, Number(params.get("storeId")) || undefined);
  const productId = Number(params.get("productId")) || undefined;
  const pagination = getPagination(params, 30);

  const typeValue = params.get("type");
  const type = typeValue ? z.enum(StockMovementType).parse(typeValue) : undefined;
  const from = params.get("from") ? new Date(params.get("from")!) : undefined;
  const to = params.get("to") ? new Date(params.get("to")!) : undefined;
  const search = params.get("search")?.trim() ?? "";
  const userId = Number(params.get("userId")) || undefined;
  const sourceReference = params.get("source")?.trim() ?? "";
  const where = { boutiqueId: storeId, produit: { organisationId: context.organizationId, ...(search ? { nom: containsText(search) } : {}) }, ...(productId ? { produitId: productId } : {}), ...(userId ? { utilisateurId: userId } : {}), ...(sourceReference ? { sourceReference: { contains: sourceReference, mode: "insensitive" as const } } : {}), ...(type ? { type } : {}), ...(from || to ? { creeLe: { ...(from && !Number.isNaN(from.getTime()) ? { gte: from } : {}), ...(to && !Number.isNaN(to.getTime()) ? { lte: to } : {}) } } : {}) };

  const [movements, total] = await Promise.all([
    prisma.mouvementStock.findMany({
      where,
      include: {
        produit: { select: { id: true, nom: true, unite: true } },
        utilisateur: { select: { prenom: true, nom: true } },
        vente: { select: { id: true } },
        achat: { select: { id: true } },
      },
      orderBy: { creeLe: "desc" },
      skip: (pagination.page - 1) * pagination.limit,
      take: pagination.limit,
    }),
    prisma.mouvementStock.count({ where }),
  ]);

  return jsonPage(res, movements, paginationMeta(pagination, total));
}

export async function setThreshold(req: Request, res: Response) {
  const data = stockThresholdSchema.parse(req.body);
  const storeId = await resolveActiveStoreId(req.user, data.boutiqueId);
  const [store, product] = await Promise.all([
    prisma.boutique.findFirst({ where: { id: storeId, organisationId: req.user.organizationId }, select: { id: true } }),
    prisma.produit.findFirst({ where: { id: data.produitId, organisationId: req.user.organizationId }, select: { id: true } }),
  ]);
  if (!store || !product) throw Errors.notFound("Produit ou boutique introuvable.");
  const threshold = await prisma.seuilStockBoutique.upsert({ where: { boutiqueId_produitId: { boutiqueId: storeId, produitId: data.produitId } }, create: { organisationId: req.user.organizationId, boutiqueId: storeId, produitId: data.produitId, seuilAlerte: data.seuilAlerte }, update: { seuilAlerte: data.seuilAlerte } });
  return jsonData(res, threshold);
}

export async function getStockAlerts(req: Request, res: Response) {
  const context = req.user;
  const params = searchParams(req);
  const storeId = await resolveActiveStoreId(context, Number(params.get("storeId")) || undefined);
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [stocks, thresholds, lossGroups] = await Promise.all([
    prisma.stock.findMany({ where: { boutiqueId: storeId, produit: { organisationId: context.organizationId, actif: true } }, include: { produit: { select: { id: true, nom: true, unite: true, seuilAlerte: true, prixAchat: true } } }, orderBy: { quantite: "asc" } }),
    prisma.seuilStockBoutique.findMany({ where: { boutiqueId: storeId, organisationId: context.organizationId } }),
    prisma.perteStock.groupBy({ by: ["produitId"], where: { organisationId: context.organizationId, boutiqueId: storeId, statut: "ACTIVE", creeLe: { gte: cutoff } }, _count: { id: true }, _sum: { quantite: true } }),
  ]);
  const thresholdMap = new Map(thresholds.map((row) => [row.produitId, row.seuilAlerte]));
  const stockAlerts = stocks.map((row) => { const threshold = thresholdMap.get(row.produitId) ?? row.produit.seuilAlerte; return { type: "STOCK" as const, produitId: row.produitId, produit: row.produit.nom, quantite: row.quantite, seuilAlerte: threshold, niveau: row.quantite <= 0 ? "OUT" as const : row.quantite <= threshold ? "LOW" as const : "NORMAL" as const }; }).filter((row) => row.niveau !== "NORMAL");
  const repeatedProducts = lossGroups.filter((row) => row._count.id >= 3);
  const productDetails = await prisma.produit.findMany({ where: { organisationId: context.organizationId, id: { in: repeatedProducts.map((row) => row.produitId) } }, select: { id: true, nom: true, seuilAlerte: true } });
  const productById = new Map(productDetails.map((product) => [product.id, product]));
  const repeatedLossAlerts = repeatedProducts.flatMap((row) => { const product = productById.get(row.produitId); if (!product) return []; return [{ type: "REPEATED_LOSS" as const, produitId: row.produitId, produit: product.nom, quantite: row._sum.quantite ?? 0, seuilAlerte: thresholdMap.get(row.produitId) ?? product.seuilAlerte, niveau: "REPEATED_LOSS" as const, occurrences: row._count.id }]; });
  return jsonData(res, [...stockAlerts, ...repeatedLossAlerts]);
}

export async function getStockValuation(req: Request, res: Response) {
  const context = req.user;
  const storeId = await resolveActiveStoreId(context, Number(searchParams(req).get("storeId")) || undefined);
  const rows = await prisma.stock.findMany({ where: { boutiqueId: storeId, produit: { organisationId: context.organizationId, actif: true } }, include: { produit: { select: { id: true, nom: true, reference: true, unite: true, prixAchat: true } } }, orderBy: { produit: { nom: "asc" } } });
  const lines = rows.map(({ quantite, produit }) => ({ produitId: produit.id, produit: produit.nom, reference: produit.reference, unite: produit.unite, quantite, coutUnitaire: Number(produit.prixAchat), valeur: Math.round(quantite * Number(produit.prixAchat) * 100) / 100 }));
  return jsonData(res, { lignes: lines, quantiteTotale: lines.reduce((total, row) => total + row.quantite, 0), valeurTotale: Math.round(lines.reduce((total, row) => total + row.valeur, 0) * 100) / 100, methode: "Coût d'achat courant du produit (dernier coût enregistré)" });
}
