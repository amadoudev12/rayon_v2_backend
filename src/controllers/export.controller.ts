import type { Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import { canViewFinance } from "@/services/billing/entitlements";
import { resolveRequestStoreId } from "@/lib/auth/store";
import { parsePeriod } from "@/lib/period";
import { searchParams } from "@/lib/api/response";
import { startCsv } from "@/lib/csv";
import { MOVEMENT_TYPE_LABELS, PAYMENT_LABELS, SALE_STATUS_LABEL } from "@/lib/labels";
import { Prisma } from "@/generated/prisma/client";
import { movementFilters } from "@/services/stock-movements";

/**
 * Exports CSV des données commerciales, produits par lots (aucun chargement
 * complet en mémoire), dans les mêmes limites d'accès que les écrans :
 * organisation et boutique du membre, coûts d'achat réservés à `report:view`.
 */
const BATCH = 1_000;

async function context(req: Request) {
  const params = searchParams(req);
  // Boutique du sélecteur du site (cookie), ou celle demandée explicitement.
  const storeId = await resolveRequestStoreId(req.user, Number(params.get("storeId")) || undefined);
  const organization = await prisma.organisation.findUniqueOrThrow({ where: { id: req.user.organizationId }, select: { fuseauHoraire: true } });
  return { params, storeId, timeZone: organization.fuseauHoraire };
}

export async function exportSales(req: Request, res: Response) {
  const { params, storeId, timeZone } = await context(req);
  const period = parsePeriod(params, new Date(), timeZone);
  const withCosts = await canViewFinance(req.user);
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
      // Coût des articles conservés par le client (montants exacts, jamais de flottants).
      const cost = withCosts
        ? sale.lignes.reduce((sum, line) => sum.plus(line.coutUnitaire.times(line.quantite - line.quantiteRetournee)), new Prisma.Decimal(0))
        : new Prisma.Decimal(0);
      write(
        [
          `VTE-${String(sale.id).padStart(5, "0")}`, sale.creeLe, SALE_STATUS_LABEL[sale.statut], sale.client?.nom ?? "Client de passage", `${sale.vendeur.prenom} ${sale.vendeur.nom}`,
          PAYMENT_LABELS[sale.modePaiement], sale.sousTotal, sale.remise, sale.total, sale.montantRetourne, sale.montantPaye, sale.resteAPayer, sale.dateEcheance,
          ...(withCosts
            ? [cost.toDecimalPlaces(2), sale.statut === "COMPLETED" ? sale.total.minus(sale.montantRetourne).minus(cost).toDecimalPlaces(2) : new Prisma.Decimal(0)]
            : []),
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
      write([
        row.produit.nom,
        row.produit.reference,
        row.produit.categorie?.nom,
        row.quantite,
        row.produit.seuilAlerte,
        row.produit.prixAchat,
        row.produit.prixAchat.times(row.quantite).toDecimalPlaces(2),
      ]);
    }
    if (rows.length < BATCH) break;
    cursor = rows[rows.length - 1]!.id;
  }
  res.end();
}

/**
 * Historique COMPLET des mouvements de stock correspondant aux filtres de
 * l'écran (et non la seule page affichée), sur une période bornée : ce mois-ci
 * par défaut, 366 jours au plus.
 */
export async function exportMovements(req: Request, res: Response) {
  const { where, period, timeZone } = await movementFilters(req.user, searchParams(req), { requirePeriod: true });
  const write = startCsv(res, `mouvements-stock-${period!.from}-${period!.to}.csv`, [
    "Date", "Produit", "Type", "Variation", "Stock avant", "Stock après", "Document", "Utilisateur", "Note",
  ]);
  let cursor: number | undefined;
  for (;;) {
    const movements = await prisma.mouvementStock.findMany({
      where,
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true, creeLe: true, type: true, variationQuantite: true, quantiteAvant: true, quantiteApres: true,
        sourceReference: true, venteId: true, achatId: true, note: true,
        produit: { select: { nom: true } },
        utilisateur: { select: { prenom: true, nom: true } },
      },
    });
    for (const movement of movements) {
      const document =
        movement.sourceReference ??
        (movement.venteId ? `VTE-${String(movement.venteId).padStart(5, "0")}` : movement.achatId ? `ACH-${String(movement.achatId).padStart(5, "0")}` : "");
      write(
        [
          movement.creeLe,
          movement.produit.nom,
          MOVEMENT_TYPE_LABELS[movement.type],
          movement.variationQuantite,
          movement.quantiteAvant,
          movement.quantiteApres,
          document,
          `${movement.utilisateur.prenom} ${movement.utilisateur.nom}`,
          movement.note,
        ],
        timeZone,
      );
    }
    if (movements.length < BATCH) break;
    cursor = movements[movements.length - 1]!.id;
  }
  res.end();
}
