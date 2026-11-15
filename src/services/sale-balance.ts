import { Prisma } from "@/generated/prisma/client";
import { SaleStatus } from "@/generated/prisma/enums";

/**
 * Règles de solde d'une vente, communes au backend, au site et au mobile
 * (qui reçoivent les champs déjà calculés).
 *
 * - `montantPaye`        : paiements reçus et non annulés ;
 * - `montantRetourne`    : avoirs des retours (remise déduite) ;
 * - `montantARembourser` : remboursements dus au client (versés ou non) ;
 * - solde client         = total − retours − (payé − remboursements dus).
 *
 * Le solde n'est jamais négatif : ce que le client a payé en trop devient une
 * obligation de remboursement (et augmente `montantARembourser`).
 */
export type BalanceFields = {
  statut: SaleStatus;
  total: Prisma.Decimal;
  montantPaye: Prisma.Decimal;
  montantRetourne: Prisma.Decimal;
  montantARembourser: Prisma.Decimal;
};

const ZERO = new Prisma.Decimal(0);

/** Solde dû par le client ; 0 pour une vente annulée. */
export function customerBalance(sale: BalanceFields): Prisma.Decimal {
  if (sale.statut === SaleStatus.CANCELLED) return ZERO;
  const balance = sale.total.minus(sale.montantRetourne).minus(sale.montantPaye).plus(sale.montantARembourser);
  return balance.isNegative() ? ZERO : balance.toDecimalPlaces(2);
}

/**
 * Argent que le client a payé en trop par rapport à ce qu'il doit, et qui
 * n'est pas encore couvert par une obligation de remboursement.
 */
export function uncoveredOverpayment(sale: BalanceFields): Prisma.Decimal {
  const due = sale.statut === SaleStatus.CANCELLED ? ZERO : sale.total.minus(sale.montantRetourne);
  const excess = sale.montantPaye.minus(sale.montantARembourser).minus(due);
  return excess.isNegative() ? ZERO : excess.toDecimalPlaces(2);
}

export type SettlementState = "SOLDEE" | "CREANCE" | "REMBOURSEMENT_EN_ATTENTE";

/**
 * État financier affiché : une vente (même annulée) n'est soldée que lorsque
 * le client ne doit plus rien ET que tout remboursement dû a été versé.
 */
export function settlementState(
  sale: { resteAPayer: Prisma.Decimal },
  refunds: { montant: Prisma.Decimal; versements: { montant: Prisma.Decimal }[] }[],
): SettlementState {
  const pendingRefund = refunds.some((refund) =>
    refund.montant.greaterThan(refund.versements.reduce((sum, payout) => sum.plus(payout.montant), ZERO)),
  );
  if (pendingRefund) return "REMBOURSEMENT_EN_ATTENTE";
  if (sale.resteAPayer.greaterThan(0)) return "CREANCE";
  return "SOLDEE";
}

/**
 * Part nette de chaque ligne dans le total : la remise globale est répartie
 * au prorata des sous-totaux, arrondie au centime ; la dernière ligne reçoit
 * l'écart d'arrondi pour que la somme des parts soit exactement le total.
 */
export function netLineAmounts<L extends { id: number; sousTotal: Prisma.Decimal }>(
  lines: L[],
  sousTotal: Prisma.Decimal,
  total: Prisma.Decimal,
): Map<number, Prisma.Decimal> {
  const sorted = [...lines].sort((a, b) => a.id - b.id);
  const result = new Map<number, Prisma.Decimal>();
  let allocated = ZERO;
  sorted.forEach((line, index) => {
    const isLast = index === sorted.length - 1;
    const share = isLast
      ? total.minus(allocated)
      : sousTotal.isZero()
        ? ZERO
        : line.sousTotal.times(total).dividedBy(sousTotal).toDecimalPlaces(2);
    allocated = allocated.plus(share);
    result.set(line.id, share);
  });
  return result;
}
