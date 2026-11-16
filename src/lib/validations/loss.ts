import { z } from "zod";
import { LOSS_REASONS } from "@/lib/labels";

export const lossCreateSchema = z.object({
  boutiqueId: z.coerce.number().int().positive(),
  produitId: z.coerce.number().int().positive(),
  quantite: z.coerce.number().int().positive().max(1_000_000),
  motif: z.enum(LOSS_REASONS, { message: "Motif de perte invalide." }),
  description: z.string().trim().max(1000).optional(),
});

export type LossCreateInput = z.infer<typeof lossCreateSchema>;

export const lossCancelSchema = z.object({
  motif: z.string().trim().min(3, "Indiquez le motif de l'annulation (3 caractères au moins).").max(500),
});
