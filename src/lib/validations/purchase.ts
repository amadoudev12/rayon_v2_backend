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
  /** Montant versé au fournisseur ; l'achat est payé en totalité s'il est absent. */
  montantPaye: z.coerce.number().nonnegative("Le montant payé doit être positif ou nul.").optional(),
  note: z.string().trim().optional().or(z.literal("")),
});

export type PurchaseFormData = z.infer<typeof purchaseSchema>;
