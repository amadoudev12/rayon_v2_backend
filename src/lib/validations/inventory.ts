import { z } from "zod";

export const inventoryCreateSchema = z
  .object({
    boutiqueId: z.coerce.number().int().positive(),
    libelle: z.string().trim().min(2).max(160),
    selectionType: z.enum(["ALL", "CATEGORY", "MANUAL"]),
    categorieId: z.coerce.number().int().positive().optional(),
    produitIds: z.array(z.coerce.number().int().positive()).max(5000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.selectionType === "CATEGORY" && !value.categorieId) {
      ctx.addIssue({ code: "custom", message: "Une catégorie est requise." });
    }
    if (value.selectionType === "MANUAL" && !value.produitIds?.length) {
      ctx.addIssue({ code: "custom", message: "Sélectionnez au moins un produit." });
    }
  });

export const inventoryCountSchema = z.object({
  quantiteComptee: z.coerce.number().int().nonnegative().max(10_000_000),
  version: z.coerce.number().int().nonnegative(),
});

export const inventoryCancelSchema = z.object({
  motif: z.string().trim().min(3).max(500),
});

export const stockThresholdSchema = z.object({
  boutiqueId: z.coerce.number().int().positive().optional(),
  produitId: z.coerce.number().int().positive(),
  seuilAlerte: z.coerce.number().int().nonnegative().max(1_000_000),
});
