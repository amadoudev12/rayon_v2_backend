import { Prisma } from "@/generated/prisma/client";
import { sumDecimals } from "@/lib/money";
import type { SaleWithDetails } from "@/services/sale";
import { settlementState } from "@/services/sale-balance";

/**
 * Seule forme sous laquelle une vente quitte l'API. Les champs internes
 * (clés et empreintes d'idempotence) ne sortent jamais ; les coûts d'achat
 * figés ne sortent que pour les rôles autorisés (`report:view`).
 */
export function serializeSale(sale: SaleWithDetails, canViewCosts: boolean) {
  const {
    cleIdempotence: _key,
    empreinteIdempotence: _fingerprint,
    cleAnnulation: _cancelKey,
    lignes,
    retours,
    remboursements,
    paiements,
    ...rest
  } = sale;

  const refunds = remboursements.map((refund) => {
    const verse = sumDecimals(refund.versements.map((payout) => payout.montant));
    const { cleIdempotence: _refundKey, ...refundRest } = refund;
    return {
      ...refundRest,
      versements: refund.versements.map(({ cleIdempotence: _payoutKey, ...payout }) => payout),
      montantVerse: verse,
      montantRestant: refund.montant.minus(verse),
    };
  });
  const pendingRefund = sumDecimals(refunds.map((refund) => refund.montantRestant));

  return {
    ...rest,
    lignes: lignes.map(({ coutUnitaire, ...line }) => ({
      ...line,
      quantiteRestante: line.quantite - line.quantiteRetournee,
      ...(canViewCosts ? { coutUnitaire } : {}),
    })),
    paiements: paiements.map(({ cleIdempotence: _paymentKey, ...payment }) => ({ ...payment, annule: payment.annuleLe !== null })),
    remboursements: refunds,
    retours: retours.map(({ cleIdempotence: _returnKey, empreinteIdempotence: _returnFingerprint, coutTotal, lignes: returnLines, ...retour }) => ({
      ...retour,
      ...(canViewCosts ? { coutTotal } : {}),
      lignes: returnLines.map(({ coutUnitaire, ...line }) => ({ ...line, ...(canViewCosts ? { coutUnitaire } : {}) })),
    })),
    /** Montant encore dû au client (remboursements demandés non versés). */
    remboursementEnAttente: pendingRefund,
    etatFinancier: settlementState(sale, remboursements),
  };
}

/** Ligne du tableau des ventes : aucun coût, aucun champ interne. */
export function serializeSaleSummary(sale: {
  id: number;
  statut: SaleWithDetails["statut"];
  modePaiement: SaleWithDetails["modePaiement"];
  total: Prisma.Decimal;
  montantPaye: Prisma.Decimal;
  montantRetourne: Prisma.Decimal;
  montantARembourser: Prisma.Decimal;
  resteAPayer: Prisma.Decimal;
  typeAnnulation: SaleWithDetails["typeAnnulation"];
  creeLe: Date;
  lignes: { id: number; quantite: number; quantiteRetournee: number; produit: { id: number; nom: string } }[];
  client: { id: number; nom: string } | null;
  vendeur: { id: number; prenom: string; nom: string };
  remboursements: { montant: Prisma.Decimal; versements: { montant: Prisma.Decimal }[] }[];
}) {
  const { remboursements, ...rest } = sale;
  const pendingRefund = sumDecimals(
    remboursements.map((refund) => refund.montant.minus(sumDecimals(refund.versements.map((payout) => payout.montant)))),
  );
  return {
    ...rest,
    remboursementEnAttente: pendingRefund,
    etatFinancier: settlementState(sale, remboursements),
  };
}

/** Sélection Prisma explicite du tableau des ventes (jamais de `include` large). */
export const saleSummarySelect = {
  id: true,
  statut: true,
  modePaiement: true,
  total: true,
  montantPaye: true,
  montantRetourne: true,
  montantARembourser: true,
  resteAPayer: true,
  typeAnnulation: true,
  creeLe: true,
  lignes: { select: { id: true, quantite: true, quantiteRetournee: true, produit: { select: { id: true, nom: true } } } },
  client: { select: { id: true, nom: true } },
  vendeur: { select: { id: true, prenom: true, nom: true } },
  remboursements: { select: { montant: true, versements: { select: { montant: true } } } },
} satisfies Prisma.VenteSelect;
