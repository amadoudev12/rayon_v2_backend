import { z } from "zod";
import { PaymentMethod } from "@/generated/prisma/enums";

export const saleItemSchema = z.object({
  produitId: z.coerce.number().int().positive("Produit invalide"),
  quantite: z.coerce.number().int().positive("La quantité doit être supérieure à 0"),
});

export const saleSchema = z.object({
  lignes: z.array(saleItemSchema).min(1, "Ajoutez au moins un produit"),
  clientId: z.coerce.number().int().positive().optional().nullable(),
  boutiqueId: z.coerce.number().int().positive().optional().nullable(),
  modePaiement: z.enum(PaymentMethod).default("CASH"),
  remise: z.coerce.number().nonnegative("La remise doit être positive ou nulle.").default(0),
  /** Vente à crédit : premier versement (0 par défaut). Autres modes : la vente est payée en totalité. */
  montantPaye: z.coerce.number().nonnegative("Le montant payé doit être positif ou nul.").optional(),
  note: z.string().trim().optional().or(z.literal("")),
});

export type SaleFormData = z.infer<typeof saleSchema>;

/** Versement d'un client sur une vente (remboursement d'une créance). */
export const salePaymentSchema = z.object({
  montant: z.coerce.number().positive("Le montant doit être supérieur à 0."),
});

export type SalePaymentFormData = z.infer<typeof salePaymentSchema>;
