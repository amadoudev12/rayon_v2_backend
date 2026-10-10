import type { Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import { containsText } from "@/lib/search";
import { customerSchema } from "@/lib/validations/customer";
import { jsonData, jsonMessage, jsonPage, routeId, searchParams } from "@/lib/api/response";
import { getPagination, paginationMeta } from "@/lib/api/pagination";
import { Errors } from "@/lib/api/errors";

export async function getAllCustomers(req: Request, res: Response) {
  const context = req.user;
  const params = searchParams(req);
  const search = params.get("search")?.trim() ?? "";
  const pagination = getPagination(params);

  const where = {
    organisationId: context.organizationId,
    ...(search ? { OR: [{ nom: containsText(search) }, { telephone: containsText(search) }] } : {}),
  };

  const [customers, total] = await Promise.all([
    prisma.client.findMany({
      where,
      orderBy: { nom: "asc" },
      skip: (pagination.page - 1) * pagination.limit,
      take: pagination.limit,
      include: { _count: { select: { ventes: true } } },
    }),
    prisma.client.count({ where }),
  ]);

  return jsonPage(res, customers, paginationMeta(pagination, total));
}

export async function createCustomer(req: Request, res: Response) {
  const context = req.user;

  const parsed = customerSchema.parse(req.body);
  const customer = await prisma.client.create({
    data: {
      organisationId: context.organizationId,
      nom: parsed.nom,
      telephone: parsed.telephone || null,
      email: parsed.email || null,
      adresse: parsed.adresse || null,
    },
  });

  return jsonData(res, customer, { status: 201 });
}

export async function updateCustomer(req: Request, res: Response) {
  const context = req.user;

  const customerId = routeId(req);

  const parsed = customerSchema.parse(req.body);
  const updated = await prisma.client.updateMany({
    where: { id: customerId, organisationId: context.organizationId },
    data: {
      nom: parsed.nom,
      telephone: parsed.telephone || null,
      email: parsed.email || null,
      adresse: parsed.adresse || null,
    },
  });
  if (updated.count === 0) throw Errors.notFound("Client introuvable");

  const customer = await prisma.client.findUnique({ where: { id: customerId } });
  return jsonData(res, customer);
}

export async function deleteCustomer(req: Request, res: Response) {
  const context = req.user;

  const customerId = routeId(req);

  const deleted = await prisma.client.deleteMany({
    where: { id: customerId, organisationId: context.organizationId },
  });
  if (deleted.count === 0) throw Errors.notFound("Client introuvable");

  return jsonMessage(res, "Client supprimé");
}
