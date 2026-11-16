import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { AuthContext } from "@/lib/auth/session";
import { listStoreStock } from "@/services/stock-query";

/**
 * Rapports de stock d'une boutique : alertes (ruptures, stocks bas, pertes
 * répétées) et valorisation au coût d'achat courant. Montants exacts
 * (Decimal), calculés en SQL.
 */

/** Nombre de déclarations actives sur 30 jours à partir duquel un produit est signalé. */
const REPEATED_LOSS_THRESHOLD = 3;
const REPEATED_LOSS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Alertes : ruptures et stocks bas (calculés en SQL, 500 au plus) et produits
 * ayant subi au moins 3 pertes actives sur 30 jours.
 */
export async function getStockAlerts(context: AuthContext, storeId: number) {
  const cutoff = new Date(Date.now() - REPEATED_LOSS_WINDOW_MS);

  const [low, lossGroups] = await Promise.all([
    listStoreStock({ organisationId: context.organizationId, storeId, lowStockOnly: true, page: 1, limit: 500 }),
    prisma.perteStock.groupBy({
      by: ["produitId"],
      where: { organisationId: context.organizationId, boutiqueId: storeId, statut: "ACTIVE", creeLe: { gte: cutoff } },
      _count: { id: true },
      _sum: { quantite: true },
    }),
  ]);

  const stockAlerts = low.rows.map((row) => ({
    type: "STOCK" as const,
    produitId: row.produitId,
    produit: row.produit.nom,
    quantite: row.quantite,
    seuilAlerte: row.seuilAlerte,
    niveau: row.niveau,
  }));

  const repeated = lossGroups.filter((row) => row._count.id >= REPEATED_LOSS_THRESHOLD);
  const details = await prisma.produit.findMany({
    where: { organisationId: context.organizationId, id: { in: repeated.map((row) => row.produitId) } },
    select: { id: true, nom: true, seuilAlerte: true },
  });
  const byId = new Map(details.map((product) => [product.id, product]));
  const lossAlerts = repeated.flatMap((row) => {
    const product = byId.get(row.produitId);
    if (!product) return [];
    return [
      {
        type: "REPEATED_LOSS" as const,
        produitId: row.produitId,
        produit: product.nom,
        quantite: row._sum.quantite ?? 0,
        seuilAlerte: product.seuilAlerte,
        niveau: "REPEATED_LOSS" as const,
        occurrences: row._count.id,
      },
    ];
  });

  return [...stockAlerts, ...lossAlerts];
}

const VALUATION_LIMIT = 500;

/**
 * Valeur du stock actuel de la boutique au coût d'achat courant de chaque
 * produit, calculée en SQL avec des montants exacts. Les 500 produits les plus
 * coûteux en stock sont détaillés ; les totaux portent sur TOUT le stock
 * (l'export CSV du stock donne le détail complet).
 */
export async function getStockValuation(context: AuthContext, storeId: number) {
  const scope = Prisma.sql`
    s."boutiqueId" = ${storeId} AND p."organisationId" = ${context.organizationId}
    AND p."actif" = true AND s."quantite" > 0`;

  const [totals, lines] = await Promise.all([
    prisma.$queryRaw<{ products: number; quantity: bigint | null; value: Prisma.Decimal | null }[]>`
      SELECT COUNT(*)::int AS products, SUM(s."quantite") AS quantity, SUM(s."quantite" * p."prixAchat") AS value
      FROM "Stock" s JOIN "Produit" p ON p."id" = s."produitId"
      WHERE ${scope}`,
    prisma.$queryRaw<{ produitId: number; produit: string; reference: string | null; unite: string; quantite: number; coutUnitaire: Prisma.Decimal; valeur: Prisma.Decimal }[]>`
      SELECT p."id" AS "produitId", p."nom" AS produit, p."reference", p."unite",
             s."quantite", p."prixAchat" AS "coutUnitaire", s."quantite" * p."prixAchat" AS valeur
      FROM "Stock" s JOIN "Produit" p ON p."id" = s."produitId"
      WHERE ${scope}
      ORDER BY valeur DESC, p."nom" ASC
      LIMIT ${VALUATION_LIMIT}`,
  ]);

  const total = totals[0];
  return {
    lignes: lines,
    produits: total?.products ?? 0,
    quantiteTotale: Number(total?.quantity ?? 0),
    valeurTotale: total?.value ?? new Prisma.Decimal(0),
    detailComplet: (total?.products ?? 0) <= VALUATION_LIMIT,
    methode: "Coût d'achat courant de chaque produit (dernier coût enregistré).",
  };
}
