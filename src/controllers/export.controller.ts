import type { Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/auth/permissions";
import { resolveActiveStoreId } from "@/lib/auth/session";
import { parsePeriod } from "@/lib/period";
import { searchParams } from "@/lib/api/response";
import { startCsv } from "@/lib/csv";
import { PAYMENT_LABELS, SALE_STATUS_LABEL } from "@/lib/labels";

/**
 * Exports CSV des données commerciales, produits par lots (aucun chargement
 * complet en mémoire), dans les mêmes limites d'accès que les écrans :
 * organisation et boutique du membre, coûts d'achat réservés à `report:view`.
 */
const BATCH = 1_000;

async function context(req: Request) {
  const params = searchParams(req);
  const storeId = await resolveActiveStoreId(req.user, Number(params.get("storeId")) || undefined);
  const organization = await prisma.organisation.findUniqueOrThrow({ where: { id: req.user.organizationId }, select: { fuseauHoraire: true } });
  return { params, storeId, timeZone: organization.fuseauHoraire };
}

export async function exportSales(req: Request, res: Response) {
  const { params, storeId, timeZone } = await context(req);
  const period = parsePeriod(params, new Date(), timeZone);
  const withCosts = can(req.user.role, "report:view");
  const write = startCsv(res, `ventes-${period.from}-${period.to}.csv`, [
    "Vente", "Date", "Statut", "Client", "Vendeur", "Paiement", "Sous-total", "Remise", "Total", "Retours", "Payé", "Reste à payer", "Échéance",
    ...(withCosts ? ["Coût des articles", "Marge brute"] : []),
  ]);
  let cursor: number | undefined;
  for (;;) {
    const sales = await prisma.vente.findMany({
      where: { organisationId: req.user.organizationId, boutiqueId: storeId, creeLe: { gte: period.start, lt: period.end } },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true, creeLe: true, statut: true, modePaiement: true, sousTotal: true, remise: true, total: true, montantRetourne: true, montantPaye: true, resteAPayer: true, dateEcheance: true,
        client: { select: { nom: true } },
        vendeur: { select: { prenom: true, nom: true } },
        lignes: withCosts ? { select: { quantite: true, quantiteRetournee: true, coutUnitaire: true } } : false,
      },
    });
    for (const sale of sales) {
      const cost = withCosts ? sale.lignes.reduce((sum, line) => sum + Number(line.coutUnitaire) * (line.quantite - line.quantiteRetournee), 0) : 0;
      write(
        [
          `VTE-${String(sale.id).padStart(5, "0")}`, sale.creeLe, SALE_STATUS_LABEL[sale.statut], sale.client?.nom ?? "Client de passage", `${sale.vendeur.prenom} ${sale.vendeur.nom}`,
          PAYMENT_LABELS[sale.modePaiement], sale.sousTotal, sale.remise, sale.total, sale.montantRetourne, sale.montantPaye, sale.resteAPayer, sale.dateEcheance,
          ...(withCosts ? [Math.round(cost * 100) / 100, sale.statut === "COMPLETED" ? Math.round((Number(sale.total) - Number(sale.montantRetourne) - cost) * 100) / 100 : 0] : []),
        ],
        timeZone,
      );
    }
    if (sales.length < BATCH) break;
    cursor = sales[sales.length - 1]!.id;
  }
  res.end();
}

export async function exportCredits(req: Request, res: Response) {
  const { storeId, timeZone } = await context(req);
  const write = startCsv(res, "creances.csv", ["Vente", "Date", "Client", "Téléphone", "Total", "Retours", "Payé", "Reste à payer", "Échéance", "En retard"]);
  let cursor: number | undefined;
  const now = new Date();
  for (;;) {
    const sales = await prisma.vente.findMany({
      where: { organisationId: req.user.organizationId, boutiqueId: storeId, statut: "COMPLETED", resteAPayer: { gt: 0 } },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: { id: true, creeLe: true, total: true, montantRetourne: true, montantPaye: true, resteAPayer: true, dateEcheance: true, client: { select: { nom: true, telephone: true } } },
    });
    for (const sale of sales) {
      write(
        [
          `VTE-${String(sale.id).padStart(5, "0")}`, sale.creeLe, sale.client?.nom ?? "—", sale.client?.telephone ?? "", sale.total, sale.montantRetourne, sale.montantPaye, sale.resteAPayer, sale.dateEcheance,
          sale.dateEcheance && sale.dateEcheance < now ? "oui" : "non",
        ],
        timeZone,
      );
    }
    if (sales.length < BATCH) break;
    cursor = sales[sales.length - 1]!.id;
  }
  res.end();
}

export async function exportPurchases(req: Request, res: Response) {
  const { params, storeId, timeZone } = await context(req);
  const period = parsePeriod(params, new Date(), timeZone);
  const write = startCsv(res, `achats-${period.from}-${period.to}.csv`, ["Achat", "Date", "Statut", "Fournisseur", "Total", "Payé", "Reste dû"]);
  let cursor: number | undefined;
  for (;;) {
    const purchases = await prisma.achat.findMany({
      where: { organisationId: req.user.organizationId, boutiqueId: storeId, creeLe: { gte: period.start, lt: period.end } },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: { id: true, creeLe: true, statut: true, total: true, montantPaye: true, resteAPayer: true, fournisseur: { select: { nom: true } } },
    });
    for (const purchase of purchases) {
      write(
        [`ACH-${String(purchase.id).padStart(5, "0")}`, purchase.creeLe, purchase.statut === "CANCELLED" ? "Annulé" : "Reçu", purchase.fournisseur?.nom ?? "—", purchase.total, purchase.montantPaye, purchase.resteAPayer],
        timeZone,
      );
    }
    if (purchases.length < BATCH) break;
    cursor = purchases[purchases.length - 1]!.id;
  }
  res.end();
}

export async function exportStock(req: Request, res: Response) {
  const { storeId } = await context(req);
  const write = startCsv(res, "stock.csv", ["Produit", "Référence", "Catégorie", "Quantité", "Seuil d'alerte", "Coût unitaire", "Valeur"]);
  let cursor: number | undefined;
  for (;;) {
    const rows = await prisma.stock.findMany({
      where: { boutiqueId: storeId, produit: { organisationId: req.user.organizationId, actif: true } },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: { id: true, quantite: true, produit: { select: { nom: true, reference: true, seuilAlerte: true, prixAchat: true, categorie: { select: { nom: true } } } } },
    });
    for (const row of rows) {
      write([row.produit.nom, row.produit.reference, row.produit.categorie?.nom, row.quantite, row.produit.seuilAlerte, row.produit.prixAchat, Math.round(row.quantite * Number(row.produit.prixAchat) * 100) / 100]);
    }
    if (rows.length < BATCH) break;
    cursor = rows[rows.length - 1]!.id;
  }
  res.end();
}
