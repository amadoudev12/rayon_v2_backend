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

/** Nombre maximal de lignes acceptées par un import de fichier. */
export const PRODUCT_IMPORT_MAX_ROWS = 1000;

/**
 * Une ligne d'un fichier importé : un produit dont la catégorie est donnée par
 * son nom (créée si elle n'existe pas) et non par son identifiant.
 */
export const productImportRowSchema = productSchema.omit({ categorieId: true, actif: true }).extend({
  categorie: z.string().trim().optional().or(z.literal("")),
  /** Numéro de la ligne dans le fichier, pour désigner les lignes ignorées. */
  ligne: z.coerce.number().int().positive().optional(),
});

export type ProductImportRow = z.infer<typeof productImportRowSchema>;

export const productImportSchema = z.object({
  lignes: z
    .array(productImportRowSchema)
    .min(1, "Le fichier ne contient aucun produit.")
    .max(PRODUCT_IMPORT_MAX_ROWS, `Un import est limité à ${PRODUCT_IMPORT_MAX_ROWS} produits.`),
});
