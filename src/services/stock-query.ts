import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Lecture paginée du stock d'une boutique, entièrement en SQL : le seuil
 * effectif (seuil propre à la boutique, sinon celui du produit) et le filtre
 * « stock bas » sont calculés par PostgreSQL. Aucune lecture du catalogue
 * entier en mémoire, quelle que soit sa taille.
 */
export type StockRow = {
  id: number;
  boutiqueId: number;
  produitId: number;
  quantite: number;
  modifieLe: Date;
  seuilAlerte: number;
  niveau: "OUT" | "LOW" | "NORMAL";
  produit: { id: number; nom: string; unite: string; seuilAlerte: number; prixVente: number };
};

type RawRow = {
  id: number;
  boutiqueId: number;
  produitId: number;
  quantite: number;
  modifieLe: Date;
  seuil: number;
  nom: string;
  unite: string;
  prixVente: Prisma.Decimal;
};

export async function listStoreStock(options: {
  organisationId: number;
  storeId: number;
  search?: string;
  lowStockOnly?: boolean;
  page: number;
  limit: number;
}): Promise<{ rows: StockRow[]; total: number }> {
  const { organisationId, storeId, page, limit } = options;
  const search = options.search?.trim();
  const filters = Prisma.sql`
    s."boutiqueId" = ${storeId} AND p."organisationId" = ${organisationId} AND p."actif" = true
    ${search ? Prisma.sql`AND p."nom" ILIKE ${`%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`}` : Prisma.empty}
    ${options.lowStockOnly ? Prisma.sql`AND s."quantite" <= COALESCE(t."seuilAlerte", p."seuilAlerte")` : Prisma.empty}`;
  const from = Prisma.sql`
    FROM "Stock" s
    JOIN "Produit" p ON p."id" = s."produitId"
    LEFT JOIN "SeuilStockBoutique" t ON t."boutiqueId" = s."boutiqueId" AND t."produitId" = s."produitId"`;

  const [rows, totals] = await Promise.all([
    prisma.$queryRaw<RawRow[]>`
      SELECT s."id", s."boutiqueId", s."produitId", s."quantite", s."modifieLe",
             COALESCE(t."seuilAlerte", p."seuilAlerte") AS seuil, p."nom", p."unite", p."prixVente"
      ${from}
      WHERE ${filters}
      ORDER BY s."quantite" ASC, p."nom" ASC
      LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
    prisma.$queryRaw<{ total: bigint }[]>`SELECT COUNT(*) AS total ${from} WHERE ${filters}`,
  ]);

  return {
    total: Number(totals[0]?.total ?? 0),
    rows: rows.map((row) => ({
      id: row.id,
      boutiqueId: row.boutiqueId,
      produitId: row.produitId,
      quantite: row.quantite,
      modifieLe: row.modifieLe,
      seuilAlerte: row.seuil,
      niveau: row.quantite <= 0 ? "OUT" : row.quantite <= row.seuil ? "LOW" : "NORMAL",
      produit: { id: row.produitId, nom: row.nom, unite: row.unite, seuilAlerte: row.seuil, prixVente: Number(row.prixVente) },
    })),
  };
}
