import { z } from "zod";
import { PaymentMethod } from "@/generated/prisma/enums";

/** Modes par lesquels de l'argent change réellement de main (jamais « crédit »). */
export const tenderSchema = z.enum(PaymentMethod).exclude(["CREDIT"], { error: "Mode de paiement invalide." });

export const saleItemSchema = z.object({
  produitId: z.coerce.number().int().positive("Produit invalide"),
  quantite: z.coerce.number().int().positive("La quantité doit être supérieure à 0"),
  /** Prix unitaire négocié avec le client ; absent : prix de vente du produit. */
  prixUnitaire: z.coerce.number().nonnegative("Le prix unitaire doit être positif ou nul.").optional(),
});

export const saleSchema = z.object({
  lignes: z.array(saleItemSchema).min(1, "Ajoutez au moins un produit").max(500, "Une vente est limitée à 500 lignes."),
  clientId: z.coerce.number().int().positive().optional().nullable(),
  boutiqueId: z.coerce.number().int().positive().optional().nullable(),
  modePaiement: z.enum(PaymentMethod).default("CASH"),
  remise: z.coerce.number().nonnegative("La remise doit être positive ou nulle.").default(0),
  /** Vente à crédit : premier versement (0 par défaut). Autres modes : la vente est payée en totalité. */
  montantPaye: z.coerce.number().nonnegative("Le montant payé doit être positif ou nul.").optional(),
  modePaiementAcompte: tenderSchema.optional(),
  note: z.string().trim().max(1000).optional().or(z.literal("")),
  /** Devis transformé en cette vente. */
  devisId: z.coerce.number().int().positive().optional().nullable(),
});

export type SaleFormData = z.infer<typeof saleSchema>;

/** Versement d'un client sur une vente (règlement d'une créance). */
export const salePaymentSchema = z.object({
  montant: z.coerce.number().positive("Le montant doit être supérieur à 0."),
  modePaiement: tenderSchema,
});

/**
 * Annulation : `REFUND` (défaut) quand l'argent reçu doit être rendu ;
 * `ENTRY_ERROR` pour une erreur de caisse du jour même où rien n'a été reçu.
 */
export const cancellationSchema = z.object({
  motif: z.string().trim().min(3, "Indiquez le motif (3 caractères au moins).").max(500),
  type: z.enum(["REFUND", "ENTRY_ERROR"]).default("REFUND"),
  remboursementImmediat: z.object({ modePaiement: tenderSchema }).optional(),
});

/** Retour d'articles : lignes de la vente, quantités et remise en stock. */
export const saleReturnSchema = z.object({
  motif: z.string().trim().min(3, "Indiquez le motif du retour (3 caractères au moins).").max(500),
  lignes: z
    .array(
      z.object({
        ligneVenteId: z.coerce.number().int().positive(),
        quantite: z.coerce.number().int().positive("La quantité retournée doit être supérieure à 0."),
        remiseEnStock: z.boolean(),
      }),
    )
    .min(1, "Sélectionnez au moins un article à retourner."),
  remboursementImmediat: z.object({ modePaiement: tenderSchema }).optional(),
});

/** Versement effectif d'un remboursement dû au client. */
export const refundPayoutSchema = z.object({
  montant: z.coerce.number().positive("Le montant doit être supérieur à 0."),
  modePaiement: tenderSchema,
});

export type SalePaymentFormData = z.infer<typeof salePaymentSchema>;
