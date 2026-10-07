import { z } from "zod";

export const purchaseItemSchema = z.object({
  produitId: z.coerce.number().int().positive("Produit invalide"),
  quantite: z.coerce.number().int().positive("La quantité doit être supérieure à 0"),
  coutUnitaire: z.coerce.number().nonnegative("Le coût unitaire doit être positif ou nul."),
});

export const purchaseSchema = z.object({
  lignes: z.array(purchaseItemSchema).min(1, "Ajoutez au moins un produit"),
  fournisseurId: z.coerce.number().int().positive().optional().nullable(),
  boutiqueId: z.coerce.number().int().positive().optional().nullable(),
  note: z.string().trim().optional().or(z.literal("")),
});

export type PurchaseFormData = z.infer<typeof purchaseSchema>;
