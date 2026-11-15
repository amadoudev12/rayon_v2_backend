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
import { listStoreStock } from "@/services/stock-query";
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
  const pagination = getPagination(params);

  const { rows, total } = await listStoreStock({
    organisationId: context.organizationId,
    storeId,
    search: params.get("search") ?? "",
    lowStockOnly: params.get("lowStock") === "true",
    page: pagination.page,
    limit: pagination.limit,
  });
  return jsonPage(res, rows, paginationMeta(pagination, total));
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

/**
 * Alertes : ruptures et stocks bas (calculés en SQL, 500 au plus) et produits
 * ayant subi au moins 3 pertes actives sur 30 jours.
 */
export async function getStockAlerts(req: Request, res: Response) {
  const context = req.user;
  const storeId = await resolveActiveStoreId(context, Number(searchParams(req).get("storeId")) || undefined);
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [low, lossGroups] = await Promise.all([
    listStoreStock({ organisationId: context.organizationId, storeId, lowStockOnly: true, page: 1, limit: 500 }),
    prisma.perteStock.groupBy({
      by: ["produitId"],
      where: { organisationId: context.organizationId, boutiqueId: storeId, statut: "ACTIVE", creeLe: { gte: cutoff } },
      _count: { id: true },
      _sum: { quantite: true },
    }),
  ]);
  const stockAlerts = low.rows.map((row) => ({
    type: "STOCK" as const,
    produitId: row.produitId,
    produit: row.produit.nom,
    quantite: row.quantite,
    seuilAlerte: row.seuilAlerte,
    niveau: row.niveau,
  }));
  const repeated = lossGroups.filter((row) => row._count.id >= 3);
  const details = await prisma.produit.findMany({
    where: { organisationId: context.organizationId, id: { in: repeated.map((row) => row.produitId) } },
    select: { id: true, nom: true, seuilAlerte: true },
  });
  const byId = new Map(details.map((product) => [product.id, product]));
  const lossAlerts = repeated.flatMap((row) => {
    const product = byId.get(row.produitId);
    if (!product) return [];
    return [{
      type: "REPEATED_LOSS" as const,
      produitId: row.produitId,
      produit: product.nom,
      quantite: row._sum.quantite ?? 0,
      seuilAlerte: product.seuilAlerte,
      niveau: "REPEATED_LOSS" as const,
      occurrences: row._count.id,
    }];
  });
  return jsonData(res, [...stockAlerts, ...lossAlerts]);
}

export async function getStockValuation(req: Request, res: Response) {
  const context = req.user;
  const storeId = await resolveActiveStoreId(context, Number(searchParams(req).get("storeId")) || undefined);
  const rows = await prisma.stock.findMany({ where: { boutiqueId: storeId, produit: { organisationId: context.organizationId, actif: true } }, include: { produit: { select: { id: true, nom: true, reference: true, unite: true, prixAchat: true } } }, orderBy: { produit: { nom: "asc" } } });
  const lines = rows.map(({ quantite, produit }) => ({ produitId: produit.id, produit: produit.nom, reference: produit.reference, unite: produit.unite, quantite, coutUnitaire: Number(produit.prixAchat), valeur: Math.round(quantite * Number(produit.prixAchat) * 100) / 100 }));
  return jsonData(res, { lignes: lines, quantiteTotale: lines.reduce((total, row) => total + row.quantite, 0), valeurTotale: Math.round(lines.reduce((total, row) => total + row.valeur, 0) * 100) / 100, methode: "Coût d'achat courant du produit (dernier coût enregistré)" });
}
