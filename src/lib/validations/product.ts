import { z } from "zod";

export const productSchema = z.object({
  nom: z.string().trim().min(2, "Le nom du produit est requis."),
  description: z.string().trim().optional().or(z.literal("")),
  reference: z.string().trim().optional().or(z.literal("")),
  codeBarres: z.string().trim().optional().or(z.literal("")),
  unite: z.string().trim().min(1).default("unité"),
  categorieId: z.coerce.number().int().positive().optional().nullable(),
  prixAchat: z.coerce.number().nonnegative("Le prix d'achat doit être positif ou nul."),
  prixVente: z.coerce.number().positive("Le prix de vente doit être supérieur à 0."),
  seuilAlerte: z.coerce.number().int().nonnegative("Le seuil d'alerte doit être positif."),
  quantiteInitiale: z.coerce.number().int().nonnegative().optional(),
  actif: z.boolean().optional(),
});

export type ProductFormData = z.infer<typeof productSchema>;
/** Forme brute avant le `coerce` de zod : ce que contiennent réellement les champs de `useForm`. */
export type ProductFormInput = z.input<typeof productSchema>;

export const categorySchema = z.object({
  nom: z.string().trim().min(2, "Le nom de la catégorie est requis."),
  description: z.string().trim().optional().or(z.literal("")),
});

export type CategoryFormData = z.infer<typeof categorySchema>;

export const stockAdjustmentSchema = z.object({
  variationQuantite: z.coerce.number().int().refine((value) => value !== 0, "La quantité ne peut pas être nulle."),
  note: z.string().trim().optional().or(z.literal("")),
});

export type StockAdjustmentFormData = z.infer<typeof stockAdjustmentSchema>;
export type StockAdjustmentFormInput = z.input<typeof stockAdjustmentSchema>;
