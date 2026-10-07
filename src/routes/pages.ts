import { Router } from "express";
import { prisma } from "@/lib/prisma";
import { containsText } from "@/lib/search";
import {
  getOnboardingRedirect,
  getSession,
  getSuspendedRedirect,
  requirePageAuthContext,
  requirePageSuperAdmin,
  requirePermission,
} from "@/lib/auth/session";
import { getActiveStoreId } from "@/lib/auth/store";
import { can } from "@/lib/auth/permissions";
import { SESSION_RENEW_AFTER_MS, renewSessionCookie } from "@/lib/auth/web-session";
import { getDashboardStats } from "@/lib/services/dashboard";
import {
  getPlatformActivity,
  getPlatformAlerts,
  getPlatformAnalytics,
  getPlatformOverview,
  parseActivityQuery,
  parseRange,
} from "@/lib/services/platform";
import {
  getOrganizationDetails,
  listOrganizations,
  listUsers,
  parseOrganizationQuery,
  parseUserQuery,
} from "@/lib/services/platform-admin";
import { getPagination, paginationMeta, parseIntId } from "@/lib/api/pagination";
import { apiRoute, jsonData, searchParams } from "@/lib/api/response";
import { Errors, PageRedirect } from "@/lib/api/errors";

/**
 * Lectures de page du site web (`/api/pages/**`).
 *
 * Chaque route renvoie, en une requête, tout ce qu'une page affiche : c'est
 * l'équivalent des lectures que les pages faisaient directement en base quand
 * elles étaient rendues côté serveur. Les règles sont les mêmes : le compte
 * est revérifié en base, les données sont filtrées par organisation, et un
 * compte qui n'a pas sa place sur la page reçoit une redirection
 * (`{ redirect }`) plutôt que des données.
 *
 * Les routes `/api/**` historiques restent la référence pour l'application
 * mobile ; celles-ci sont propres au site.
 */
export const pagesRouter = Router();

// Session glissante : le cookie d'un compte qui utilise le site est renouvelé
// au plus une fois par jour.
pagesRouter.use((_req, res, next) => {
  renewSessionCookie(res, { olderThanMs: SESSION_RENEW_AFTER_MS }).then(() => next(), next);
});

/** Page inconnue (identifiant invalide ou ressource absente) : le site affiche sa page 404. */
function pageNotFound(message: string) {
  return Errors.notFound(message);
}

// ---------------------------------------------------------------------------
// Hors application : onboarding, organisation suspendue
// ---------------------------------------------------------------------------

pagesRouter.get(
  "/onboarding",
  apiRoute(async (_req, res) => {
    // État réel du compte lu en base (et non dans le jeton de session).
    const destination = await getOnboardingRedirect();
    if (destination) throw new PageRedirect(destination);
    const session = await getSession();
    if (!session?.user) throw new PageRedirect("/login");

    return jsonData(res, { name: session.user.name ?? "" });
  }),
);

pagesRouter.get(
  "/suspendu",
  apiRoute(async (_req, res) => {
    // État réel du compte lu en base : dès la réactivation, on repart vers l'application.
    const destination = await getSuspendedRedirect();
    if (destination) throw new PageRedirect(destination);

    return jsonData(res, {});
  }),
);

// ---------------------------------------------------------------------------
// Espace boutique
// ---------------------------------------------------------------------------

/** Cadre de l'application : compte, organisation, boutiques et boutique active. */
pagesRouter.get(
  "/shell",
  apiRoute(async (_req, res) => {
    const context = await requirePageAuthContext();

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
  }),
);

pagesRouter.get(
  "/dashboard",
  apiRoute(async (_req, res) => {
    const context = await requirePageAuthContext();
    const storeId = await getActiveStoreId(context);

    const [organization, store, stats, totalProducts, totalSales] = await Promise.all([
      prisma.organisation.findUniqueOrThrow({ where: { id: context.organizationId }, select: { devise: true } }),
      prisma.boutique.findUniqueOrThrow({ where: { id: storeId }, select: { nom: true } }),
      getDashboardStats(context, storeId),
      prisma.produit.count({ where: { organisationId: context.organizationId } }),
      prisma.vente.count({ where: { organisationId: context.organizationId } }),
    ]);

    return jsonData(res, { currency: organization.devise, storeName: store.nom, stats, totalProducts, totalSales });
  }),
);

pagesRouter.get(
  "/produits",
  apiRoute(async (req, res) => {
    const params = searchParams(req);
    const context = await requirePageAuthContext();
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
      prixAchat: Number(prixAchat),
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
  }),
);

pagesRouter.get(
  "/stock",
  apiRoute(async (req, res) => {
    const params = searchParams(req);
    const context = await requirePageAuthContext();
    const storeId = await getActiveStoreId(context);
    const canAdjust = can(context.role, "stock:adjust");

    const search = params.get("search")?.trim() ?? "";
    const lowStockOnly = params.get("lowStock") === "true";
    const pagination = getPagination(params, 20);

    const where = {
      boutiqueId: storeId,
      produit: {
        organisationId: context.organizationId,
        actif: true,
        ...(search ? { nom: containsText(search) } : {}),
      },
    };

    const [stocksRaw, total, organization] = await Promise.all([
      prisma.stock.findMany({
        where,
        include: { produit: { select: { id: true, nom: true, unite: true, seuilAlerte: true, prixVente: true } } },
        orderBy: { quantite: "asc" },
      }),
      prisma.stock.count({ where }),
      prisma.organisation.findUniqueOrThrow({ where: { id: context.organizationId }, select: { devise: true } }),
    ]);

    const filtered = lowStockOnly ? stocksRaw.filter((s) => s.quantite <= s.produit.seuilAlerte) : stocksRaw;
    const pageItems = filtered
      .slice((pagination.page - 1) * pagination.limit, pagination.page * pagination.limit)
      .map((stock) => ({ ...stock, produit: { ...stock.produit, prixVente: Number(stock.produit.prixVente) } }));
    const effectiveTotal = lowStockOnly ? filtered.length : total;

    return jsonData(res, {
      stocks: pageItems,
      canAdjust,
      currency: organization.devise,
      page: pagination.page,
      totalPages: paginationMeta(pagination, effectiveTotal).totalPages,
      total: effectiveTotal,
    });
  }),
);

pagesRouter.get(
  "/stock/mouvements",
  apiRoute(async (req, res) => {
    const context = await requirePageAuthContext();
    const storeId = await getActiveStoreId(context);
    const pagination = getPagination(searchParams(req), 30);

    const where = { boutiqueId: storeId };
    const [movements, total] = await Promise.all([
      prisma.mouvementStock.findMany({
        where,
        include: {
          produit: { select: { id: true, nom: true, unite: true } },
          utilisateur: { select: { prenom: true, nom: true } },
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
  }),
);

pagesRouter.get(
  "/ventes",
  apiRoute(async (req, res) => {
    const params = searchParams(req);
    const context = await requirePageAuthContext();
    const storeId = await getActiveStoreId(context);
    const canCancel = can(context.role, "sale:cancel");

    const search = params.get("search")?.trim() ?? "";
    const pagination = getPagination(params, 10);

    const where = {
      organisationId: context.organizationId,
      boutiqueId: storeId,
      ...(search
        ? {
            OR: [
              { lignes: { some: { produit: { nom: containsText(search) } } } },
              { client: { nom: containsText(search) } },
            ],
          }
        : {}),
    };

    const [sales, total, organization] = await Promise.all([
      prisma.vente.findMany({
        where,
        orderBy: { creeLe: "desc" },
        skip: (pagination.page - 1) * pagination.limit,
        take: pagination.limit,
        include: {
          lignes: { select: { id: true, quantite: true, produit: { select: { id: true, nom: true } } } },
          client: { select: { id: true, nom: true } },
          vendeur: { select: { id: true, prenom: true, nom: true } },
        },
      }),
      prisma.vente.count({ where }),
      prisma.organisation.findUniqueOrThrow({ where: { id: context.organizationId }, select: { devise: true } }),
    ]);

    // On ne garde que les champs utilisés par le tableau des ventes.
    const salesForClient = sales.map((sale) => ({
      id: sale.id,
      statut: sale.statut,
      total: Number(sale.total),
      creeLe: sale.creeLe,
      lignes: sale.lignes,
      client: sale.client,
      vendeur: sale.vendeur,
    }));

    return jsonData(res, {
      sales: salesForClient,
      canCancel,
      currency: organization.devise,
      page: pagination.page,
      totalPages: paginationMeta(pagination, total).totalPages,
      total,
    });
  }),
);

pagesRouter.get(
  "/ventes/nouvelle",
  apiRoute(async (_req, res) => {
    const context = await requirePageAuthContext();
    const storeId = await getActiveStoreId(context);

    const [products, customers, organization] = await Promise.all([
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
        where: { organisationId: context.organizationId },
        select: { id: true, nom: true },
        orderBy: { nom: "asc" },
      }),
      prisma.organisation.findUniqueOrThrow({ where: { id: context.organizationId }, select: { devise: true } }),
    ]);

    const catalog = products.map(({ stocks, ...product }) => ({
      ...product,
      prixVente: Number(product.prixVente),
      quantiteStock: stocks[0]?.quantite ?? 0,
    }));

    return jsonData(res, { products: catalog, customers, currency: organization.devise });
  }),
);

pagesRouter.get(
  "/achats",
  apiRoute(async (req, res) => {
    const context = await requirePageAuthContext();
    requirePermission(context, "purchase:manage");
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
        where: { organisationId: context.organizationId },
        select: { id: true, nom: true },
        orderBy: { nom: "asc" },
      }),
    ]);

    return jsonData(res, {
      purchases: purchases.map((purchase) => ({ ...purchase, total: Number(purchase.total) })),
      products: products.map((p) => ({ ...p, prixAchat: Number(p.prixAchat) })),
      suppliers,
      currency: organization.devise,
      page: pagination.page,
      totalPages: paginationMeta(pagination, total).totalPages,
      total,
    });
  }),
);

pagesRouter.get(
  "/clients",
  apiRoute(async (req, res) => {
    const params = searchParams(req);
    const context = await requirePageAuthContext();
    const canManage = can(context.role, "customer:manage");

    const search = params.get("search")?.trim() ?? "";
    const pagination = getPagination(params);

    const where = {
      organisationId: context.organizationId,
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
      page: pagination.page,
      totalPages: paginationMeta(pagination, total).totalPages,
      total,
    });
  }),
);

pagesRouter.get(
  "/fournisseurs",
  apiRoute(async (req, res) => {
    const params = searchParams(req);
    const context = await requirePageAuthContext();
    requirePermission(context, "supplier:manage");

    const search = params.get("search")?.trim() ?? "";
    const pagination = getPagination(params);

    const where = {
      organisationId: context.organizationId,
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
      page: pagination.page,
      totalPages: paginationMeta(pagination, total).totalPages,
      total,
    });
  }),
);

pagesRouter.get(
  "/depenses",
  apiRoute(async (req, res) => {
    const context = await requirePageAuthContext();
    requirePermission(context, "expense:manage");
    const pagination = getPagination(searchParams(req), 20);

    const where = { organisationId: context.organizationId };

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
  }),
);

pagesRouter.get(
  "/parametres",
  apiRoute(async (_req, res) => {
    const context = await requirePageAuthContext();
    requirePermission(context, "members:manage");

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
  }),
);

// ---------------------------------------------------------------------------
// Espace super administrateur
// ---------------------------------------------------------------------------

/** Cadre de l'administration : compte connecté et points à surveiller (cloche). */
pagesRouter.get(
  "/admin/shell",
  apiRoute(async (_req, res) => {
    // Statut relu en base à chaque requête : tout autre compte est redirigé.
    const admin = await requirePageSuperAdmin();

    const [user, alerts] = await Promise.all([
      prisma.utilisateur.findUniqueOrThrow({
        where: { id: admin.userId },
        select: { prenom: true, nom: true, email: true, telephone: true },
      }),
      getPlatformAlerts(),
    ]);

    return jsonData(res, { user, alerts });
  }),
);

pagesRouter.get(
  "/admin",
  apiRoute(async (req, res) => {
    const admin = await requirePageSuperAdmin();
    const params = searchParams(req);
    const range = parseRange(params.get("range"));

    const [user, overview, alerts, activity] = await Promise.all([
      prisma.utilisateur.findUniqueOrThrow({ where: { id: admin.userId }, select: { prenom: true } }),
      getPlatformOverview({ range, currency: params.get("currency") ?? undefined }),
      getPlatformAlerts(),
      getPlatformActivity({ limit: 8 }),
    ]);

    return jsonData(res, { user, range, overview, alerts, activity });
  }),
);

pagesRouter.get(
  "/admin/boutiques",
  apiRoute(async (req, res) => {
    await requirePageSuperAdmin();
    const query = parseOrganizationQuery(searchParams(req));

    const { items, total } = await listOrganizations(query);

    return jsonData(res, {
      items,
      total,
      filtered: Boolean(query.search || query.status),
      page: query.pagination.page,
      totalPages: paginationMeta(query.pagination, total).totalPages,
    });
  }),
);

pagesRouter.get(
  "/admin/boutiques/:id",
  apiRoute(async (req, res) => {
    await requirePageSuperAdmin();
    const organizationId = parseIntId(String(req.params.id));
    if (!organizationId) throw pageNotFound("Boutique introuvable");

    const organization = await getOrganizationDetails(organizationId);
    if (!organization) throw pageNotFound("Boutique introuvable");

    return jsonData(res, organization);
  }),
);

pagesRouter.get(
  "/admin/utilisateurs",
  apiRoute(async (req, res) => {
    await requirePageSuperAdmin();
    const query = parseUserQuery(searchParams(req));

    const { items, total } = await listUsers(query);

    return jsonData(res, {
      items,
      total,
      filtered: Boolean(query.search || query.role || query.status),
      page: query.pagination.page,
      totalPages: paginationMeta(query.pagination, total).totalPages,
    });
  }),
);

pagesRouter.get(
  "/admin/statistiques",
  apiRoute(async (req, res) => {
    await requirePageSuperAdmin();
    const params = searchParams(req);
    const range = parseRange(params.get("range"));

    const analytics = await getPlatformAnalytics({ range, currency: params.get("currency") ?? undefined });

    return jsonData(res, { range, analytics });
  }),
);

const ACTIVITY_PAGE_SIZE = 25;

pagesRouter.get(
  "/admin/activite",
  apiRoute(async (req, res) => {
    await requirePageSuperAdmin();
    const query = parseActivityQuery(searchParams(req));

    const [activity, organization] = await Promise.all([
      getPlatformActivity({ ...query, limit: ACTIVITY_PAGE_SIZE }),
      query.organizationId
        ? prisma.organisation.findUnique({ where: { id: query.organizationId }, select: { id: true, nom: true } })
        : null,
    ]);

    return jsonData(res, {
      activity,
      organization,
      kind: query.kind ?? null,
      organizationId: query.organizationId ?? null,
      before: query.before ?? null,
    });
  }),
);

pagesRouter.get(
  "/admin/profil",
  apiRoute(async (_req, res) => {
    const admin = await requirePageSuperAdmin();

    const [user, superAdmins] = await Promise.all([
      prisma.utilisateur.findUniqueOrThrow({
        where: { id: admin.userId },
        select: { prenom: true, nom: true, email: true, telephone: true, creeLe: true },
      }),
      prisma.utilisateur.findMany({
        where: { superAdmin: true },
        orderBy: { creeLe: "asc" },
        select: { id: true, prenom: true, nom: true, email: true, telephone: true, actif: true },
      }),
    ]);

    return jsonData(res, { user, superAdmins, currentUserId: admin.userId });
  }),
);
