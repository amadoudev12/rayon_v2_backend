import { Prisma } from "@/generated/prisma/client";
import { PaymentMethod } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/money";

/**
 * SOURCE UNIQUE des chiffres financiers de Rayon : tableau de bord, page
 * Ventes, statistiques du jour, du mois ou d'une période, et mobile appellent
 * tous `getFinancialSummary`. Deux écrans ne peuvent donc pas se contredire.
 *
 * Règles (vérifiables à la main) :
 *
 * Chiffre d'affaires
 * - ventes brutes  = Σ total des ventes TERMINÉES créées sur la période
 *                    (remises déduites, ventes à crédit comprises) ;
 * - retours        = Σ avoirs émis sur la période, sur des ventes terminées ;
 * - CA net         = ventes brutes − retours.
 *
 * Trésorerie (argent réellement reçu ou rendu)
 * - encaissé       = Σ paiements datés de la période, quel que soit l'état de
 *                    la vente (un paiement reçu reste reçu, même si la vente
 *                    est annulée ensuite), hors paiements annulés pour
 *                    erreur de saisie (argent jamais reçu) ;
 * - remboursé      = Σ versements de remboursement datés de la période ;
 * - encaissé net   = encaissé − remboursé ;
 * - à rembourser   = remboursements dus non encore versés (à date, toutes
 *                    périodes) : ce n'est PAS une sortie d'argent.
 *
 * Résultat
 * - coût des ventes = Σ quantité × coût figé des lignes des ventes terminées
 *                     de la période, moins le coût figé des articles retournés ;
 * - marge brute     = CA net − coût des ventes ;
 * - charges         = dépenses de la boutique (+ charges générales seulement
 *                     dans la vue « toutes boutiques » : jamais imputées en
 *                     entier à chaque boutique) ;
 * - pertes          = pertes de stock déclarées + articles retournés non
 *                     revendables + écarts d'inventaire nets (négatifs moins
 *                     positifs), tous valorisés au coût figé de l'opération ;
 * - résultat net    = marge brute − charges − pertes.
 */
export type FinanceScope = { organisationId: number; storeId: number | null };
export type FinancePeriod = { start: Date; end: Date };

/** Modes de paiement suivis dans la caisse ; UNKNOWN : paiements historiques sans mode connu. */
type Tender = Exclude<PaymentMethod, "CREDIT"> | "UNKNOWN";

function storeFilter(alias: string, storeId: number | null) {
  return storeId === null ? Prisma.empty : Prisma.sql`AND ${Prisma.raw(`${alias}."boutiqueId"`)} = ${storeId}`;
}

async function sumOne(query: Prisma.Sql): Promise<Prisma.Decimal> {
  const rows = await prisma.$queryRaw<{ value: Prisma.Decimal | null }[]>(query);
  return rows[0]?.value ?? new Prisma.Decimal(0);
}

/** CA net d'une période (ventes brutes − retours), pour les comparaisons. */
export async function getNetRevenue(scope: FinanceScope, period: FinancePeriod): Promise<number> {
  const { organisationId, storeId } = scope;
  const [sales, returns] = await Promise.all([
    sumOne(Prisma.sql`SELECT SUM(v."total") AS value FROM "Vente" v
      WHERE v."organisationId" = ${organisationId} ${storeFilter("v", storeId)}
        AND v."statut" = 'COMPLETED' AND v."creeLe" >= ${period.start} AND v."creeLe" < ${period.end}`),
    sumOne(Prisma.sql`SELECT SUM(r."montant") AS value FROM "RetourVente" r JOIN "Vente" v ON v."id" = r."venteId"
      WHERE r."organisationId" = ${organisationId} ${storeFilter("r", storeId)}
        AND v."statut" = 'COMPLETED' AND r."creeLe" >= ${period.start} AND r."creeLe" < ${period.end}`),
  ]);
  return toNumber(sales.minus(returns));
}

export async function getFinancialSummary(scope: FinanceScope, period: FinancePeriod) {
  const { organisationId, storeId } = scope;
  const { start, end } = period;
  const store = (alias: string) => storeFilter(alias, storeId);

  const [
    salesRows,
    costOfSales,
    returnsRows,
    returnLosses,
    paymentRows,
    collectedOnOlderSales,
    payoutRows,
    pendingRows,
    outstandingRows,
    expenseRows,
    stockLosses,
    inventoryRows,
  ] = await Promise.all([
    prisma.$queryRaw<{ count: bigint; total: Prisma.Decimal | null; credit_count: bigint; credit_total: Prisma.Decimal | null }[]>`
      SELECT COUNT(*) AS count, SUM(v."total") AS total,
             COUNT(*) FILTER (WHERE v."modePaiement" = 'CREDIT') AS credit_count,
             SUM(v."total") FILTER (WHERE v."modePaiement" = 'CREDIT') AS credit_total
      FROM "Vente" v
      WHERE v."organisationId" = ${organisationId} ${store("v")}
        AND v."statut" = 'COMPLETED' AND v."creeLe" >= ${start} AND v."creeLe" < ${end}`,
    sumOne(Prisma.sql`SELECT SUM(l."quantite" * l."coutUnitaire") AS value
      FROM "LigneVente" l JOIN "Vente" v ON v."id" = l."venteId"
      WHERE v."organisationId" = ${organisationId} ${store("v")}
        AND v."statut" = 'COMPLETED' AND v."creeLe" >= ${start} AND v."creeLe" < ${end}`),
    prisma.$queryRaw<{ count: bigint; amount: Prisma.Decimal | null; cost: Prisma.Decimal | null }[]>`
      SELECT COUNT(*) AS count, SUM(r."montant") AS amount, SUM(r."coutTotal") AS cost
      FROM "RetourVente" r JOIN "Vente" v ON v."id" = r."venteId"
      WHERE r."organisationId" = ${organisationId} ${store("r")}
        AND v."statut" = 'COMPLETED' AND r."creeLe" >= ${start} AND r."creeLe" < ${end}`,
    // Articles retournés non revendables : perte, quel que soit l'état ultérieur de la vente.
    sumOne(Prisma.sql`SELECT SUM(lr."quantite" * lr."coutUnitaire") AS value
      FROM "LigneRetourVente" lr JOIN "RetourVente" r ON r."id" = lr."retourVenteId"
      WHERE r."organisationId" = ${organisationId} ${store("r")}
        AND lr."remiseEnStock" = false AND r."creeLe" >= ${start} AND r."creeLe" < ${end}`),
    prisma.$queryRaw<{ mode: PaymentMethod | null; amount: Prisma.Decimal }[]>`
      SELECT p."modePaiement" AS mode, SUM(p."montant") AS amount
      FROM "PaiementVente" p JOIN "Vente" v ON v."id" = p."venteId"
      WHERE v."organisationId" = ${organisationId} ${store("v")}
        AND p."annuleLe" IS NULL AND p."date" >= ${start} AND p."date" < ${end}
      GROUP BY p."modePaiement"`,
    sumOne(Prisma.sql`SELECT SUM(p."montant") AS value
      FROM "PaiementVente" p JOIN "Vente" v ON v."id" = p."venteId"
      WHERE v."organisationId" = ${organisationId} ${store("v")}
        AND p."annuleLe" IS NULL AND p."date" >= ${start} AND p."date" < ${end} AND v."creeLe" < ${start}`),
    prisma.$queryRaw<{ mode: PaymentMethod; amount: Prisma.Decimal }[]>`
      SELECT vr."modePaiement" AS mode, SUM(vr."montant") AS amount
      FROM "VersementRemboursement" vr
      JOIN "RemboursementVente" r ON r."id" = vr."remboursementVenteId"
      JOIN "Vente" v ON v."id" = r."venteId"
      WHERE v."organisationId" = ${organisationId} ${store("v")}
        AND vr."date" >= ${start} AND vr."date" < ${end}
      GROUP BY vr."modePaiement"`,
    prisma.$queryRaw<{ count: bigint; amount: Prisma.Decimal | null }[]>`
      SELECT COUNT(*) AS count, SUM(r."montant" - COALESCE(paid."amount", 0)) AS amount
      FROM "RemboursementVente" r
      JOIN "Vente" v ON v."id" = r."venteId"
      LEFT JOIN (
        SELECT "remboursementVenteId", SUM("montant") AS amount FROM "VersementRemboursement" GROUP BY "remboursementVenteId"
      ) paid ON paid."remboursementVenteId" = r."id"
      WHERE v."organisationId" = ${organisationId} ${store("v")} AND r."statut" <> 'COMPLETED'`,
    prisma.$queryRaw<{ count: bigint; amount: Prisma.Decimal | null }[]>`
      SELECT COUNT(*) AS count, SUM(v."resteAPayer") AS amount
      FROM "Vente" v
      WHERE v."organisationId" = ${organisationId} ${store("v")}
        AND v."statut" = 'COMPLETED' AND v."resteAPayer" > 0`,
    prisma.$queryRaw<{ store_amount: Prisma.Decimal | null; general_amount: Prisma.Decimal | null }[]>`
      SELECT SUM(d."montant") FILTER (WHERE d."boutiqueId" IS NOT NULL ${storeId === null ? Prisma.empty : Prisma.sql`AND d."boutiqueId" = ${storeId}`}) AS store_amount,
             SUM(d."montant") FILTER (WHERE d."boutiqueId" IS NULL) AS general_amount
      FROM "Depense" d
      WHERE d."organisationId" = ${organisationId} AND d."statut" = 'ACTIVE'
        AND d."date" >= ${start} AND d."date" < ${end}`,
    sumOne(Prisma.sql`SELECT SUM(ps."quantite" * ps."coutUnitaire") AS value
      FROM "PerteStock" ps
      WHERE ps."organisationId" = ${organisationId} ${store("ps")}
        AND ps."statut" = 'ACTIVE' AND ps."creeLe" >= ${start} AND ps."creeLe" < ${end}`),
    prisma.$queryRaw<{ shortfall: Prisma.Decimal | null; surplus: Prisma.Decimal | null }[]>`
      SELECT SUM(-m."variationQuantite" * COALESCE(m."coutUnitaire", 0)) FILTER (WHERE m."variationQuantite" < 0) AS shortfall,
             SUM(m."variationQuantite" * COALESCE(m."coutUnitaire", 0)) FILTER (WHERE m."variationQuantite" > 0) AS surplus
      FROM "MouvementStock" m JOIN "Boutique" b ON b."id" = m."boutiqueId"
      WHERE b."organisationId" = ${organisationId} ${store("m")}
        AND m."type" = 'INVENTORY_ADJUSTMENT' AND m."creeLe" >= ${start} AND m."creeLe" < ${end}`,
  ]);

  const zero = new Prisma.Decimal(0);
  const sales = salesRows[0]!;
  const returns = returnsRows[0]!;

  const byTender = (rows: { mode: PaymentMethod | null; amount: Prisma.Decimal }[]) => {
    const result: Record<Tender, number> = { CASH: 0, CARD: 0, MOBILE_MONEY: 0, OTHER: 0, UNKNOWN: 0 };
    for (const row of rows) {
      const key: Tender = row.mode && row.mode !== PaymentMethod.CREDIT ? row.mode : "UNKNOWN";
      result[key] += toNumber(row.amount);
    }
    return result;
  };
  const collected = paymentRows.reduce((sum, row) => sum.plus(row.amount), zero);
  const refunded = payoutRows.reduce((sum, row) => sum.plus(row.amount), zero);

  const grossSales = sales.total ?? zero;
  const returnsAmount = returns.amount ?? zero;
  const revenue = grossSales.minus(returnsAmount);
  const costOfGoodsSold = costOfSales.minus(returns.cost ?? zero);
  const grossMargin = revenue.minus(costOfGoodsSold);

  const storeExpenses = expenseRows[0]?.store_amount ?? zero;
  const generalExpenses = expenseRows[0]?.general_amount ?? zero;
  const generalExpensesIncluded = storeId === null;
  const expensesTotal = generalExpensesIncluded ? storeExpenses.plus(generalExpenses) : storeExpenses;

  const inventoryShortfall = inventoryRows[0]?.shortfall ?? zero;
  const inventorySurplus = inventoryRows[0]?.surplus ?? zero;
  const lossesTotal = stockLosses.plus(returnLosses).plus(inventoryShortfall).minus(inventorySurplus);
  const netProfit = grossMargin.minus(expensesTotal).minus(lossesTotal);

  return {
    // Chiffre d'affaires
    salesCount: Number(sales.count),
    grossSales: toNumber(grossSales),
    returns: toNumber(returnsAmount),
    returnsCount: Number(returns.count),
    revenue: toNumber(revenue),
    creditSales: toNumber(sales.credit_total ?? zero),
    creditSalesCount: Number(sales.credit_count),
    // Trésorerie
    collected: toNumber(collected),
    collectedByMethod: byTender(paymentRows),
    collectedOnOlderSales: toNumber(collectedOnOlderSales),
    refunded: toNumber(refunded),
    refundedByMethod: byTender(payoutRows),
    netCollected: toNumber(collected.minus(refunded)),
    pendingRefund: toNumber(pendingRows[0]?.amount ?? zero),
    pendingRefundCount: Number(pendingRows[0]?.count ?? 0),
    outstanding: toNumber(outstandingRows[0]?.amount ?? zero),
    outstandingCount: Number(outstandingRows[0]?.count ?? 0),
    // Résultat
    costOfSales: toNumber(costOfSales),
    returnsCost: toNumber(returns.cost ?? zero),
    costOfGoodsSold: toNumber(costOfGoodsSold),
    grossMargin: toNumber(grossMargin),
    grossMarginRate: revenue.greaterThan(0) ? toNumber(grossMargin.dividedBy(revenue).times(100)) : null,
    storeExpenses: toNumber(storeExpenses),
    generalExpenses: toNumber(generalExpenses),
    generalExpensesIncluded,
    expensesTotal: toNumber(expensesTotal),
    stockLosses: toNumber(stockLosses),
    returnLosses: toNumber(returnLosses),
    inventoryShortfall: toNumber(inventoryShortfall),
    inventorySurplus: toNumber(inventorySurplus),
    lossesTotal: toNumber(lossesTotal),
    netProfit: toNumber(netProfit),
  };
}

export type FinancialSummary = Awaited<ReturnType<typeof getFinancialSummary>>;

/** Champs réservés aux rôles qui voient les rapports (`report:view`). */
const RESTRICTED_FIELDS = [
  "costOfSales",
  "returnsCost",
  "costOfGoodsSold",
  "grossMargin",
  "grossMarginRate",
  "storeExpenses",
  "generalExpenses",
  "expensesTotal",
  "stockLosses",
  "returnLosses",
  "inventoryShortfall",
  "inventorySurplus",
  "lossesTotal",
  "netProfit",
] as const;

type Restricted = (typeof RESTRICTED_FIELDS)[number];
export type VisibleFinancialSummary = Omit<FinancialSummary, Restricted> & { [K in Restricted]: FinancialSummary[K] | null };

/**
 * Un vendeur voit le chiffre d'affaires et la caisse, jamais les coûts
 * d'achat, marges, charges, pertes ni le résultat.
 */
export function visibleFinancials(summary: FinancialSummary, canViewFinance: boolean): VisibleFinancialSummary {
  if (canViewFinance) return summary;
  const masked: VisibleFinancialSummary = { ...summary };
  for (const field of RESTRICTED_FIELDS) masked[field] = null;
  return masked;
}
