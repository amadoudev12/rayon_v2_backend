import { z } from "zod";
import { IDENTIFIER_FORMAT_MESSAGE, parseIdentifier } from "@/lib/auth/identifier";

/** Identifiant de connexion : adresse email ou numéro de téléphone avec indicatif. */
export const identifierSchema = z
  .string()
  .trim()
  .min(1, "L'email ou le numéro de téléphone est obligatoire.")
  .refine((value) => parseIdentifier(value) !== null, IDENTIFIER_FORMAT_MESSAGE);

export const registerSchema = z.object({
  prenom: z
    .string()
    .trim()
    .min(2, "Le prénom doit contenir au moins 2 caractères."),
  nom: z
    .string()
    .trim()
    .min(2, "Le nom doit contenir au moins 2 caractères."),
  identifiant: identifierSchema,
  motDePasse: z
    .string()
    .min(8, "Le mot de passe doit contenir au moins 8 caractères.")
    .regex(/[A-Za-z]/, "Le mot de passe doit contenir au moins une lettre.")
    .regex(/[0-9]/, "Le mot de passe doit contenir au moins un chiffre."),
});

export type RegisterFormData = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  identifiant: identifierSchema,
  motDePasse: z.string().min(1, "Le mot de passe est obligatoire."),
});

export type LoginFormData = z.infer<typeof loginSchema>;
