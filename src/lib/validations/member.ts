import { z } from "zod";
import { Role } from "@/generated/prisma/enums";
import { identifierSchema } from "@/lib/validations/auth";

// Le rôle OWNER est attribué uniquement à la création de l'organisation, jamais via ce formulaire.
export const ASSIGNABLE_ROLES = [Role.ADMIN, Role.MANAGER, Role.SELLER, Role.STOCK_MANAGER] as const;

export const createMemberSchema = z.object({
  prenom: z.string().trim().min(2, "Le prénom est requis."),
  nom: z.string().trim().min(2, "Le nom est requis."),
  identifiant: identifierSchema,
  motDePasse: z
    .string()
    .min(8, "Le mot de passe doit contenir au moins 8 caractères.")
    .regex(/[A-Za-z]/, "Le mot de passe doit contenir au moins une lettre.")
    .regex(/[0-9]/, "Le mot de passe doit contenir au moins un chiffre."),
  role: z.enum(ASSIGNABLE_ROLES),
  boutiqueId: z.coerce.number().int().positive().optional().nullable(),
});

export type CreateMemberFormData = z.infer<typeof createMemberSchema>;
export type CreateMemberFormInput = z.input<typeof createMemberSchema>;

export const storeSchema = z.object({
  nom: z.string().trim().min(2, "Le nom de la boutique est requis."),
  adresse: z.string().trim().optional().or(z.literal("")),
  telephone: z.string().trim().optional().or(z.literal("")),
});

export type StoreFormData = z.infer<typeof storeSchema>;
