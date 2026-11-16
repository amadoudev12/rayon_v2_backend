import type { Request, Response } from "express";
import { resolveRequestStoreId } from "@/lib/auth/store";
import { jsonData, jsonMessage, routeId, searchParams } from "@/lib/api/response";
import { deleteHeldSale, holdSale, holdSaleSchema, listHeldSales, resumeHeldSale } from "@/services/held-sale";

/** Boutique de la requête : `?storeId=` (mobile), sinon le sélecteur du site. */
const storeOf = (req: Request) => resolveRequestStoreId(req.user, Number(searchParams(req).get("storeId")) || undefined);

export async function list(req: Request, res: Response) {
  return jsonData(res, await listHeldSales(req.user, await storeOf(req)));
}

export async function create(req: Request, res: Response) {
  const parsed = holdSaleSchema.parse(req.body);
  return jsonData(res, await holdSale(req.user, await storeOf(req), parsed), { status: 201 });
}

export async function resume(req: Request, res: Response) {
  return jsonData(res, await resumeHeldSale(req.user, await storeOf(req), routeId(req)));
}

export async function remove(req: Request, res: Response) {
  await deleteHeldSale(req.user, await storeOf(req), routeId(req));
  return jsonMessage(res, "Vente en attente supprimée");
}
