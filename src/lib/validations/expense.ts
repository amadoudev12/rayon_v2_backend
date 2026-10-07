import { z } from "zod";

export const EXPENSE_CATEGORIES = [
  "Loyer",
  "Salaires",
  "Électricité / eau",
  "Transport",
  "Fournitures",
  "Marketing",
  "Autre",
] as const;

export const expenseSchema = z.object({
  categorie: z.string().trim().min(1, "La catégorie est requise."),
  libelle: z.string().trim().min(2, "La description est requise."),
  montant: z.coerce.number().positive("Le montant doit être supérieur à 0."),
  note: z.string().trim().optional().or(z.literal("")),
  date: z.coerce.date().optional(),
  boutiqueId: z.coerce.number().int().positive().optional().nullable(),
});

export type ExpenseFormData = z.infer<typeof expenseSchema>;
export type ExpenseFormInput = z.input<typeof expenseSchema>;
