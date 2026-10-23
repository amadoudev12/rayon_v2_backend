import type { Request, Response } from "express";
import * as quoteService from "@/services/quote";
import { prisma } from "@/lib/prisma";
import { resolveActiveStoreId } from "@/lib/auth/session";
import { quoteSchema } from "@/lib/validations/quote";
import { jsonData, jsonMessage, jsonPage, routeId, searchParams } from "@/lib/api/response";
import { getPagination, paginationMeta } from "@/lib/api/pagination";
import { Errors } from "@/lib/api/errors";

export async function getAllQuotes(req: Request, res: Response) {
  const context = req.user;
  const params = searchParams(req);

  const storeId = await resolveActiveStoreId(context, Number(params.get("storeId")) || undefined);
  const pagination = getPagination(params, 10);
  const where = { organisationId: context.organizationId, boutiqueId: storeId };

  const [quotes, total] = await Promise.all([
    prisma.devis.findMany({
      where,
      orderBy: { creeLe: "desc" },
      skip: (pagination.page - 1) * pagination.limit,
      take: pagination.limit,
      include: { client: { select: { id: true, nom: true } }, _count: { select: { lignes: true } } },
    }),
    prisma.devis.count({ where }),
  ]);

  return jsonPage(res, quotes, paginationMeta(pagination, total));
}

export async function createQuote(req: Request, res: Response) {
  const context = req.user;

  const parsed = quoteSchema.parse(req.body);
  const storeId = await resolveActiveStoreId(context, parsed.boutiqueId);

  const quote = await quoteService.createQuote(context, storeId, parsed);
  return jsonData(res, quote, { status: 201 });
}

export async function getQuoteById(req: Request, res: Response) {
  const context = req.user;
  const quoteId = routeId(req);

  const quote = await prisma.devis.findFirst({
    where: {
      id: quoteId,
      organisationId: context.organizationId,
      ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : {}),
    },
    include: quoteService.quoteInclude,
  });
  if (!quote) throw Errors.notFound("Devis introuvable");

  return jsonData(res, quote);
}

export async function deleteQuote(req: Request, res: Response) {
  await quoteService.deleteQuote(req.user, routeId(req));
  return jsonMessage(res, "Devis supprimé");
}
