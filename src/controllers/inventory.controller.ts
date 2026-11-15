import type { Request, Response } from "express";
import * as service from "@/services/inventory";
import { inventoryCancelSchema, inventoryCountSchema, inventoryCreateSchema } from "@/lib/validations/inventory";
import { jsonData, routeId, searchParams } from "@/lib/api/response";

export async function create(req: Request, res: Response) { return jsonData(res, await service.createInventory(req.user, inventoryCreateSchema.parse(req.body))); }
export async function list(req: Request, res: Response) { const storeId = Number(searchParams(req).get("storeId")) || undefined; return jsonData(res, await service.listInventories(req.user, storeId)); }
export async function detail(req: Request, res: Response) { return jsonData(res, await service.getInventory(req.user, routeId(req))); }
export async function count(req: Request, res: Response) { const lineId = Number(req.params.lineId); return jsonData(res, await service.countInventoryLine(req.user, routeId(req), lineId, inventoryCountSchema.parse(req.body))); }
export async function validate(req: Request, res: Response) { return jsonData(res, await service.validateInventory(req.user, routeId(req))); }
export async function cancel(req: Request, res: Response) { const { motif } = inventoryCancelSchema.parse(req.body); return jsonData(res, await service.cancelInventory(req.user, routeId(req), motif)); }
