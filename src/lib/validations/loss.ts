import { z } from "zod";

export const lossCreateSchema = z.object({
  boutiqueId: z.coerce.number().int().positive(),
  produitId: z.coerce.number().int().positive(),
  quantite: z.coerce.number().int().positive(),
  motif: z.string().trim().min(2).max(100),
  description: z.string().trim().max(1000).optional(),
});
export const lossCancelSchema = z.object({ motif: z.string().trim().min(3).max(500) });
