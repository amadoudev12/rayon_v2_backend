import type { PaymentMethod, SaleStatus } from "@/generated/prisma/enums";

/** Libellés des exports (mêmes textes que le site et le mobile). */
export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  CASH: "Espèces",
  CARD: "Carte",
  MOBILE_MONEY: "Mobile Money",
  CREDIT: "Crédit client",
  OTHER: "Autre",
};

export const SALE_STATUS_LABEL: Record<SaleStatus, string> = {
  COMPLETED: "Terminée",
  CANCELLED: "Annulée",
};
