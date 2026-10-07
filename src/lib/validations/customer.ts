import { z } from "zod";

export const customerSchema = z.object({
  nom: z.string().trim().min(2, "Le nom du client est requis."),
  telephone: z.string().trim().optional().or(z.literal("")),
  email: z.string().trim().email("Adresse email invalide.").optional().or(z.literal("")),
  adresse: z.string().trim().optional().or(z.literal("")),
});

export type CustomerFormData = z.infer<typeof customerSchema>;
