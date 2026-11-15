import type { Request, Response } from "express";
import * as saleService from "@/services/sale";
import { getSalesStats, visibleSalesStats } from "@/services/sale-stats";
import { prisma } from "@/lib/prisma";
import { containsText } from "@/lib/search";
import { resolveActiveStoreId } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";
import { parsePeriod } from "@/lib/period";
import { cancellationSchema, refundPayoutSchema, refundSchema, salePaymentSchema, saleSchema } from "@/lib/validations/sale";
import { requireIdempotencyKey } from "@/lib/idempotency";
import { recordAuditLog } from "@/lib/api/audit";
import { jsonData, jsonPage, routeId, searchParams } from "@/lib/api/response";
import { getPagination, paginationMeta } from "@/lib/api/pagination";
import { Errors } from "@/lib/api/errors";

export async function getAllSales(req: Request, res: Response) {
  const context = req.user;
  const params = searchParams(req);

  const storeId = await resolveActiveStoreId(context, Number(params.get("storeId")) || undefined);
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
      include: {
        lignes: { include: { produit: { select: { id: true, nom: true } } } },
        client: { select: { id: true, nom: true } },
        vendeur: { select: { id: true, prenom: true, nom: true } },
      },
    }),
    prisma.vente.count({ where }),
  ]);

  return jsonPage(res, sales, paginationMeta(pagination, total));
}

export async function createSale(req: Request, res: Response) {
  const context = req.user;

  const parsed = saleSchema.parse(req.body);
  const storeId = await resolveActiveStoreId(context, parsed.boutiqueId);

  const sale = await saleService.createSale(context, storeId, parsed, requireIdempotencyKey(req));
  return jsonData(res, sale, { status: 201 });
}

export async function getSaleById(req: Request, res: Response) {
  const context = req.user;
  const saleId = routeId(req);

  const sale = await prisma.vente.findFirst({
    where: {
      id: saleId,
      organisationId: context.organizationId,
      // Un membre limité à une boutique ne peut consulter que ses ventes.
      ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : {}),
    },
    include: {
      lignes: { include: { produit: { select: { id: true, nom: true, unite: true } } } },
      client: { select: { id: true, nom: true, telephone: true } },
      vendeur: { select: { id: true, prenom: true, nom: true } },
      // Coordonnées du magasin : en-tête du reçu.
      boutique: { select: { id: true, nom: true, adresse: true, telephone: true, organisation: { select: { nom: true } } } },
      paiements: {
        orderBy: { date: "asc" },
        include: { utilisateur: { select: { id: true, prenom: true, nom: true } } },
      },
      remboursements: { orderBy: { creeLe: "asc" }, include: { demandePar: { select: { prenom: true, nom: true } }, versements: { orderBy: { date: "asc" }, include: { utilisateur: { select: { prenom: true, nom: true } } } } } },
    },
  });
  if (!sale) throw Errors.notFound("Vente introuvable");

  const lines = can(context.role, "report:view") ? sale.lignes : sale.lignes.map(({ coutUnitaire: _cost, ...line }) => line);
  return jsonData(res, { ...sale, lignes: lines, resteAPayer: sale.statut === "CANCELLED" ? 0 : saleService.remainingOf(sale) });
}

/** Statistiques de la boutique sur une période (`?periode=…`, voir lib/period). */
export async function getSalesStatsSummary(req: Request, res: Response) {
  const context = req.user;
  const params = searchParams(req);

  const storeId = await resolveActiveStoreId(context, Number(params.get("storeId")) || undefined);
  const organization = await prisma.organisation.findUniqueOrThrow({ where: { id: context.organizationId }, select: { fuseauHoraire: true } });
  const period = parsePeriod(params, new Date(), organization.fuseauHoraire);
  const stats = await getSalesStats(context, storeId, period);

  return jsonData(res, { period, stats: visibleSalesStats(stats, can(context.role, "report:view")) });
}

export async function addSalePayment(req: Request, res: Response) {
  const context = req.user;
  const saleId = routeId(req);

  const parsed = salePaymentSchema.parse(req.body);
  const sale = await saleService.addSalePayment(context, saleId, parsed.montant, parsed.modePaiement, requireIdempotencyKey(req));

  await recordAuditLog({
    organisationId: context.organizationId,
    utilisateurId: context.userId,
    action: "sale.payment_added",
    entite: "Sale",
    entiteId: saleId,
    metadonnees: { montant: parsed.montant },
  });

  return jsonData(res, { ...sale, resteAPayer: saleService.remainingOf(sale) }, { status: 201 });
}

export async function cancelSale(req: Request, res: Response) {
  const context = req.user;

  const saleId = routeId(req);

  const parsed = cancellationSchema.parse(req.body);
  const sale = await saleService.cancelSale(context, saleId, parsed.motif);

  await recordAuditLog({
    organisationId: context.organizationId,
    utilisateurId: context.userId,
    action: "sale.cancelled",
    entite: "Sale",
    entiteId: saleId,
  });

  return jsonData(res, sale);
}

export async function requestRefund(req: Request, res: Response) {
  const parsed = refundSchema.parse(req.body);
  const refund = await saleService.createRefundRequest(req.user, routeId(req), parsed.montant, parsed.motif, requireIdempotencyKey(req));
  return jsonData(res, refund, { status: 201 });
}

export async function makeRefundPayout(req: Request, res: Response) {
  const parsed = refundPayoutSchema.parse(req.body);
  const refund = await saleService.payRefund(req.user, routeId(req), parsed.montant, parsed.modePaiement, requireIdempotencyKey(req));
  return jsonData(res, refund, { status: 201 });
}
