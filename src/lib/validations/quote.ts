import { z } from "zod";
import { saleItemSchema } from "@/lib/validations/sale";

export const quoteSchema = z.object({
  lignes: z.array(saleItemSchema).min(1, "Ajoutez au moins un produit"),
  clientId: z.coerce.number().int().positive().optional().nullable(),
  /** Nom saisi librement quand le client n'est pas enregistré. */
  nomClient: z.string().trim().max(120).optional().or(z.literal("")),
  boutiqueId: z.coerce.number().int().positive().optional().nullable(),
  remise: z.coerce.number().nonnegative("La remise doit être positive ou nulle.").default(0),
  valableJusquAu: z.coerce.date().optional().nullable(),
  note: z.string().trim().optional().or(z.literal("")),
});

export type QuoteFormData = z.infer<typeof quoteSchema>;
