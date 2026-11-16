import type { Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import { resolveActiveStoreId } from "@/lib/auth/session";
import { resolveRequestStoreId } from "@/lib/auth/store";
import { expenseSchema } from "@/lib/validations/expense";
import { jsonData, jsonMessage, jsonPage, routeId, searchParams } from "@/lib/api/response";
import { getPagination, paginationMeta } from "@/lib/api/pagination";
import { Errors } from "@/lib/api/errors";
import { ExpenseStatus } from "@/generated/prisma/enums";
import { Role } from "@/generated/prisma/enums";

export async function getAllExpenses(req: Request, res: Response) {
  const context = req.user;
  const pagination = getPagination(searchParams(req), 20);

  const storeId = await resolveActiveStoreId(context, Number(searchParams(req).get("storeId")) || undefined);
  const where = { organisationId: context.organizationId, statut: ExpenseStatus.ACTIVE,
    ...(context.membershipStoreId ? { boutiqueId: storeId } : {}) };

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
  if (parsed.organisationnelle && context.role !== Role.OWNER && context.role !== Role.ADMIN) throw Errors.forbidden("Seul un propriétaire ou administrateur peut créer une charge organisationnelle.");
  const storeId = parsed.organisationnelle ? null : await resolveRequestStoreId(context, parsed.boutiqueId);

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

  const deleted = await prisma.depense.updateMany({
    where: { id: expenseId, organisationId: context.organizationId, statut: ExpenseStatus.ACTIVE,
      ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : {}) },
    data: { statut: ExpenseStatus.CANCELLED, annuleLe: new Date(), annuleParId: context.userId, motifAnnulation: "Annulation demandée" },
  });
  if (deleted.count === 0) throw Errors.notFound("Dépense introuvable");

  return jsonMessage(res, "Dépense supprimée");
}
