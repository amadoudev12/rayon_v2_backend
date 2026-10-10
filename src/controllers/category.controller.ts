import type { Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import { categorySchema } from "@/lib/validations/product";
import { jsonData, jsonMessage, routeId } from "@/lib/api/response";
import { Errors } from "@/lib/api/errors";

export async function getAllCategories(req: Request, res: Response) {
  const context = req.user;

  const categories = await prisma.categorie.findMany({
    where: { organisationId: context.organizationId },
    orderBy: { nom: "asc" },
    include: { _count: { select: { produits: true } } },
  });

  return jsonData(res, categories);
}

export async function createCategory(req: Request, res: Response) {
  const context = req.user;

  const parsed = categorySchema.parse(req.body);
  const category = await prisma.categorie.create({
    data: {
      organisationId: context.organizationId,
      nom: parsed.nom,
      description: parsed.description || null,
    },
  });

  return jsonData(res, category, { status: 201 });
}

export async function updateCategory(req: Request, res: Response) {
  const context = req.user;

  const categoryId = routeId(req);

  const parsed = categorySchema.parse(req.body);
  const updated = await prisma.categorie.updateMany({
    where: { id: categoryId, organisationId: context.organizationId },
    data: { nom: parsed.nom, description: parsed.description || null },
  });
  if (updated.count === 0) throw Errors.notFound("Catégorie introuvable");

  const category = await prisma.categorie.findUnique({ where: { id: categoryId } });
  return jsonData(res, category);
}

export async function deleteCategory(req: Request, res: Response) {
  const context = req.user;

  const categoryId = routeId(req);

  const deleted = await prisma.categorie.deleteMany({
    where: { id: categoryId, organisationId: context.organizationId },
  });
  if (deleted.count === 0) throw Errors.notFound("Catégorie introuvable");

  return jsonMessage(res, "Catégorie supprimée");
}
