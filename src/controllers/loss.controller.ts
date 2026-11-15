import type { Request, Response } from "express";
import * as service from "@/services/loss";
import { lossCancelSchema, lossCreateSchema } from "@/lib/validations/loss";
import { requireIdempotencyKey } from "@/lib/idempotency";
import { jsonData, routeId, searchParams } from "@/lib/api/response";

export async function create(req: Request, res: Response) { return jsonData(res, await service.createLoss(req.user, lossCreateSchema.parse(req.body), requireIdempotencyKey(req))); }
export async function list(req: Request, res: Response) { const storeId = Number(searchParams(req).get("storeId")) || undefined; return jsonData(res, await service.listLosses(req.user, storeId)); }
export async function report(req: Request, res: Response) { const params = searchParams(req); const from = params.get("from") ? new Date(params.get("from")!) : undefined; const to = params.get("to") ? new Date(params.get("to")!) : undefined; return jsonData(res, await service.getLossReport(req.user, { boutiqueId: Number(params.get("storeId")) || undefined, ...(from && !Number.isNaN(from.getTime()) ? { from } : {}), ...(to && !Number.isNaN(to.getTime()) ? { to } : {}) })); }
export async function cancel(req: Request, res: Response) { const { motif } = lossCancelSchema.parse(req.body); return jsonData(res, await service.cancelLoss(req.user, routeId(req), motif)); }
