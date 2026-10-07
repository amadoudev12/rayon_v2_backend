import { prisma } from "@/lib/prisma";
import { SaleStatus } from "@/generated/prisma/enums";
import { toNumber } from "@/lib/money";
import type { AuthContext } from "@/lib/auth/session";

const TREND_DAYS = 7;
const LOW_STOCK_LIST_SIZE = 8;
const TOP_PRODUCTS_SIZE = 5;

export type DashboardStats = Awaited<ReturnType<typeof getDashboardStats>>;

/**
 * Agrège les chiffres dont un commerçant a réellement besoin, limités à son
 * organisation (et éventuellement à une seule boutique). Chaque lecture passe
 * par `organisationId`/`boutiqueId` : on ne fait confiance au client que pour
 * le choix de la boutique à afficher.
 *
 * Règles de calcul :
 * - seules les ventes terminées (COMPLETED) comptent, jamais les annulées ;
 * - le chiffre d'affaires est le `total` des ventes, donc remises déduites ;
 * - la marge brute = chiffre d'affaires − coût d'achat des articles vendus
 *   (coût figé sur chaque ligne au moment de la vente) ;
 * - le bénéfice net = marge brute − dépenses de la période ;
 * - les dépenses d'une boutique incluent les dépenses générales de
 *   l'organisation (sans boutique), qui concernent toutes les boutiques.
 */
export async function getDashboardStats(context: AuthContext, storeId: number | null) {
  const organisationId = context.organizationId;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfTrend = new Date(startOfToday);
  startOfTrend.setDate(startOfTrend.getDate() - (TREND_DAYS - 1));

  // Même durée écoulée, mais sur le mois précédent (ex : du 1er au 30 à 14h),
  // pour comparer des périodes équivalentes et non un mois entier à un mois
  // en cours.
  const startOfPreviousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfPreviousPeriod = new Date(
    Math.min(startOfPreviousMonth.getTime() + (now.getTime() - startOfMonth.getTime()), startOfMonth.getTime()),
  );

  const saleScope = storeId ? { organisationId, boutiqueId: storeId } : { organisationId };
  const completed = { ...saleScope, statut: SaleStatus.COMPLETED };
  const monthSaleWhere = { ...completed, creeLe: { gte: startOfMonth } };
  const expenseScope = {
    organisationId,
    ...(storeId ? { OR: [{ boutiqueId: storeId }, { boutiqueId: null }] } : {}),
  };

  const [
    monthSales,
    previousSales,
    todaySales,
    monthCostLines,
    monthExpenses,
    activeProductsCount,
    stockRows,
    topProductRows,
    trendSales,
    recentSales,
    recentExpenses,
  ] = await Promise.all([
    prisma.vente.aggregate({ where: monthSaleWhere, _sum: { total: true }, _count: true }),
    prisma.vente.aggregate({
      where: { ...completed, creeLe: { gte: startOfPreviousMonth, lt: endOfPreviousPeriod } },
      _sum: { total: true },
    }),
    prisma.vente.aggregate({ where: { ...completed, creeLe: { gte: startOfToday } }, _sum: { total: true }, _count: true }),
    prisma.ligneVente.findMany({
      where: { vente: monthSaleWhere },
      select: { quantite: true, coutUnitaire: true },
    }),
    prisma.depense.aggregate({
      where: { ...expenseScope, date: { gte: startOfMonth } },
      _sum: { montant: true },
    }),
    prisma.produit.count({ where: { organisationId, actif: true } }),
    prisma.stock.findMany({
      where: {
        ...(storeId ? { boutiqueId: storeId } : { boutique: { organisationId } }),
        produit: { organisationId, actif: true },
      },
      select: {
        quantite: true,
        produit: { select: { id: true, nom: true, unite: true, seuilAlerte: true } },
        boutique: { select: { id: true, nom: true } },
      },
    }),
    prisma.ligneVente.groupBy({
      by: ["produitId"],
      where: { vente: monthSaleWhere },
      _sum: { quantite: true, sousTotal: true },
      orderBy: { _sum: { quantite: "desc" } },
      take: TOP_PRODUCTS_SIZE,
    }),
    prisma.vente.findMany({
      where: { ...completed, creeLe: { gte: startOfTrend } },
      select: { creeLe: true, total: true },
    }),
    prisma.vente.findMany({
      where: saleScope,
      orderBy: { creeLe: "desc" },
      take: 8,
      select: {
        id: true,
        total: true,
        statut: true,
        creeLe: true,
        vendeur: { select: { prenom: true, nom: true } },
        client: { select: { nom: true } },
      },
    }),
    prisma.depense.findMany({
      where: expenseScope,
      orderBy: { date: "desc" },
      take: 8,
      select: { id: true, libelle: true, categorie: true, montant: true, date: true },
    }),
  ]);

  // --- Chiffres du mois -----------------------------------------------------
  const revenue = toNumber(monthSales._sum.total ?? 0);
  const previousRevenue = toNumber(previousSales._sum.total ?? 0);
  const salesCount = monthSales._count;
  const costOfGoodsSold = monthCostLines.reduce(
    (total, line) => total + toNumber(line.coutUnitaire) * line.quantite,
    0,
  );
  const grossMargin = revenue - costOfGoodsSold;
  const expensesTotal = toNumber(monthExpenses._sum.montant ?? 0);

  // --- Stock ----------------------------------------------------------------
  const lowStockRows = stockRows
    .filter((row) => row.quantite <= row.produit.seuilAlerte)
    .sort((a, b) => a.quantite - b.quantite);

  // --- Meilleures ventes ----------------------------------------------------
  const topProductNames = await prisma.produit.findMany({
    where: { id: { in: topProductRows.map((row) => row.produitId) }, organisationId },
    select: { id: true, nom: true, unite: true },
  });
  const namesById = new Map(topProductNames.map((product) => [product.id, product]));

  // --- Évolution sur 7 jours ------------------------------------------------
  const trend = Array.from({ length: TREND_DAYS }, (_, index) => {
    const date = new Date(startOfTrend);
    date.setDate(startOfTrend.getDate() + index);
    const nextDate = new Date(date);
    nextDate.setDate(date.getDate() + 1);
    const daySales = trendSales.filter((sale) => sale.creeLe >= date && sale.creeLe < nextDate);
    return {
      day: date.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric" }),
      value: daySales.reduce((total, sale) => total + toNumber(sale.total), 0),
      count: daySales.length,
    };
  });

  // --- Activité récente -----------------------------------------------------
  const recentActivity = [
    ...recentSales.map((sale) => ({
      type: "sale" as const,
      id: sale.id,
      label: sale.client?.nom ? `Vente à ${sale.client.nom}` : `Vente #${String(sale.id).padStart(5, "0")}`,
      subtitle: `${sale.vendeur.prenom} ${sale.vendeur.nom}`,
      amount: toNumber(sale.total),
      cancelled: sale.statut === SaleStatus.CANCELLED,
      createdAt: sale.creeLe,
    })),
    ...recentExpenses.map((expense) => ({
      type: "expense" as const,
      id: expense.id,
      label: expense.libelle,
      subtitle: expense.categorie,
      amount: -toNumber(expense.montant),
      cancelled: false,
      createdAt: expense.date,
    })),
  ]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 8);

  return {
    period: { start: startOfMonth, previousStart: startOfPreviousMonth, previousEnd: endOfPreviousPeriod },
    revenue,
    previousRevenue,
    /** Variation en % par rapport à la même période du mois précédent ; null si rien à comparer. */
    revenueChange: previousRevenue > 0 ? ((revenue - previousRevenue) / previousRevenue) * 100 : null,
    salesCount,
    averageBasket: salesCount > 0 ? revenue / salesCount : 0,
    todayRevenue: toNumber(todaySales._sum.total ?? 0),
    todaySalesCount: todaySales._count,
    costOfGoodsSold,
    grossMargin,
    /** Taux de marge en % du chiffre d'affaires ; null sans ventes. */
    grossMarginRate: revenue > 0 ? (grossMargin / revenue) * 100 : null,
    expensesTotal,
    netProfit: grossMargin - expensesTotal,
    activeProductsCount,
    lowStockCount: lowStockRows.length,
    outOfStockCount: lowStockRows.filter((row) => row.quantite <= 0).length,
    lowStock: lowStockRows.slice(0, LOW_STOCK_LIST_SIZE).map((row) => ({
      productId: row.produit.id,
      productName: row.produit.nom,
      unit: row.produit.unite,
      storeId: row.boutique.id,
      storeName: row.boutique.nom,
      quantity: row.quantite,
      alertThreshold: row.produit.seuilAlerte,
    })),
    topProducts: topProductRows.map((row) => ({
      productId: row.produitId,
      productName: namesById.get(row.produitId)?.nom ?? "Produit supprimé",
      unit: namesById.get(row.produitId)?.unite ?? "",
      quantity: row._sum.quantite ?? 0,
      /** Montant des lignes, avant la remise globale de la vente. */
      amount: toNumber(row._sum.sousTotal ?? 0),
    })),
    trend,
    recentActivity,
  };
}
