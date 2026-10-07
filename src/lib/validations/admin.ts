import { z } from "zod";
import { identifierSchema } from "@/lib/validations/auth";

const passwordRule = z
  .string()
  .min(8, "Le mot de passe doit contenir au moins 8 caractères.")
  .regex(/[A-Za-z]/, "Le mot de passe doit contenir au moins une lettre.")
  .regex(/[0-9]/, "Le mot de passe doit contenir au moins un chiffre.");

/** Création d'une boutique (organisation + premier point de vente + propriétaire) par le super administrateur. */
export const adminCreateOrganizationSchema = z.object({
  nomOrganisation: z.string().trim().min(2, "Le nom de l'organisation est requis."),
  nomBoutique: z.string().trim().min(2, "Le nom du point de vente est requis."),
  devise: z.enum(["XOF", "XAF", "EUR", "USD", "MAD", "GNF", "CDF"]).default("XOF"),
  prenom: z.string().trim().min(2, "Le prénom est requis."),
  nom: z.string().trim().min(2, "Le nom est requis."),
  identifiant: identifierSchema,
  motDePasse: passwordRule,
});

export type AdminCreateOrganizationData = z.infer<typeof adminCreateOrganizationSchema>;
export type AdminCreateOrganizationInput = z.input<typeof adminCreateOrganizationSchema>;

/** Activation / désactivation d'une organisation ou d'un compte utilisateur. */
export const adminStatusSchema = z.object({ actif: z.boolean() });

export const adminProfileSchema = z
  .object({
    prenom: z.string().trim().min(2, "Le prénom doit contenir au moins 2 caractères."),
    nom: z.string().trim().min(2, "Le nom doit contenir au moins 2 caractères."),
    motDePasseActuel: z.string().optional().or(z.literal("")),
    nouveauMotDePasse: passwordRule.optional().or(z.literal("")),
  })
  .refine((data) => !data.nouveauMotDePasse || Boolean(data.motDePasseActuel), {
    path: ["motDePasseActuel"],
    message: "Saisissez votre mot de passe actuel pour le modifier.",
  });

export type AdminProfileData = z.infer<typeof adminProfileSchema>;
