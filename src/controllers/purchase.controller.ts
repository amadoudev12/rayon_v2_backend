import type { Request, Response } from "express";
import * as purchaseService from "@/services/purchase";
import { prisma } from "@/lib/prisma";
import { resolveActiveStoreId } from "@/lib/auth/session";
import { purchaseSchema } from "@/lib/validations/purchase";
import { jsonData, jsonPage, routeId, searchParams } from "@/lib/api/response";
import { getPagination, paginationMeta } from "@/lib/api/pagination";
import { Errors } from "@/lib/api/errors";

export async function getAllPurchases(req: Request, res: Response) {
  const context = req.user;
  const params = searchParams(req);

  const storeId = await resolveActiveStoreId(context, Number(params.get("storeId")) || undefined);
  const pagination = getPagination(params, 10);

  const where = { organisationId: context.organizationId, boutiqueId: storeId };

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

  return jsonPage(res, purchases, paginationMeta(pagination, total));
}

export async function createPurchase(req: Request, res: Response) {
  const context = req.user;

  const parsed = purchaseSchema.parse(req.body);
  const storeId = await resolveActiveStoreId(context, parsed.boutiqueId);

  const purchase = await purchaseService.createPurchase(context, storeId, parsed);
  return jsonData(res, purchase, { status: 201 });
}

export async function getPurchaseById(req: Request, res: Response) {
  const context = req.user;
  const purchaseId = routeId(req);

  const purchase = await prisma.achat.findFirst({
    where: {
      id: purchaseId,
      organisationId: context.organizationId,
      // Un membre limité à une boutique ne peut consulter que ses achats.
      ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : {}),
    },
    include: {
      lignes: { include: { produit: { select: { id: true, nom: true, unite: true } } } },
      fournisseur: { select: { id: true, nom: true, telephone: true } },
      creePar: { select: { id: true, prenom: true, nom: true } },
      // Coordonnées du magasin : en-tête du bon d'achat imprimé.
      boutique: { select: { id: true, nom: true, adresse: true, telephone: true, organisation: { select: { nom: true } } } },
    },
  });
  if (!purchase) throw Errors.notFound("Achat introuvable");

  return jsonData(res, purchase);
}
