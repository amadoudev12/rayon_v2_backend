import type { Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import { resolveActiveStoreId } from "@/lib/auth/session";
import { expenseSchema } from "@/lib/validations/expense";
import { jsonData, jsonMessage, jsonPage, routeId, searchParams } from "@/lib/api/response";
import { getPagination, paginationMeta } from "@/lib/api/pagination";
import { Errors } from "@/lib/api/errors";

export async function getAllExpenses(req: Request, res: Response) {
  const context = req.user;
  const pagination = getPagination(searchParams(req), 20);

  const where = { organisationId: context.organizationId };

  const [expenses, total] = await Promise.all([
    prisma.depense.findMany({
      where,
      orderBy: { date: "desc" },
      skip: (pagination.page - 1) * pagination.limit,
      take: pagination.limit,
    }),
    prisma.depense.count({ where }),
  ]);

  return jsonPage(res, expenses, paginationMeta(pagination, total));
}

export async function createExpense(req: Request, res: Response) {
  const context = req.user;

  const parsed = expenseSchema.parse(req.body);
  const storeId = parsed.boutiqueId ? await resolveActiveStoreId(context, parsed.boutiqueId) : null;

  const expense = await prisma.depense.create({
    data: {
      organisationId: context.organizationId,
      boutiqueId: storeId,
      categorie: parsed.categorie,
      libelle: parsed.libelle,
      montant: parsed.montant,
      note: parsed.note || null,
      date: parsed.date ?? new Date(),
      creeParId: context.userId,
    },
  });

  return jsonData(res, expense, { status: 201 });
}

export async function deleteExpense(req: Request, res: Response) {
  const context = req.user;

  const expenseId = routeId(req);

  const deleted = await prisma.depense.deleteMany({
    where: { id: expenseId, organisationId: context.organizationId },
  });
  if (deleted.count === 0) throw Errors.notFound("Dépense introuvable");

  return jsonMessage(res, "Dépense supprimée");
}
