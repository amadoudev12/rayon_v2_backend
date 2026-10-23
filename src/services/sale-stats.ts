import { prisma } from "@/lib/prisma";
import { PaymentMethod, SaleStatus } from "@/generated/prisma/enums";
import { toNumber } from "@/lib/money";
import type { AuthContext } from "@/lib/auth/session";

export type SalesStats = Awaited<ReturnType<typeof getSalesStats>>;

/**
 * Coûts, marge, dépenses et bénéfice ne sont transmis qu'aux rôles qui voient
 * les rapports (`report:view`) : un vendeur ne voit ni les coûts d'achat ni le
 * résultat de la boutique.
 */
export function visibleSalesStats(stats: SalesStats, canViewFinance: boolean) {
  if (canViewFinance) return stats;
  return { ...stats, costOfGoodsSold: null, grossMargin: null, expensesTotal: null, netProfit: null };
}

/**
 * Chiffres d'une boutique sur une période (page Ventes), lus en base.
 *
 * Règles de calcul (mêmes que le tableau de bord) :
 * - seules les ventes terminées comptent, jamais les annulées ;
 * - chiffre d'affaires = total des ventes créées sur la période (remises
 *   déduites), ventes à crédit comprises même si elles ne sont pas réglées ;
 * - encaissé = paiements reçus sur la période, y compris les versements sur
 *   des ventes plus anciennes : un paiement n'est jamais une nouvelle vente ;
 * - ventes à crédit = total des ventes à crédit créées sur la période ;
 * - créances restantes = ce que les clients doivent encore aujourd'hui, toutes
 *   dates de vente confondues ;
 * - coût des marchandises vendues = Σ coût unitaire figé × quantité ;
 * - marge brute = CA − coût des marchandises vendues ;
 * - bénéfice = marge brute − dépenses de la période (dépenses de la boutique
 *   et dépenses générales de l'organisation).
 */
export async function getSalesStats(context: AuthContext, storeId: number, period: { start: Date; end: Date }) {
  const organisationId = context.organizationId;
  const range = { gte: period.start, lt: period.end };
  const completed = { organisationId, boutiqueId: storeId, statut: SaleStatus.COMPLETED };
  const periodSales = { ...completed, creeLe: range };

  const [sales, creditSales, costLines, payments, paymentsOnOlderSales, outstanding, expenses] = await Promise.all([
    prisma.vente.aggregate({ where: periodSales, _sum: { total: true }, _count: true }),
    prisma.vente.aggregate({
      where: { ...periodSales, modePaiement: PaymentMethod.CREDIT },
      _sum: { total: true },
      _count: true,
    }),
    prisma.ligneVente.findMany({ where: { vente: periodSales }, select: { quantite: true, coutUnitaire: true } }),
    prisma.paiementVente.aggregate({ where: { date: range, vente: completed }, _sum: { montant: true } }),
    prisma.paiementVente.aggregate({
      where: { date: range, vente: { ...completed, creeLe: { lt: period.start } } },
      _sum: { montant: true },
    }),
    prisma.vente.aggregate({
      where: { ...completed, montantPaye: { lt: prisma.vente.fields.total } },
      _sum: { total: true, montantPaye: true },
      _count: true,
    }),
    prisma.depense.aggregate({
      where: { organisationId, OR: [{ boutiqueId: storeId }, { boutiqueId: null }], date: range },
      _sum: { montant: true },
    }),
  ]);

  const revenue = toNumber(sales._sum.total ?? 0);
  const costOfGoodsSold = costLines.reduce((total, line) => total + toNumber(line.coutUnitaire) * line.quantite, 0);
  const grossMargin = revenue - costOfGoodsSold;
  const expensesTotal = toNumber(expenses._sum.montant ?? 0);

  return {
    salesCount: sales._count,
    revenue,
    collected: toNumber(payments._sum.montant ?? 0),
    /** Part de l'encaissé qui rembourse des ventes antérieures à la période. */
    collectedOnOlderSales: toNumber(paymentsOnOlderSales._sum.montant ?? 0),
    creditSales: toNumber(creditSales._sum.total ?? 0),
    creditSalesCount: creditSales._count,
    outstanding: toNumber(outstanding._sum.total ?? 0) - toNumber(outstanding._sum.montantPaye ?? 0),
    outstandingCount: outstanding._count,
    costOfGoodsSold,
    grossMargin,
    expensesTotal,
    netProfit: grossMargin - expensesTotal,
  };
}
