import { Prisma } from "@/generated/prisma/client";
import { SaleStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/money";
import { addDateKeyDays, dateKeyAt, startOfDateKey, zonedMonthKey } from "@/lib/timezone";
import type { AuthContext } from "@/lib/auth/session";
import { getFinancialSummary, getNetRevenue, visibleFinancials } from "@/services/finance";

const TREND_DAYS = 7;
const LOW_STOCK_LIST_SIZE = 8;
const TOP_PRODUCTS_SIZE = 5;

export type DashboardStats = Awaited<ReturnType<typeof getDashboardStats>>;

/**
 * Tableau de bord d'une organisation (toutes boutiques si `storeId` est
 * null). Les chiffres financiers viennent de `services/finance` — la même
 * fonction que la page Ventes — pour le mois en cours et pour aujourd'hui.
 * Les coûts, marges, charges, pertes et résultats sont masqués (null) sans
 * la permission `report:view`.
 */
export async function getDashboardStats(context: AuthContext, storeId: number | null, canViewFinance: boolean) {
  const organisationId = context.organizationId;
  const now = new Date();
  const organization = await prisma.organisation.findUniqueOrThrow({ where: { id: organisationId }, select: { fuseauHoraire: true } });
  const timeZone = organization.fuseauHoraire;
  const todayKey = dateKeyAt(now, timeZone);
  const monthKeyLocal = zonedMonthKey(now, timeZone);
  const startOfToday = startOfDateKey(todayKey, timeZone);
  const startOfTomorrow = startOfDateKey(addDateKeyDays(todayKey, 1), timeZone);
  const startOfMonth = startOfDateKey(`${monthKeyLocal}-01`, timeZone);
  const trendStartKey = addDateKeyDays(todayKey, -(TREND_DAYS - 1));
  const startOfTrend = startOfDateKey(trendStartKey, timeZone);

  // Même durée écoulée, mais sur le mois précédent, pour comparer des périodes équivalentes.
  const [year, month] = monthKeyLocal.split("-").map(Number);
  const previousMonthKey = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
  const startOfPreviousMonth = startOfDateKey(`${previousMonthKey}-01`, timeZone);
  const endOfPreviousPeriod = new Date(
    Math.min(startOfPreviousMonth.getTime() + (now.getTime() - startOfMonth.getTime()), startOfMonth.getTime()),
  );

  const scope = { organisationId, storeId };
  const storeSql = (alias: string) => (storeId === null ? Prisma.empty : Prisma.sql`AND ${Prisma.raw(`${alias}."boutiqueId"`)} = ${storeId}`);

  const [
    monthSummary,
    todaySummary,
    previousRevenue,
    activeProductsCount,
    lowStockCounts,
    lowStockRows,
    topProductRows,
    trendSalesRows,
    trendReturnRows,
    recentSales,
    recentExpenses,
  ] = await Promise.all([
    getFinancialSummary(scope, { start: startOfMonth, end: startOfTomorrow }),
    getFinancialSummary(scope, { start: startOfToday, end: startOfTomorrow }),
    getNetRevenue(scope, { start: startOfPreviousMonth, end: endOfPreviousPeriod }),
    prisma.produit.count({ where: { organisationId, actif: true } }),
    prisma.$queryRaw<{ low: bigint; out: bigint }[]>`
      SELECT COUNT(*) AS low, COUNT(*) FILTER (WHERE s."quantite" <= 0) AS out
      FROM "Stock" s
      JOIN "Produit" p ON p."id" = s."produitId"
      LEFT JOIN "SeuilStockBoutique" t ON t."boutiqueId" = s."boutiqueId" AND t."produitId" = s."produitId"
      WHERE p."organisationId" = ${organisationId} AND p."actif" = true ${storeSql("s")}
        AND s."quantite" <= COALESCE(t."seuilAlerte", p."seuilAlerte")`,
    prisma.$queryRaw<{ productId: number; productName: string; unit: string; storeId: number; storeName: string; quantity: number; alertThreshold: number }[]>`
      SELECT p."id" AS "productId", p."nom" AS "productName", p."unite" AS unit, b."id" AS "storeId", b."nom" AS "storeName",
             s."quantite" AS quantity, COALESCE(t."seuilAlerte", p."seuilAlerte") AS "alertThreshold"
      FROM "Stock" s
      JOIN "Produit" p ON p."id" = s."produitId"
      JOIN "Boutique" b ON b."id" = s."boutiqueId"
      LEFT JOIN "SeuilStockBoutique" t ON t."boutiqueId" = s."boutiqueId" AND t."produitId" = s."produitId"
      WHERE p."organisationId" = ${organisationId} AND b."organisationId" = ${organisationId} AND p."actif" = true ${storeSql("s")}
        AND s."quantite" <= COALESCE(t."seuilAlerte", p."seuilAlerte")
      ORDER BY s."quantite" ASC, p."nom" ASC
      LIMIT ${LOW_STOCK_LIST_SIZE}`,
    // Quantités nettes des retours ; montant au prorata des quantités conservées, avant remise globale.
    prisma.$queryRaw<{ productId: number; productName: string; unit: string; quantity: bigint; amount: Prisma.Decimal }[]>`
      SELECT p."id" AS "productId", p."nom" AS "productName", p."unite" AS unit,
             SUM(l."quantite" - l."quantiteRetournee") AS quantity,
             SUM(l."sousTotal" * (l."quantite" - l."quantiteRetournee") / l."quantite") AS amount
      FROM "LigneVente" l
      JOIN "Vente" v ON v."id" = l."venteId"
      JOIN "Produit" p ON p."id" = l."produitId"
      WHERE v."organisationId" = ${organisationId} ${storeSql("v")}
        AND v."statut" = 'COMPLETED' AND v."creeLe" >= ${startOfMonth} AND v."creeLe" < ${startOfTomorrow}
      GROUP BY p."id", p."nom", p."unite"
      HAVING SUM(l."quantite" - l."quantiteRetournee") > 0
      ORDER BY quantity DESC
      LIMIT ${TOP_PRODUCTS_SIZE}`,
    prisma.$queryRaw<{ day: string; total: Prisma.Decimal; count: bigint }[]>`
      SELECT to_char(timezone(${timeZone}, v."creeLe" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
             SUM(v."total") AS total, COUNT(*) AS count
      FROM "Vente" v
      WHERE v."organisationId" = ${organisationId} ${storeSql("v")}
        AND v."statut" = 'COMPLETED' AND v."creeLe" >= ${startOfTrend} AND v."creeLe" < ${startOfTomorrow}
      GROUP BY 1`,
    prisma.$queryRaw<{ day: string; total: Prisma.Decimal }[]>`
      SELECT to_char(timezone(${timeZone}, r."creeLe" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, SUM(r."montant") AS total
      FROM "RetourVente" r JOIN "Vente" v ON v."id" = r."venteId"
      WHERE r."organisationId" = ${organisationId} ${storeSql("r")}
        AND v."statut" = 'COMPLETED' AND r."creeLe" >= ${startOfTrend} AND r."creeLe" < ${startOfTomorrow}
      GROUP BY 1`,
    prisma.vente.findMany({
      where: { organisationId, ...(storeId ? { boutiqueId: storeId } : {}) },
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
    canViewFinance
      ? prisma.depense.findMany({
          where: { organisationId, statut: "ACTIVE", ...(storeId ? { OR: [{ boutiqueId: storeId }, { boutiqueId: null }] } : {}) },
          orderBy: { date: "desc" },
          take: 8,
          select: { id: true, libelle: true, categorie: true, montant: true, date: true },
        })
      : Promise.resolve([]),
  ]);

  const month_ = visibleFinancials(monthSummary, canViewFinance);
  const today = visibleFinancials(todaySummary, canViewFinance);

  // --- Évolution sur 7 jours (CA net par jour, dans le fuseau de l'organisation) ---
  const salesByDay = new Map(trendSalesRows.map((row) => [row.day, row]));
  const returnsByDay = new Map(trendReturnRows.map((row) => [row.day, toNumber(row.total)]));
  const trend = Array.from({ length: TREND_DAYS }, (_, index) => {
    const dayKey = addDateKeyDays(trendStartKey, index);
    const row = salesByDay.get(dayKey);
    return {
      day: new Intl.DateTimeFormat("fr-FR", { timeZone, weekday: "short", day: "numeric" }).format(startOfDateKey(dayKey, timeZone)),
      value: (row ? toNumber(row.total) : 0) - (returnsByDay.get(dayKey) ?? 0),
      count: row ? Number(row.count) : 0,
    };
  });

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
    period: {
      start: startOfMonth,
      previousStart: startOfPreviousMonth,
      previousEnd: endOfPreviousPeriod,
      // Mois au format « AAAA-MM » dans le fuseau de l'organisation.
      month: monthKeyLocal,
      previousMonth: previousMonthKey,
    },
    /** Décomposition complète du mois et du jour (même structure que la page Ventes). */
    month: month_,
    today,
    // Raccourcis historiques, lus par le site et le mobile.
    revenue: month_.revenue,
    previousRevenue,
    /** Variation en % par rapport à la même période du mois précédent ; null si rien à comparer. */
    revenueChange: previousRevenue > 0 ? ((month_.revenue - previousRevenue) / previousRevenue) * 100 : null,
    salesCount: month_.salesCount,
    averageBasket: month_.salesCount > 0 ? month_.grossSales / month_.salesCount : 0,
    todayRevenue: today.revenue,
    todaySalesCount: today.salesCount,
    todayCollected: today.collected,
    todayRefunded: today.refunded,
    todayNetCollected: today.netCollected,
    pendingRefund: month_.pendingRefund,
    costOfGoodsSold: month_.costOfGoodsSold,
    grossMargin: month_.grossMargin,
    grossMarginRate: month_.grossMarginRate,
    expensesTotal: month_.expensesTotal,
    netProfit: month_.netProfit,
    activeProductsCount,
    lowStockCount: Number(lowStockCounts[0]?.low ?? 0),
    outOfStockCount: Number(lowStockCounts[0]?.out ?? 0),
    lowStock: lowStockRows,
    topProducts: topProductRows.map((row) => ({
      productId: row.productId,
      productName: row.productName,
      unit: row.unit,
      quantity: Number(row.quantity),
      /** Montant des lignes conservées, avant la remise globale de la vente. */
      amount: toNumber(row.amount),
    })),
    trend,
    recentActivity,
  };
}
