import type { Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/auth/permissions";
import { getActiveStoreId } from "@/lib/auth/store";
import { getPagination, paginationMeta } from "@/lib/api/pagination";
import { jsonData, searchParams } from "@/lib/api/response";
import { LOSS_REASONS, LOSS_REASON_LABELS } from "@/lib/labels";
import { parsePeriod } from "@/lib/period";
import { listLosses, getLossReport } from "@/services/loss";
import { listStoreStock } from "@/services/stock-query";
import { getStockAlerts, getStockValuation } from "@/services/stock-report";

/**
 * Données des pages « Pertes et casses », « Alertes et seuils » et
 * « Valorisation » du site, pour la boutique du sélecteur.
 */

async function storeAndCurrency(req: Request) {
  const [storeId, organization] = await Promise.all([
    getActiveStoreId(req.user),
    prisma.organisation.findUniqueOrThrow({ where: { id: req.user.organizationId }, select: { devise: true, fuseauHoraire: true } }),
  ]);
  const store = await prisma.boutique.findUniqueOrThrow({ where: { id: storeId }, select: { id: true, nom: true } });
  return { store, currency: organization.devise, timeZone: organization.fuseauHoraire };
}

export async function getLossesPage(req: Request, res: Response) {
  const pagination = getPagination(searchParams(req), 25);
  const { store, currency } = await storeAndCurrency(req);
  const { data, total } = await listLosses(req.user, store.id, pagination.page, pagination.limit);
  return jsonData(res, {
    store,
    currency,
    losses: data,
    reasons: LOSS_REASONS.map((value) => ({ value, label: LOSS_REASON_LABELS[value] })),
    canCreate: can(req.user.role, "loss:create"),
    page: pagination.page,
    totalPages: paginationMeta(pagination, total).totalPages,
    total,
  });
}

export async function getStockControlPage(req: Request, res: Response) {
  const params = searchParams(req);
  const pagination = getPagination(params, 25);
  const { store } = await storeAndCurrency(req);
  const [alerts, stock] = await Promise.all([
    getStockAlerts(req.user, store.id),
    listStoreStock({
      organisationId: req.user.organizationId,
      storeId: store.id,
      search: params.get("search")?.trim() ?? "",
      lowStockOnly: false,
      page: pagination.page,
      limit: pagination.limit,
    }),
  ]);
  return jsonData(res, {
    store,
    alerts,
    rows: stock.rows,
    canManageThresholds: can(req.user.role, "stock:threshold:manage"),
    page: pagination.page,
    totalPages: paginationMeta(pagination, stock.total).totalPages,
    total: stock.total,
  });
}

/** Valorisation actuelle et pertes de la période choisie (ce mois-ci par défaut). */
export async function getStockReportsPage(req: Request, res: Response) {
  const params = searchParams(req);
  if (!params.get("periode")) params.set("periode", "month");
  const { store, currency, timeZone } = await storeAndCurrency(req);
  const period = parsePeriod(params, new Date(), timeZone);
  const [valuation, losses] = await Promise.all([getStockValuation(req.user, store.id), getLossReport(req.user, store.id, period)]);
  return jsonData(res, {
    store,
    currency,
    valuation,
    losses,
    period: { key: period.key, from: period.from, to: period.to },
  });
}
