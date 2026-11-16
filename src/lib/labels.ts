import type { PaymentMethod, SaleStatus, StockMovementType } from "@/generated/prisma/enums";

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

/** Motifs de perte proposés à la déclaration (texte libre accepté pour l'historique). */
export const LOSS_REASONS = ["ENDOMMAGE", "CASSE", "PERIME", "VOL", "PERDU", "DESTRUCTION", "AUTRE"] as const;
export type LossReason = (typeof LOSS_REASONS)[number];

export const LOSS_REASON_LABELS: Record<LossReason, string> = {
  ENDOMMAGE: "Endommagé",
  CASSE: "Casse",
  PERIME: "Périmé",
  VOL: "Vol",
  PERDU: "Perdu",
  DESTRUCTION: "Destruction",
  AUTRE: "Autre",
};

/** Libellé d'un motif de perte ; les motifs historiques en texte libre restent tels quels. */
export function lossReasonLabel(motif: string): string {
  return LOSS_REASON_LABELS[motif as LossReason] ?? motif;
}

export const MOVEMENT_TYPE_LABELS: Record<StockMovementType, string> = {
  INITIAL: "Stock initial",
  PURCHASE: "Achat",
  PURCHASE_CANCELLATION: "Achat annulé",
  SALE: "Vente",
  SALE_CANCELLATION: "Vente annulée",
  SALE_RETURN: "Retour client",
  ADJUSTMENT: "Ajustement",
  INVENTORY_ADJUSTMENT: "Inventaire",
  LOSS: "Perte / casse",
  LOSS_CANCELLATION: "Perte annulée",
};
