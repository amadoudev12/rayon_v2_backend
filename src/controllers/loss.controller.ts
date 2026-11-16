import type { Request, Response } from "express";
import * as service from "@/services/loss";
import { lossCancelSchema, lossCreateSchema } from "@/lib/validations/loss";
import { requireIdempotencyKey } from "@/lib/idempotency";
import { jsonData, jsonPage, routeId, searchParams } from "@/lib/api/response";
import { getPagination, paginationMeta } from "@/lib/api/pagination";
import { resolveRequestStoreId } from "@/lib/auth/store";
import { getOrganizationTimeZone } from "@/lib/organization";
import { parsePeriod } from "@/lib/period";

export async function create(req: Request, res: Response) {
  const body = req.body as { boutiqueId?: unknown } | undefined;
  // Boutique demandée, sinon celle du sélecteur du site.
  const storeId = await resolveRequestStoreId(req.user, Number(body?.boutiqueId) || undefined);
  const data = lossCreateSchema.parse({ ...req.body, boutiqueId: storeId });
  const loss = await service.createLoss(req.user, data, requireIdempotencyKey(req));
  return jsonData(res, loss);
}

export async function list(req: Request, res: Response) {
  const params = searchParams(req);
  const storeId = await resolveRequestStoreId(req.user, Number(params.get("storeId")) || undefined);
  const pagination = getPagination(params, 50);
  const { data, total } = await service.listLosses(req.user, storeId, pagination.page, pagination.limit);
  return jsonPage(res, data, paginationMeta(pagination, total));
}

/** Rapport des pertes d'une période (`?periode=…`, ce mois-ci par défaut). */
export async function report(req: Request, res: Response) {
  const params = searchParams(req);
  const storeId = await resolveRequestStoreId(req.user, Number(params.get("storeId")) || undefined);
  if (!params.get("periode")) params.set("periode", "month");
  const period = parsePeriod(params, new Date(), await getOrganizationTimeZone(req.user.organizationId));
  const result = await service.getLossReport(req.user, storeId, period);
  return jsonData(res, { ...result, periode: { cle: period.key, du: period.from, au: period.to } });
}

export async function cancel(req: Request, res: Response) {
  const { motif } = lossCancelSchema.parse(req.body);
  return jsonData(res, await service.cancelLoss(req.user, routeId(req), motif));
}
