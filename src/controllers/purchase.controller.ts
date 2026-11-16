import type { Request, Response } from "express";
import * as purchaseService from "@/services/purchase";
import { prisma } from "@/lib/prisma";
import { resolveActiveStoreId } from "@/lib/auth/session";
import { resolveRequestStoreId } from "@/lib/auth/store";
import { purchaseCancelSchema, purchaseSchema, supplierPaymentSchema } from "@/lib/validations/purchase";
import { requireIdempotencyKey } from "@/lib/idempotency";
import { jsonData, jsonPage, routeId, searchParams } from "@/lib/api/response";
import { getPagination, paginationMeta } from "@/lib/api/pagination";
import { Errors } from "@/lib/api/errors";

export async function getAllPurchases(req: Request, res: Response) {
  const context = req.user;
  const params = searchParams(req);

  const storeId = await resolveActiveStoreId(context, Number(params.get("storeId")) || undefined);
  const pagination = getPagination(params, 10);
  const unpaidOnly = params.get("statut") === "a_regler";

  const where = {
    organisationId: context.organizationId,
    boutiqueId: storeId,
    ...(unpaidOnly ? { resteAPayer: { gt: 0 } } : {}),
  };

  const [purchases, total] = await Promise.all([
    prisma.achat.findMany({
      where,
      orderBy: { creeLe: "desc" },
      skip: (pagination.page - 1) * pagination.limit,
      take: pagination.limit,
      include: {
        lignes: { include: { produit: { select: { id: true, nom: true } } } },
        fournisseur: { select: { id: true, nom: true } },
      },
    }),
    prisma.achat.count({ where }),
  ]);

  return jsonPage(res, purchases.map(({ cleIdempotence: _key, empreinteIdempotence: _print, cleAnnulation: _cancel, ...purchase }) => purchase), paginationMeta(pagination, total));
}

/** Retire les champs internes (clés d'idempotence) d'un achat détaillé. */
function serializePurchase(purchase: purchaseService.PurchaseWithDetails) {
  const { cleIdempotence: _key, empreinteIdempotence: _print, cleAnnulation: _cancel, paiements, ...rest } = purchase;
  return { ...rest, paiements: paiements.map(({ cleIdempotence: _paymentKey, ...payment }) => payment) };
}

export async function createPurchase(req: Request, res: Response) {
  const context = req.user;
  const parsed = purchaseSchema.parse(req.body);
  const storeId = await resolveRequestStoreId(context, parsed.boutiqueId);

  const purchase = await purchaseService.createPurchase(context, storeId, parsed, requireIdempotencyKey(req));
  return jsonData(res, serializePurchase(purchase), { status: 201 });
}

export async function getPurchaseById(req: Request, res: Response) {
  const purchase = await purchaseService.getPurchase(req.user, routeId(req));
  if (!purchase) throw Errors.notFound("Achat introuvable");
  return jsonData(res, serializePurchase(purchase));
}

export async function addSupplierPayment(req: Request, res: Response) {
  const parsed = supplierPaymentSchema.parse(req.body);
  const purchase = await purchaseService.addSupplierPayment(req.user, routeId(req), parsed.montant, parsed.modePaiement, requireIdempotencyKey(req));
  return jsonData(res, serializePurchase(purchase), { status: 201 });
}

export async function cancelPurchase(req: Request, res: Response) {
  const parsed = purchaseCancelSchema.parse(req.body ?? {});
  const purchase = await purchaseService.cancelPurchase(req.user, routeId(req), parsed.motif, requireIdempotencyKey(req));
  return jsonData(res, serializePurchase(purchase));
}
