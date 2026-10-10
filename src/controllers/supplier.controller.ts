import type { Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import { containsText } from "@/lib/search";
import { supplierSchema } from "@/lib/validations/supplier";
import { jsonData, jsonMessage, jsonPage, routeId, searchParams } from "@/lib/api/response";
import { getPagination, paginationMeta } from "@/lib/api/pagination";
import { Errors } from "@/lib/api/errors";

export async function getAllSuppliers(req: Request, res: Response) {
  const context = req.user;
  const params = searchParams(req);
  const search = params.get("search")?.trim() ?? "";
  const pagination = getPagination(params);

  const where = {
    organisationId: context.organizationId,
    ...(search ? { OR: [{ nom: containsText(search) }, { telephone: containsText(search) }] } : {}),
  };

  const [suppliers, total] = await Promise.all([
    prisma.fournisseur.findMany({
      where,
      orderBy: { nom: "asc" },
      skip: (pagination.page - 1) * pagination.limit,
      take: pagination.limit,
      include: { _count: { select: { achats: true } } },
    }),
    prisma.fournisseur.count({ where }),
  ]);

  return jsonPage(res, suppliers, paginationMeta(pagination, total));
}

export async function createSupplier(req: Request, res: Response) {
  const context = req.user;

  const parsed = supplierSchema.parse(req.body);
  const supplier = await prisma.fournisseur.create({
    data: {
      organisationId: context.organizationId,
      nom: parsed.nom,
      telephone: parsed.telephone || null,
      email: parsed.email || null,
      adresse: parsed.adresse || null,
    },
  });

  return jsonData(res, supplier, { status: 201 });
}

export async function updateSupplier(req: Request, res: Response) {
  const context = req.user;

  const supplierId = routeId(req);

  const parsed = supplierSchema.parse(req.body);
  const updated = await prisma.fournisseur.updateMany({
    where: { id: supplierId, organisationId: context.organizationId },
    data: {
      nom: parsed.nom,
      telephone: parsed.telephone || null,
      email: parsed.email || null,
      adresse: parsed.adresse || null,
    },
  });
  if (updated.count === 0) throw Errors.notFound("Fournisseur introuvable");

  const supplier = await prisma.fournisseur.findUnique({ where: { id: supplierId } });
  return jsonData(res, supplier);
}

export async function deleteSupplier(req: Request, res: Response) {
  const context = req.user;

  const supplierId = routeId(req);

  const deleted = await prisma.fournisseur.deleteMany({
    where: { id: supplierId, organisationId: context.organizationId },
  });
  if (deleted.count === 0) throw Errors.notFound("Fournisseur introuvable");

  return jsonMessage(res, "Fournisseur supprimé");
}
