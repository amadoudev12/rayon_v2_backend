import type { Request, Response } from "express";
import * as dashboardService from "@/services/dashboard";
import { getSalesStats, visibleSalesStats } from "@/services/sale-stats";
import { saleSummarySelect, serializeSaleSummary } from "@/lib/serializers/sale";
import { pricingLimitsFor } from "@/services/pricing-policy";
import { archiveFilter } from "@/services/party";
import { listStoreStock } from "@/services/stock-query";
import { PaymentMethod, SaleStatus, StockMovementType } from "@/generated/prisma/enums";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { parsePeriod } from "@/lib/period";
import { containsText } from "@/lib/search";
import { getOnboardingRedirect, getSession, getSuspendedRedirect } from "@/lib/auth/session";
import { getActiveStoreId } from "@/lib/auth/store";
import { can } from "@/lib/auth/permissions";
import { getPagination, paginationMeta } from "@/lib/api/pagination";
import { jsonData, searchParams } from "@/lib/api/response";
import { PageRedirect } from "@/lib/api/errors";

/**
 * Lectures de page du site web (`/api/pages/**`) : espace boutique.
 *
 * Chaque fonction renvoie, en une requête, tout ce qu'une page affiche. Le
 * compte est revérifié en base par le middleware `verifyPageToken`, les
 * données sont filtrées par organisation.
 */

export async function getOnboardingPage(req: Request, res: Response) {
  // État réel du compte lu en base (et non dans le jeton de session).
  const destination = await getOnboardingRedirect();
  if (destination) throw new PageRedirect(destination);
  const session = await getSession();
  if (!session?.user) throw new PageRedirect("/login");

  return jsonData(res, { name: session.user.name ?? "" });
}

export async function getSuspendedPage(req: Request, res: Response) {
  // État réel du compte lu en base : dès la réactivation, on repart vers l'application.
  const destination = await getSuspendedRedirect();
  if (destination) throw new PageRedirect(destination);

  return jsonData(res, {});
}

/** Cadre de l'application : compte, organisation, boutiques et boutique active. */
export async function getShellPage(req: Request, res: Response) {
  const context = req.user;

  const [organization, stores, user] = await Promise.all([
    prisma.organisation.findUniqueOrThrow({
      where: { id: context.organizationId },
      select: { nom: true, devise: true },
    }),
    prisma.boutique.findMany({
      where: { organisationId: context.organizationId },
      select: { id: true, nom: true },
      orderBy: [{ parDefaut: "desc" }, { nom: "asc" }],
    }),
    prisma.utilisateur.findUniqueOrThrow({
      where: { id: context.userId },
      select: { prenom: true, nom: true, email: true, telephone: true },
    }),
  ]);

  const activeStoreId = await getActiveStoreId(context);

  return jsonData(res, {
    user,
    organization,
    role: context.role,
    stores,
    // Null quand le membre est limité à une seule boutique (pas de sélecteur).
    activeStoreId: context.membershipStoreId ? null : activeStoreId,
  });
}

export async function getDashboardPage(req: Request, res: Response) {
  const context = req.user;
  const storeId = await getActiveStoreId(context);

  const [organization, store, stats, totalProducts, totalSales] = await Promise.all([
    prisma.organisation.findUniqueOrThrow({ where: { id: context.organizationId }, select: { devise: true } }),
    prisma.boutique.findUniqueOrThrow({ where: { id: storeId }, select: { nom: true } }),
    dashboardService.getDashboardStats(context, storeId, can(context.role, "report:view")),
    prisma.produit.count({ where: { organisationId: context.organizationId } }),
    prisma.vente.count({ where: { organisationId: context.organizationId } }),
  ]);

  return jsonData(res, { currency: organization.devise, storeName: store.nom, stats, totalProducts, totalSales });
}

export async function getProductsPage(req: Request, res: Response) {
  const params = searchParams(req);
  const context = req.user;
  const storeId = await getActiveStoreId(context);
  const canManage = can(context.role, "product:manage");

  const search = params.get("search")?.trim() ?? "";
  const categoryId = Number(params.get("categoryId")) || undefined;
  const status = params.get("status") ?? undefined;
  const pagination = getPagination(params);

  const where = {
    organisationId: context.organizationId,
    ...(categoryId ? { categorieId: categoryId } : {}),
    ...(status === "active" ? { actif: true } : status === "archived" ? { actif: false } : {}),
    ...(search
      ? { OR: [{ nom: containsText(search) }, { reference: containsText(search) }, { codeBarres: containsText(search) }] }
      : {}),
  };

  const [products, total, categories, organization] = await Promise.all([
    prisma.produit.findMany({
      where,
      orderBy: { creeLe: "desc" },
      skip: (pagination.page - 1) * pagination.limit,
      take: pagination.limit,
      include: { categorie: { select: { id: true, nom: true } }, stocks: { where: { boutiqueId: storeId }, select: { quantite: true } } },
    }),
    prisma.produit.count({ where }),
    prisma.categorie.findMany({ where: { organisationId: context.organizationId }, orderBy: { nom: "asc" } }),
    prisma.organisation.findUniqueOrThrow({ where: { id: context.organizationId }, select: { devise: true } }),
  ]);

  // Les montants sont envoyés en nombres, comme les recevaient les composants.
  const data = products.map(({ stocks, prixAchat, prixVente, ...product }) => ({
    ...product,
    prixAchat: can(context.role, "report:view") ? Number(prixAchat) : null,
    prixVente: Number(prixVente),
    quantiteStock: stocks[0]?.quantite ?? 0,
  }));

  return jsonData(res, {
    products: data,
    categories,
    canManage,
    currency: organization.devise,
    page: pagination.page,
    totalPages: paginationMeta(pagination, total).totalPages,
    total,
  });
}

export async function getStockPage(req: Request, res: Response) {
  const params = searchParams(req);
  const context = req.user;
  const storeId = await getActiveStoreId(context);
  const canAdjust = can(context.role, "stock:adjust");

  const search = params.get("search")?.trim() ?? "";
  const lowStockOnly = params.get("lowStock") === "true";
  const pagination = getPagination(params, 20);

  const [{ rows, total: effectiveTotal }, organization] = await Promise.all([
    listStoreStock({ organisationId: context.organizationId, storeId, search, lowStockOnly, page: pagination.page, limit: pagination.limit }),
    prisma.organisation.findUniqueOrThrow({ where: { id: context.organizationId }, select: { devise: true } }),
  ]);

  return jsonData(res, {
    stocks: rows,
    canAdjust,
    canViewMovements: can(context.role, "stock-movement:read"),
    currency: organization.devise,
    page: pagination.page,
    totalPages: paginationMeta(pagination, effectiveTotal).totalPages,
    total: effectiveTotal,
  });
}

export async function getStockMovementsPage(req: Request, res: Response) {
  const context = req.user;
  const params = searchParams(req);
  const storeId = await getActiveStoreId(context);
  const pagination = getPagination(params, 30);
  const search = params.get("search")?.trim() ?? "";
  const typeValue = params.get("type");
  const type = typeValue ? z.enum(StockMovementType).parse(typeValue) : undefined;
  const from = params.get("from") ? new Date(params.get("from")!) : undefined;
  const to = params.get("to") ? new Date(params.get("to")!) : undefined;
  const userId = Number(params.get("userId")) || undefined;
  const sourceReference = params.get("source")?.trim() ?? "";
  const where = { boutiqueId: storeId, produit: { organisationId: context.organizationId, ...(search ? { nom: containsText(search) } : {}) }, ...(userId ? { utilisateurId: userId } : {}), ...(sourceReference ? { sourceReference: { contains: sourceReference, mode: "insensitive" as const } } : {}), ...(type ? { type } : {}), ...(from || to ? { creeLe: { ...(from && !Number.isNaN(from.getTime()) ? { gte: from } : {}), ...(to && !Number.isNaN(to.getTime()) ? { lte: to } : {}) } } : {}) };
  const [movements, total] = await Promise.all([
    prisma.mouvementStock.findMany({
      where,
      include: {
        produit: { select: { id: true, nom: true, unite: true } },
        utilisateur: { select: { prenom: true, nom: true } },
        vente: { select: { id: true } },
        achat: { select: { id: true } },
      },
      orderBy: { creeLe: "desc" },
      skip: (pagination.page - 1) * pagination.limit,
      take: pagination.limit,
    }),
    prisma.mouvementStock.count({ where }),
  ]);

  return jsonData(res, {
    movements,
    page: pagination.page,
    totalPages: paginationMeta(pagination, total).totalPages,
    total,
  });
}

export async function getSalesPage(req: Request, res: Response) {
  const params = searchParams(req);
  const context = req.user;
  const storeId = await getActiveStoreId(context);
  const canCancel = can(context.role, "sale:cancel");
  const canViewFinance = can(context.role, "report:view");

  const search = params.get("search")?.trim() ?? "";
  const pagination = getPagination(params, 10);
  // La liste et les statistiques portent sur la même période (aujourd'hui par défaut).
  const organizationTz = await prisma.organisation.findUniqueOrThrow({ where: { id: context.organizationId }, select: { fuseauHoraire: true } });
  const period = parsePeriod(params, new Date(), organizationTz.fuseauHoraire);

  const where = {
    organisationId: context.organizationId,
    boutiqueId: storeId,
    creeLe: { gte: period.start, lt: period.end },
    ...(search
      ? {
          OR: [
            { lignes: { some: { produit: { nom: containsText(search) } } } },
            { client: { nom: containsText(search) } },
          ],
        }
      : {}),
  };

  const [sales, total, organization, stats] = await Promise.all([
    prisma.vente.findMany({
      where,
      orderBy: { creeLe: "desc" },
      skip: (pagination.page - 1) * pagination.limit,
      take: pagination.limit,
      select: saleSummarySelect,
    }),
    prisma.vente.count({ where }),
    prisma.organisation.findUniqueOrThrow({ where: { id: context.organizationId }, select: { devise: true } }),
    getSalesStats(context, storeId, period),
  ]);

  // On ne garde que les champs utilisés par le tableau des ventes.
  const salesForClient = sales.map((sale) => {
    const summary = serializeSaleSummary(sale);
    return { ...summary, total: Number(sale.total), resteAPayer: Number(sale.resteAPayer), remboursementEnAttente: Number(summary.remboursementEnAttente) };
  });

  return jsonData(res, {
    sales: salesForClient,
    period,
    stats: visibleSalesStats(stats, canViewFinance),
    canCancel,
    canCollect: can(context.role, "sale:create"),
    canReturn: can(context.role, "return:manage"),
    canRefund: can(context.role, "refund:manage"),
    currency: organization.devise,
    page: pagination.page,
    totalPages: paginationMeta(pagination, total).totalPages,
    total,
  });
}

/**
 * Nouvelle vente (et nouveau devis). Avec `?devis=ID`, le devis à transformer
 * est joint : le panier est prérempli avec ses lignes, ses prix et sa remise.
 */
export async function getNewSalePage(req: Request, res: Response) {
  const context = req.user;
  const storeId = await getActiveStoreId(context);
  const quoteId = Number(searchParams(req).get("devis")) || null;

  const [products, customers, organization, quote, pricing] = await Promise.all([
    prisma.produit.findMany({
      where: { organisationId: context.organizationId, actif: true },
      select: {
        id: true,
        nom: true,
        unite: true,
        prixVente: true,
        stocks: { where: { boutiqueId: storeId }, select: { quantite: true } },
      },
      orderBy: { nom: "asc" },
    }),
    prisma.client.findMany({
      where: { organisationId: context.organizationId, archive: false },
      select: { id: true, nom: true },
      orderBy: { nom: "asc" },
    }),
    prisma.organisation.findUniqueOrThrow({ where: { id: context.organizationId }, select: { devise: true } }),
    quoteId
      ? prisma.devis.findFirst({
          where: { id: quoteId, organisationId: context.organizationId, boutiqueId: storeId },
          select: {
            id: true,
            clientId: true,
            remise: true,
            venteId: true,
            lignes: { select: { produitId: true, designation: true, quantite: true, prixUnitaire: true }, orderBy: { id: "asc" } },
          },
        })
      : null,
    pricingLimitsFor(context),
  ]);

  const catalog = products.map(({ stocks, ...product }) => ({
    ...product,
    prixVente: Number(product.prixVente),
    quantiteStock: stocks[0]?.quantite ?? 0,
  }));

  return jsonData(res, {
    products: catalog,
    customers,
    currency: organization.devise,
    /** Plafond de remise du rôle (null : sans limite) et droit de vendre sous le coût. */
    pricing,
    quote: quote && {
      ...quote,
      remise: Number(quote.remise),
      lignes: quote.lignes.map((line) => ({ ...line, prixUnitaire: Number(line.prixUnitaire) })),
    },
  });
}

/**
 * Créances de la boutique : ventes à crédit (et toute vente non soldée),
 * filtrées par statut — `en_cours` (défaut), `reglee` ou `toutes` — et par
 * nom de client. Les ventes annulées n'en font jamais partie.
 */
export async function getCreditsPage(req: Request, res: Response) {
  const params = searchParams(req);
  const context = req.user;
  const storeId = await getActiveStoreId(context);

  const search = params.get("search")?.trim() ?? "";
  const status = params.get("statut") ?? "en_cours";
  const pagination = getPagination(params, 10);
  const unpaid = { resteAPayer: { gt: 0 } };

  const credits = {
    organisationId: context.organizationId,
    boutiqueId: storeId,
    statut: SaleStatus.COMPLETED,
    OR: [{ modePaiement: PaymentMethod.CREDIT }, unpaid],
  };
  const where = {
    ...credits,
    AND: [
      status === "reglee" ? { resteAPayer: 0 } : status === "toutes" ? {} : unpaid,
      search ? { client: { nom: containsText(search) } } : {},
    ],
  };

  const [sales, total, outstanding, organization] = await Promise.all([
    prisma.vente.findMany({
      where,
      orderBy: { creeLe: "desc" },
      skip: (pagination.page - 1) * pagination.limit,
      take: pagination.limit,
      select: {
        id: true,
        total: true,
        montantPaye: true,
        montantRetourne: true,
        resteAPayer: true,
        creeLe: true,
        client: { select: { id: true, nom: true, telephone: true } },
        paiements: { orderBy: { date: "desc" }, take: 1, select: { date: true } },
      },
    }),
    prisma.vente.count({ where }),
    prisma.vente.aggregate({ where: { ...credits, ...unpaid }, _sum: { resteAPayer: true }, _count: true }),
    prisma.organisation.findUniqueOrThrow({ where: { id: context.organizationId }, select: { devise: true } }),
  ]);

  return jsonData(res, {
    credits: sales.map(({ paiements, ...sale }) => ({
      ...sale,
      total: Number(sale.total),
      montantPaye: Number(sale.montantPaye),
      montantRetourne: Number(sale.montantRetourne),
      resteAPayer: Number(sale.resteAPayer),
      dernierPaiement: paiements[0]?.date ?? null,
    })),
    summary: {
      outstanding: Number(outstanding._sum.resteAPayer ?? 0),
      count: outstanding._count,
    },
    canCollect: can(context.role, "sale:create"),
    canReturn: can(context.role, "return:manage"),
    canRefund: can(context.role, "refund:manage"),
    canViewFinance: can(context.role, "report:view"),
    currency: organization.devise,
    page: pagination.page,
    totalPages: paginationMeta(pagination, total).totalPages,
    total,
  });
}

export async function getQuotesPage(req: Request, res: Response) {
  const params = searchParams(req);
  const context = req.user;
  const storeId = await getActiveStoreId(context);

  const search = params.get("search")?.trim() ?? "";
  const pagination = getPagination(params, 10);

  const where = {
    organisationId: context.organizationId,
    boutiqueId: storeId,
    ...(search ? { OR: [{ client: { nom: containsText(search) } }, { nomClient: containsText(search) }] } : {}),
  };

  const [quotes, total, organization] = await Promise.all([
    prisma.devis.findMany({
      where,
      orderBy: { creeLe: "desc" },
      skip: (pagination.page - 1) * pagination.limit,
      take: pagination.limit,
      select: {
        id: true,
        total: true,
        nomClient: true,
        valableJusquAu: true,
        venteId: true,
        creeLe: true,
        client: { select: { id: true, nom: true } },
        creePar: { select: { prenom: true, nom: true } },
        _count: { select: { lignes: true } },
      },
    }),
    prisma.devis.count({ where }),
    prisma.organisation.findUniqueOrThrow({ where: { id: context.organizationId }, select: { devise: true } }),
  ]);

  return jsonData(res, {
    quotes: quotes.map((quote) => ({ ...quote, total: Number(quote.total) })),
    canCreate: can(context.role, "sale:create"),
    canDelete: can(context.role, "sale:cancel"),
    currency: organization.devise,
    page: pagination.page,
    totalPages: paginationMeta(pagination, total).totalPages,
    total,
  });
}

export async function getPurchasesPage(req: Request, res: Response) {
  const context = req.user;
  const storeId = await getActiveStoreId(context);
  const pagination = getPagination(searchParams(req), 10);

  const where = { organisationId: context.organizationId, boutiqueId: storeId };

  const [purchases, total, organization, products, suppliers] = await Promise.all([
    prisma.achat.findMany({
      where,
      orderBy: { creeLe: "desc" },
      skip: (pagination.page - 1) * pagination.limit,
      take: pagination.limit,
      include: {
        lignes: { select: { id: true, quantite: true, produit: { select: { id: true, nom: true } } } },
        fournisseur: { select: { id: true, nom: true } },
      },
    }),
    prisma.achat.count({ where }),
    prisma.organisation.findUniqueOrThrow({ where: { id: context.organizationId }, select: { devise: true } }),
    prisma.produit.findMany({
      where: { organisationId: context.organizationId, actif: true },
      select: { id: true, nom: true, unite: true, prixAchat: true },
      orderBy: { nom: "asc" },
    }),
    prisma.fournisseur.findMany({
      where: { organisationId: context.organizationId, archive: false },
      select: { id: true, nom: true },
      orderBy: { nom: "asc" },
    }),
  ]);

  return jsonData(res, {
    purchases: purchases.map(({ cleIdempotence: _key, empreinteIdempotence: _print, cleAnnulation: _cancel, ...purchase }) => ({
      ...purchase,
      total: Number(purchase.total),
      montantPaye: Number(purchase.montantPaye),
      resteAPayer: Number(purchase.resteAPayer),
    })),
    canCancel: can(context.role, "purchase:cancel"),
    products: products.map((p) => ({ ...p, prixAchat: Number(p.prixAchat) })),
    suppliers,
    currency: organization.devise,
    page: pagination.page,
    totalPages: paginationMeta(pagination, total).totalPages,
    total,
  });
}

export async function getCustomersPage(req: Request, res: Response) {
  const params = searchParams(req);
  const context = req.user;
  const canManage = can(context.role, "customer:manage");

  const search = params.get("search")?.trim() ?? "";
  const pagination = getPagination(params);

  const where = {
    organisationId: context.organizationId,
    ...archiveFilter(params),
    ...(search ? { OR: [{ nom: containsText(search) }, { telephone: containsText(search) }] } : {}),
  };

  const [customers, total] = await Promise.all([
    prisma.client.findMany({
      where,
      orderBy: { nom: "asc" },
      skip: (pagination.page - 1) * pagination.limit,
      take: pagination.limit,
      include: { _count: { select: { ventes: true } } },
    }),
    prisma.client.count({ where }),
  ]);

  return jsonData(res, {
    customers,
    canManage,
    canDelete: can(context.role, "customer:delete"),
    showArchived: params.get("archives") === "true",
    page: pagination.page,
    totalPages: paginationMeta(pagination, total).totalPages,
    total,
  });
}

export async function getSuppliersPage(req: Request, res: Response) {
  const params = searchParams(req);
  const context = req.user;

  const search = params.get("search")?.trim() ?? "";
  const pagination = getPagination(params);

  const where = {
    organisationId: context.organizationId,
    ...archiveFilter(params),
    ...(search ? { OR: [{ nom: containsText(search) }, { telephone: containsText(search) }] } : {}),
  };

  const [suppliers, total] = await Promise.all([
    prisma.fournisseur.findMany({
      where,
      orderBy: { nom: "asc" },
      skip: (pagination.page - 1) * pagination.limit,
      take: pagination.limit,
      include: { _count: { select: { achats: true } } },
    }),
    prisma.fournisseur.count({ where }),
  ]);

  return jsonData(res, {
    suppliers,
    canDelete: can(context.role, "supplier:delete"),
    showArchived: params.get("archives") === "true",
    page: pagination.page,
    totalPages: paginationMeta(pagination, total).totalPages,
    total,
  });
}

export async function getExpensesPage(req: Request, res: Response) {
  const context = req.user;
  const pagination = getPagination(searchParams(req), 20);
  const storeId = await getActiveStoreId(context);

  const where = { organisationId: context.organizationId, statut: "ACTIVE" as const,
    ...(context.membershipStoreId ? { boutiqueId: storeId } : {}) };

  const [expenses, total, organization] = await Promise.all([
    prisma.depense.findMany({
      where,
      orderBy: { date: "desc" },
      skip: (pagination.page - 1) * pagination.limit,
      take: pagination.limit,
    }),
    prisma.depense.count({ where }),
    prisma.organisation.findUniqueOrThrow({ where: { id: context.organizationId }, select: { devise: true } }),
  ]);

  return jsonData(res, {
    expenses: expenses.map((expense) => ({ ...expense, montant: Number(expense.montant) })),
    currency: organization.devise,
    page: pagination.page,
    totalPages: paginationMeta(pagination, total).totalPages,
    total,
  });
}

export async function getSettingsPage(req: Request, res: Response) {
  const context = req.user;

  const [organization, stores, members] = await Promise.all([
    prisma.organisation.findUniqueOrThrow({ where: { id: context.organizationId } }),
    prisma.boutique.findMany({ where: { organisationId: context.organizationId }, orderBy: { nom: "asc" } }),
    prisma.membre.findMany({
      where: { organisationId: context.organizationId },
      include: {
        utilisateur: { select: { id: true, prenom: true, nom: true, email: true, telephone: true } },
        boutique: { select: { id: true, nom: true } },
      },
      orderBy: { creeLe: "asc" },
    }),
  ]);

  return jsonData(res, {
    organization,
    stores,
    members,
    currentUserId: context.userId,
    canEditOrganization: can(context.role, "org:manage"),
    canManageStores: can(context.role, "store:manage"),
  });
}
