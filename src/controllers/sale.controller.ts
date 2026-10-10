import type { Request, Response } from "express";
import * as saleService from "@/services/sale";
import { prisma } from "@/lib/prisma";
import { containsText } from "@/lib/search";
import { resolveActiveStoreId } from "@/lib/auth/session";
import { saleSchema } from "@/lib/validations/sale";
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
  const selectedDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00`) : null;
  if (date && !selectedDate) throw Errors.conflict("Date de recherche invalide");

  const nextDay = selectedDate ? new Date(selectedDate) : null;
  nextDay?.setDate(nextDay.getDate() + 1);

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
    ...(selectedDate && nextDay ? { creeLe: { gte: selectedDate, lt: nextDay } } : {}),
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

  const sale = await saleService.createSale(context, storeId, parsed);
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
      boutique: { select: { id: true, nom: true } },
    },
  });
  if (!sale) throw Errors.notFound("Vente introuvable");

  return jsonData(res, sale);
}

export async function cancelSale(req: Request, res: Response) {
  const context = req.user;

  const saleId = routeId(req);

  const sale = await saleService.cancelSale(context, saleId);

  await recordAuditLog({
    organisationId: context.organizationId,
    utilisateurId: context.userId,
    action: "sale.cancelled",
    entite: "Sale",
    entiteId: saleId,
  });

  return jsonData(res, sale);
}
