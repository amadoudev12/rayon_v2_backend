import { Router } from "express";
import { prisma } from "@/lib/prisma";
import { containsText } from "@/lib/search";
import { requireAuthContext, requirePermission, resolveActiveStoreId } from "@/lib/auth/session";
import { saleSchema } from "@/lib/validations/sale";
import { purchaseSchema } from "@/lib/validations/purchase";
import { customerSchema } from "@/lib/validations/customer";
import { supplierSchema } from "@/lib/validations/supplier";
import { expenseSchema } from "@/lib/validations/expense";
import { cancelSale, createSale } from "@/lib/services/sale";
import { createPurchase } from "@/lib/services/purchase";
import { getDashboardStats } from "@/lib/services/dashboard";
import { recordAuditLog } from "@/lib/api/audit";
import { apiRoute, jsonData, jsonMessage, jsonPage, routeId, searchParams } from "@/lib/api/response";
import { getPagination, paginationMeta } from "@/lib/api/pagination";
import { Errors } from "@/lib/api/errors";

export const commerceRouter = Router();

// ---------------------------------------------------------------------------
// Tableau de bord
// ---------------------------------------------------------------------------

commerceRouter.get(
  "/dashboard",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    const requestedStoreId = Number(searchParams(req).get("storeId")) || undefined;

    // A restricted member is always forced onto their own store. An
    // unrestricted member may target one store (validated against their own
    // organization); with none requested, stats aggregate every store.
    const storeId = context.membershipStoreId
      ? context.membershipStoreId
      : requestedStoreId
        ? await resolveActiveStoreId(context, requestedStoreId)
        : null;

    const stats = await getDashboardStats(context, storeId);
    return jsonData(res, stats);
  }),
);

// ---------------------------------------------------------------------------
// Ventes
// ---------------------------------------------------------------------------

commerceRouter.get(
  "/sales",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    const params = searchParams(req);

    const storeId = await resolveActiveStoreId(context, Number(params.get("storeId")) || undefined);
    const search = params.get("search")?.trim() ?? "";
    const date = params.get("date") ?? "";
    const pagination = getPagination(params, 10);
    const selectedDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00`) : null;
    if (date && !selectedDate) throw Errors.conflict("Date de recherche invalide");

    const nextDay = selectedDate ? new Date(selectedDate) : null;
    nextDay?.setDate(nextDay.getDate() + 1);

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
      ...(selectedDate && nextDay ? { creeLe: { gte: selectedDate, lt: nextDay } } : {}),
    };

    const [sales, total] = await Promise.all([
      prisma.vente.findMany({
        where,
        orderBy: { creeLe: "desc" },
        skip: (pagination.page - 1) * pagination.limit,
        take: pagination.limit,
        include: {
          lignes: { include: { produit: { select: { id: true, nom: true } } } },
          client: { select: { id: true, nom: true } },
          vendeur: { select: { id: true, prenom: true, nom: true } },
        },
      }),
      prisma.vente.count({ where }),
    ]);

    return jsonPage(res, sales, paginationMeta(pagination, total));
  }),
);

commerceRouter.post(
  "/sales",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    requirePermission(context, "sale:create");

    const parsed = saleSchema.parse(req.body);
    const storeId = await resolveActiveStoreId(context, parsed.boutiqueId);

    const sale = await createSale(context, storeId, parsed);
    return jsonData(res, sale, { status: 201 });
  }),
);

commerceRouter.get(
  "/sales/:id",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    const saleId = routeId(req);

    const sale = await prisma.vente.findFirst({
      where: {
        id: saleId,
        organisationId: context.organizationId,
        // Un membre limité à une boutique ne peut consulter que ses ventes.
        ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : {}),
      },
      include: {
        lignes: { include: { produit: { select: { id: true, nom: true, unite: true } } } },
        client: { select: { id: true, nom: true, telephone: true } },
        vendeur: { select: { id: true, prenom: true, nom: true } },
        boutique: { select: { id: true, nom: true } },
      },
    });
    if (!sale) throw Errors.notFound("Vente introuvable");

    return jsonData(res, sale);
  }),
);

commerceRouter.post(
  "/sales/:id/cancel",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    requirePermission(context, "sale:cancel");

    const saleId = routeId(req);

    const sale = await cancelSale(context, saleId);

    await recordAuditLog({
      organisationId: context.organizationId,
      utilisateurId: context.userId,
      action: "sale.cancelled",
      entite: "Sale",
      entiteId: saleId,
    });

    return jsonData(res, sale);
  }),
);

// ---------------------------------------------------------------------------
// Achats
// ---------------------------------------------------------------------------

commerceRouter.get(
  "/purchases",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    const params = searchParams(req);

    const storeId = await resolveActiveStoreId(context, Number(params.get("storeId")) || undefined);
    const pagination = getPagination(params, 10);

    const where = { organisationId: context.organizationId, boutiqueId: storeId };

    const [purchases, total] = await Promise.all([
      prisma.achat.findMany({
        where,
        orderBy: { creeLe: "desc" },
        skip: (pagination.page - 1) * pagination.limit,
        take: pagination.limit,
        include: {
          lignes: { include: { produit: { select: { id: true, nom: true } } } },
          fournisseur: { select: { id: true, nom: true } },
        },
      }),
      prisma.achat.count({ where }),
    ]);

    return jsonPage(res, purchases, paginationMeta(pagination, total));
  }),
);

commerceRouter.post(
  "/purchases",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    requirePermission(context, "purchase:manage");

    const parsed = purchaseSchema.parse(req.body);
    const storeId = await resolveActiveStoreId(context, parsed.boutiqueId);

    const purchase = await createPurchase(context, storeId, parsed);
    return jsonData(res, purchase, { status: 201 });
  }),
);

commerceRouter.get(
  "/purchases/:id",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    // Même règle que la page Achats : les coûts d'achat ne sont pas visibles des vendeurs.
    requirePermission(context, "purchase:manage");
    const purchaseId = routeId(req);

    const purchase = await prisma.achat.findFirst({
      where: {
        id: purchaseId,
        organisationId: context.organizationId,
        // Un membre limité à une boutique ne peut consulter que ses achats.
        ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : {}),
      },
      include: {
        lignes: { include: { produit: { select: { id: true, nom: true, unite: true } } } },
        fournisseur: { select: { id: true, nom: true, telephone: true } },
        creePar: { select: { id: true, prenom: true, nom: true } },
        boutique: { select: { id: true, nom: true } },
      },
    });
    if (!purchase) throw Errors.notFound("Achat introuvable");

    return jsonData(res, purchase);
  }),
);

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

commerceRouter.get(
  "/customers",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    const params = searchParams(req);
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

    return jsonPage(res, customers, paginationMeta(pagination, total));
  }),
);

commerceRouter.post(
  "/customers",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    requirePermission(context, "customer:manage");

    const parsed = customerSchema.parse(req.body);
    const customer = await prisma.client.create({
      data: {
        organisationId: context.organizationId,
        nom: parsed.nom,
        telephone: parsed.telephone || null,
        email: parsed.email || null,
        adresse: parsed.adresse || null,
      },
    });

    return jsonData(res, customer, { status: 201 });
  }),
);

commerceRouter.put(
  "/customers/:id",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    requirePermission(context, "customer:manage");

    const customerId = routeId(req);

    const parsed = customerSchema.parse(req.body);
    const updated = await prisma.client.updateMany({
      where: { id: customerId, organisationId: context.organizationId },
      data: {
        nom: parsed.nom,
        telephone: parsed.telephone || null,
        email: parsed.email || null,
        adresse: parsed.adresse || null,
      },
    });
    if (updated.count === 0) throw Errors.notFound("Client introuvable");

    const customer = await prisma.client.findUnique({ where: { id: customerId } });
    return jsonData(res, customer);
  }),
);

commerceRouter.delete(
  "/customers/:id",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    requirePermission(context, "customer:manage");

    const customerId = routeId(req);

    const deleted = await prisma.client.deleteMany({
      where: { id: customerId, organisationId: context.organizationId },
    });
    if (deleted.count === 0) throw Errors.notFound("Client introuvable");

    return jsonMessage(res, "Client supprimé");
  }),
);

// ---------------------------------------------------------------------------
// Fournisseurs
// ---------------------------------------------------------------------------

commerceRouter.get(
  "/suppliers",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    const params = searchParams(req);
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

    return jsonPage(res, suppliers, paginationMeta(pagination, total));
  }),
);

commerceRouter.post(
  "/suppliers",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    requirePermission(context, "supplier:manage");

    const parsed = supplierSchema.parse(req.body);
    const supplier = await prisma.fournisseur.create({
      data: {
        organisationId: context.organizationId,
        nom: parsed.nom,
        telephone: parsed.telephone || null,
        email: parsed.email || null,
        adresse: parsed.adresse || null,
      },
    });

    return jsonData(res, supplier, { status: 201 });
  }),
);

commerceRouter.put(
  "/suppliers/:id",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    requirePermission(context, "supplier:manage");

    const supplierId = routeId(req);

    const parsed = supplierSchema.parse(req.body);
    const updated = await prisma.fournisseur.updateMany({
      where: { id: supplierId, organisationId: context.organizationId },
      data: {
        nom: parsed.nom,
        telephone: parsed.telephone || null,
        email: parsed.email || null,
        adresse: parsed.adresse || null,
      },
    });
    if (updated.count === 0) throw Errors.notFound("Fournisseur introuvable");

    const supplier = await prisma.fournisseur.findUnique({ where: { id: supplierId } });
    return jsonData(res, supplier);
  }),
);

commerceRouter.delete(
  "/suppliers/:id",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    requirePermission(context, "supplier:manage");

    const supplierId = routeId(req);

    const deleted = await prisma.fournisseur.deleteMany({
      where: { id: supplierId, organisationId: context.organizationId },
    });
    if (deleted.count === 0) throw Errors.notFound("Fournisseur introuvable");

    return jsonMessage(res, "Fournisseur supprimé");
  }),
);

// ---------------------------------------------------------------------------
// Dépenses
// ---------------------------------------------------------------------------

commerceRouter.get(
  "/expenses",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    const pagination = getPagination(searchParams(req), 20);

    const where = { organisationId: context.organizationId };

    const [expenses, total] = await Promise.all([
      prisma.depense.findMany({
        where,
        orderBy: { date: "desc" },
        skip: (pagination.page - 1) * pagination.limit,
        take: pagination.limit,
      }),
      prisma.depense.count({ where }),
    ]);

    return jsonPage(res, expenses, paginationMeta(pagination, total));
  }),
);

commerceRouter.post(
  "/expenses",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    requirePermission(context, "expense:manage");

    const parsed = expenseSchema.parse(req.body);
    const storeId = parsed.boutiqueId ? await resolveActiveStoreId(context, parsed.boutiqueId) : null;

    const expense = await prisma.depense.create({
      data: {
        organisationId: context.organizationId,
        boutiqueId: storeId,
        categorie: parsed.categorie,
        libelle: parsed.libelle,
        montant: parsed.montant,
        note: parsed.note || null,
        date: parsed.date ?? new Date(),
        creeParId: context.userId,
      },
    });

    return jsonData(res, expense, { status: 201 });
  }),
);

commerceRouter.delete(
  "/expenses/:id",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    requirePermission(context, "expense:manage");

    const expenseId = routeId(req);

    const deleted = await prisma.depense.deleteMany({
      where: { id: expenseId, organisationId: context.organizationId },
    });
    if (deleted.count === 0) throw Errors.notFound("Dépense introuvable");

    return jsonMessage(res, "Dépense supprimée");
  }),
);
