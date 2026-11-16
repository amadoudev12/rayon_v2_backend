import type { Request, Response } from "express";
import * as saleService from "@/services/sale";
import { createSaleReturn } from "@/services/sale-return";
import { pricePolicyFor } from "@/services/pricing-policy";
import { getSalesStats, visibleSalesStats } from "@/services/sale-stats";
import { prisma } from "@/lib/prisma";
import { containsText } from "@/lib/search";
import { resolveRequestStoreId } from "@/lib/auth/store";
import { can } from "@/lib/auth/permissions";
import { parsePeriod } from "@/lib/period";
import { cancellationSchema, refundPayoutSchema, salePaymentSchema, saleReturnSchema, saleSchema } from "@/lib/validations/sale";
import { requireIdempotencyKey } from "@/lib/idempotency";
import { jsonData, jsonPage, routeId, searchParams } from "@/lib/api/response";
import { getPagination, paginationMeta } from "@/lib/api/pagination";
import { Errors } from "@/lib/api/errors";
import { saleSummarySelect, serializeSale, serializeSaleSummary } from "@/lib/serializers/sale";

const canViewCosts = (req: Request) => can(req.user.role, "report:view");

export async function getAllSales(req: Request, res: Response) {
  const context = req.user;
  const params = searchParams(req);

  const storeId = await resolveRequestStoreId(context, Number(params.get("storeId")) || undefined);
  const search = params.get("search")?.trim() ?? "";
  const date = params.get("date") ?? "";
  const pagination = getPagination(params, 10);
  let dateFilter = {};
  if (date) {
    const organization = await prisma.organisation.findUniqueOrThrow({ where: { id: context.organizationId }, select: { fuseauHoraire: true } });
    const selectedPeriod = parsePeriod(new URLSearchParams({ periode: "custom", du: date, au: date }), new Date(), organization.fuseauHoraire);
    dateFilter = { creeLe: { gte: selectedPeriod.start, lt: selectedPeriod.end } };
  }

  const where = {
    organisationId: context.organizationId,
    boutiqueId: storeId,
    ...(search
      ? {
          OR: [
            { lignes: { some: { produit: { nom: containsText(search) } } } },
            { client: { nom: containsText(search) } },
          ],
        }
      : {}),
    ...dateFilter,
  };

  const [sales, total] = await Promise.all([
    prisma.vente.findMany({
      where,
      orderBy: { creeLe: "desc" },
      skip: (pagination.page - 1) * pagination.limit,
      take: pagination.limit,
      select: saleSummarySelect,
    }),
    prisma.vente.count({ where }),
  ]);

  return jsonPage(res, sales.map(serializeSaleSummary), paginationMeta(pagination, total));
}

export async function createSale(req: Request, res: Response) {
  const context = req.user;

  const parsed = saleSchema.parse(req.body);
  const storeId = await resolveRequestStoreId(context, parsed.boutiqueId);

  const sale = await saleService.createSale(context, storeId, parsed, requireIdempotencyKey(req), await pricePolicyFor(context));
  return jsonData(res, serializeSale(sale, canViewCosts(req)), { status: 201 });
}

export async function getSaleById(req: Request, res: Response) {
  const context = req.user;
  const sale = await prisma.vente.findFirst({
    where: { id: routeId(req), ...saleService.saleScope(context) },
    include: saleService.saleInclude,
  });
  if (!sale) throw Errors.notFound("Vente introuvable");

  return jsonData(res, serializeSale(sale, canViewCosts(req)));
}

/** Statistiques de la boutique sur une période (`?periode=…`, voir lib/period). */
export async function getSalesStatsSummary(req: Request, res: Response) {
  const context = req.user;
  const params = searchParams(req);

  const storeId = await resolveRequestStoreId(context, Number(params.get("storeId")) || undefined);
  const organization = await prisma.organisation.findUniqueOrThrow({ where: { id: context.organizationId }, select: { fuseauHoraire: true } });
  const period = parsePeriod(params, new Date(), organization.fuseauHoraire);
  const stats = await getSalesStats(context, storeId, period);

  return jsonData(res, { period, stats: visibleSalesStats(stats, can(context.role, "report:view")) });
}

export async function addSalePayment(req: Request, res: Response) {
  const parsed = salePaymentSchema.parse(req.body);
  const sale = await saleService.addSalePayment(req.user, routeId(req), parsed.montant, parsed.modePaiement, requireIdempotencyKey(req));
  return jsonData(res, serializeSale(sale, canViewCosts(req)), { status: 201 });
}

export async function cancelSale(req: Request, res: Response) {
  const parsed = cancellationSchema.parse(req.body ?? {});
  const sale = await saleService.cancelSale(req.user, routeId(req), parsed, requireIdempotencyKey(req));
  return jsonData(res, serializeSale(sale, canViewCosts(req)));
}

export async function returnSaleItems(req: Request, res: Response) {
  const parsed = saleReturnSchema.parse(req.body);
  const sale = await createSaleReturn(req.user, routeId(req), parsed, requireIdempotencyKey(req));
  return jsonData(res, serializeSale(sale, canViewCosts(req)), { status: 201 });
}

export async function makeRefundPayout(req: Request, res: Response) {
  const parsed = refundPayoutSchema.parse(req.body);
  const sale = await saleService.payRefund(req.user, routeId(req), parsed.montant, parsed.modePaiement, requireIdempotencyKey(req));
  return jsonData(res, serializeSale(sale, canViewCosts(req)), { status: 201 });
}
