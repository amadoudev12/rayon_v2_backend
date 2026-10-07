import { z } from "zod";

export const onboardingSchema = z.object({
  nomOrganisation: z.string().trim().min(2, "Le nom de l'organisation est requis."),
  nomBoutique: z.string().trim().min(2, "Le nom de la boutique est requis."),
  adresseBoutique: z.string().trim().optional().or(z.literal("")),
  telephoneBoutique: z.string().trim().optional().or(z.literal("")),
  devise: z.enum(["XOF", "XAF", "EUR", "USD", "MAD", "GNF", "CDF"]).default("XOF"),
});

export type OnboardingFormData = z.infer<typeof onboardingSchema>;
export type OnboardingFormInput = z.input<typeof onboardingSchema>;
