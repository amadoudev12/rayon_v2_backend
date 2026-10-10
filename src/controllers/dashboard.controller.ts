import type { Request, Response } from "express";
import * as dashboardService from "@/services/dashboard";
import { resolveActiveStoreId } from "@/lib/auth/session";
import { jsonData, searchParams } from "@/lib/api/response";

export async function getDashboard(req: Request, res: Response) {
  const context = req.user;
  const requestedStoreId = Number(searchParams(req).get("storeId")) || undefined;

  // A restricted member is always forced onto their own store. An
  // unrestricted member may target one store (validated against their own
  // organization); with none requested, stats aggregate every store.
  const storeId = context.membershipStoreId
    ? context.membershipStoreId
    : requestedStoreId
      ? await resolveActiveStoreId(context, requestedStoreId)
      : null;

  const stats = await dashboardService.getDashboardStats(context, storeId);
  return jsonData(res, stats);
}
