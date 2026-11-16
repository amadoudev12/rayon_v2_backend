import { z } from "zod";
import { normalizePhone } from "@/lib/auth/identifier";

export const onboardingSchema = z.object({
  nomOrganisation: z.string().trim().min(2, "Le nom de l'organisation est requis."),
  nomBoutique: z.string().trim().min(2, "Le nom de la boutique est requis."),
  adresseBoutique: z.string().trim().optional().or(z.literal("")),
  // Obligatoire, avec l'indicatif du pays ; enregistré sous forme canonique (+2250707057565).
  telephoneBoutique: z
    .string({ message: "Le téléphone de la boutique est requis." })
    .trim()
    .min(1, "Le téléphone de la boutique est requis.")
    .refine((value) => normalizePhone(value) !== null, "Numéro invalide : indiquez l'indicatif du pays (ex : +225 07 07 05 75 65).")
    .transform((value) => normalizePhone(value) as string),
  devise: z.enum(["XOF", "XAF", "EUR", "USD", "MAD", "GNF", "CDF"]).default("XOF"),
});

export type OnboardingFormData = z.infer<typeof onboardingSchema>;
export type OnboardingFormInput = z.input<typeof onboardingSchema>;
