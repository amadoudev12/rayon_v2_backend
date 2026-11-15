import type { AuthContext } from "@/lib/auth/session";
import { getFinancialSummary, visibleFinancials, type FinancialSummary } from "@/services/finance";

export type SalesStats = FinancialSummary;

/**
 * Chiffres d'une boutique sur une période (page Ventes). Même calcul que le
 * tableau de bord : voir `services/finance` pour les règles.
 */
export function getSalesStats(context: AuthContext, storeId: number, period: { start: Date; end: Date }) {
  return getFinancialSummary({ organisationId: context.organizationId, storeId }, period);
}

/** Masque coûts, marge, charges, pertes et résultat aux rôles sans `report:view`. */
export const visibleSalesStats = visibleFinancials;
