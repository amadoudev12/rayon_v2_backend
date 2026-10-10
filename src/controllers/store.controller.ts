import type { Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import { storeSchema } from "@/lib/validations/member";
import { jsonData } from "@/lib/api/response";

export async function getAllStores(req: Request, res: Response) {
  const context = req.user;

  const stores = await prisma.boutique.findMany({
    where: { organisationId: context.organizationId },
    orderBy: [{ parDefaut: "desc" }, { nom: "asc" }],
  });

  return jsonData(res, stores);
}

export async function createStore(req: Request, res: Response) {
  const context = req.user;

  const parsed = storeSchema.parse(req.body);

  const store = await prisma.$transaction(async (tx) => {
    const createdStore = await tx.boutique.create({
      data: {
        organisationId: context.organizationId,
        nom: parsed.nom,
        adresse: parsed.adresse || null,
        telephone: parsed.telephone || null,
      },
    });

    // Chaque produit du catalogue a besoin d'une ligne de stock (à zéro) dans
    // la nouvelle boutique, pour que l'inventaire n'ait jamais à traiter une
    // ligne manquante comme un cas particulier.
    const products = await tx.produit.findMany({
      where: { organisationId: context.organizationId },
      select: { id: true },
    });
    if (products.length > 0) {
      await tx.stock.createMany({
        data: products.map((product) => ({ boutiqueId: createdStore.id, produitId: product.id, quantite: 0 })),
      });
    }

    return createdStore;
  });

  return jsonData(res, store, { status: 201 });
}
