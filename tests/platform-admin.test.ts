import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Session } from "@/lib/auth/token";

const sessionMock = vi.hoisted(() => ({ current: null as Session | null }));
vi.mock("@/lib/auth/token", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/token")>()),
  getRequestSession: vi.fn(async () => sessionMock.current),
}));

import { prisma } from "@/lib/prisma";
import { Role } from "@/generated/prisma/enums";
import {
  requireAuthContext,
  requirePageAuthContext,
  requirePageSuperAdmin,
  requireSuperAdmin,
  requireUserId,
  SESSION_EXPIRED_PATH,
} from "@/lib/auth/session";
import { createSale, cancelSale } from "@/services/sale";
import { getPlatformActivity, getPlatformAlerts, getPlatformAnalytics, getPlatformOverview } from "@/services/platform";
import {
  createOrganizationWithOwner,
  getOrganizationDetails,
  listOrganizations,
  listUsers,
  setOrganizationActive,
  setUserActive,
} from "@/services/platform-admin";
import { createApp } from "@/app";
import { createMember, createProduit, createShop, resetDatabase } from "./helpers/factories";

beforeEach(async () => {
  await resetDatabase();
  sessionMock.current = null;
});

function signIn(userId: number) {
  sessionMock.current = {
    expires: new Date(Date.now() + 3600_000).toISOString(),
    user: { id: userId, name: "Test", tenant: null },
  };
}

async function createSuperAdmin() {
  return prisma.utilisateur.create({
    data: { prenom: "Super", nom: "Admin", email: "admin@test.local", motDePasseHash: "x", superAdmin: true },
  });
}

type Shop = Awaited<ReturnType<typeof createShop>>;

async function sell(shop: Shop, produitId: number, quantite: number, remise = 0) {
  return createSale(shop.context, shop.boutique.id, { lignes: [{ produitId, quantite }], modePaiement: "CASH", remise });
}

const DAY_MS = 86_400_000;
const page = { page: 1, limit: 10 };

// Les routes /api/admin sont appelées par HTTP sur l'application Express.
const server = createApp().listen(0);
afterAll(() => void server.close());
const api = request(server);
const getOverview = () => api.get("/api/admin/overview");
const getAnalytics = () => api.get("/api/admin/analytics");
const getOrganizations = () => api.get("/api/admin/organizations");
const postOrganization = (body: object) => api.post("/api/admin/organizations").send(body);
const getOrganization = (id: number | string) => api.get(`/api/admin/organizations/${id}`);
const patchOrganization = (body: object, id: number | string) => api.patch(`/api/admin/organizations/${id}`).send(body);
const getUsers = () => api.get("/api/admin/users");
const patchUser = (body: object, id: number | string) => api.patch(`/api/admin/users/${id}`).send(body);
const getActivity = () => api.get("/api/admin/activity");
const patchProfile = (body: object) => api.patch("/api/admin/profile").send(body);

describe("accès à l'espace super administrateur", () => {
  /** Appelle toutes les routes /api/admin et renvoie leurs codes HTTP. */
  async function callEveryAdminRoute(organizationId: number, userId: number) {
    const responses = await Promise.all([
      getOverview(),
      getAnalytics(),
      getOrganizations(),
      postOrganization({}),
      getOrganization(organizationId),
      patchOrganization({ actif: false }, organizationId),
      getUsers(),
      patchUser({ actif: false }, userId),
      getActivity(),
      patchProfile({ prenom: "Pirate", nom: "Pirate" }),
    ]);
    return responses.map((response) => response.status);
  }

  it("refuse toutes les API sans session (401)", async () => {
    const shop = await createShop();
    const statuses = await callEveryAdminRoute(shop.organisation.id, shop.context.userId);
    expect(statuses).toEqual(Array(10).fill(401));
  });

  it("refuse toutes les API à un commerçant, même propriétaire (403), sans rien modifier", async () => {
    const shop = await createShop();
    const seller = await createMember(shop.organisation.id, Role.SELLER);
    signIn(shop.context.userId); // propriétaire de la boutique

    const statuses = await callEveryAdminRoute(shop.organisation.id, seller.utilisateur.id);

    expect(statuses).toEqual(Array(10).fill(403));
    expect((await prisma.organisation.findUniqueOrThrow({ where: { id: shop.organisation.id } })).actif).toBe(true);
    expect((await prisma.utilisateur.findUniqueOrThrow({ where: { id: seller.utilisateur.id } })).actif).toBe(true);
    expect((await prisma.utilisateur.findUniqueOrThrow({ where: { id: shop.context.userId } })).prenom).not.toBe("Pirate");
    await expect(requirePageSuperAdmin()).rejects.toMatchObject({ redirect: "/dashboard" });
  });

  it("refuse aussi un compte dont l'inscription n'est pas terminée", async () => {
    const user = await prisma.utilisateur.create({
      data: { prenom: "Nouveau", nom: "Compte", email: "nouveau@test.local", motDePasseHash: "x" },
    });
    signIn(user.id);

    await expect(requireSuperAdmin()).rejects.toMatchObject({ status: 403 });
    await expect(requirePageSuperAdmin()).rejects.toMatchObject({ redirect: "/onboarding" });
  });

  it("autorise le super administrateur, mais lui refuse l'espace commerçant", async () => {
    const admin = await createSuperAdmin();
    signIn(admin.id);

    await expect(requireSuperAdmin()).resolves.toEqual({ userId: admin.id });
    await expect(requirePageSuperAdmin()).resolves.toEqual({ userId: admin.id });
    expect((await getOverview()).status).toBe(200);

    await expect(requireAuthContext()).rejects.toMatchObject({ status: 403 });
    await expect(requireUserId()).rejects.toMatchObject({ status: 403 });
    await expect(requirePageAuthContext()).rejects.toMatchObject({ redirect: "/admin" });
  });

  it("retire l'accès dès que le statut de super administrateur est retiré en base", async () => {
    const admin = await createSuperAdmin();
    signIn(admin.id);
    await prisma.utilisateur.update({ where: { id: admin.id }, data: { superAdmin: false } });

    await expect(requireSuperAdmin()).rejects.toMatchObject({ status: 403 });
  });

  it("note la dernière activité du compte, au plus une fois par quart d'heure", async () => {
    const shop = await createShop();
    signIn(shop.context.userId);

    await requireAuthContext();
    const first = (await prisma.utilisateur.findUniqueOrThrow({ where: { id: shop.context.userId } })).derniereActiviteLe;
    expect(first).not.toBeNull();

    await requireAuthContext();
    const second = (await prisma.utilisateur.findUniqueOrThrow({ where: { id: shop.context.userId } })).derniereActiviteLe;
    expect(second).toEqual(first);
  });
});

describe("suspension d'une boutique et désactivation d'un compte", () => {
  it("coupe l'accès des membres d'une boutique suspendue, puis le rétablit", async () => {
    const admin = await createSuperAdmin();
    const shop = await createShop();

    signIn(admin.id);
    expect((await patchOrganization({ actif: false }, shop.organisation.id)).status).toBe(200);

    signIn(shop.context.userId);
    await expect(requireAuthContext()).rejects.toMatchObject({ status: 403 });
    await expect(requirePageAuthContext()).rejects.toMatchObject({ redirect: "/suspendu" });

    await setOrganizationActive(admin.id, shop.organisation.id, true);
    await expect(requireAuthContext()).resolves.toMatchObject({ organizationId: shop.organisation.id });

    const actions = await prisma.journalAudit.findMany({ orderBy: { id: "asc" }, select: { action: true, utilisateurId: true } });
    expect(actions).toEqual([
      { action: "organization.suspended", utilisateurId: admin.id },
      { action: "organization.reactivated", utilisateurId: admin.id },
    ]);
  });

  it("ferme la session d'un compte désactivé", async () => {
    const admin = await createSuperAdmin();
    const shop = await createShop();
    const seller = await createMember(shop.organisation.id, Role.SELLER);

    signIn(admin.id);
    expect((await patchUser({ actif: false }, seller.utilisateur.id)).status).toBe(200);

    signIn(seller.utilisateur.id);
    await expect(requireAuthContext()).rejects.toMatchObject({ status: 401 });
    await expect(requirePageAuthContext()).rejects.toMatchObject({ redirect: SESSION_EXPIRED_PATH });
    // Les autres membres de la boutique ne sont pas touchés.
    signIn(shop.context.userId);
    await expect(requireAuthContext()).resolves.toMatchObject({ role: Role.OWNER });
  });

  it("ne permet pas de désactiver un super administrateur, et valide les entrées", async () => {
    const admin = await createSuperAdmin();
    signIn(admin.id);

    await expect(setUserActive(admin.id, admin.id, false)).rejects.toMatchObject({ status: 409 });
    expect((await patchUser({ actif: "non" }, admin.id)).status).toBe(400);
    expect((await patchOrganization({ actif: false }, 9999)).status).toBe(404);
    expect((await patchOrganization({ actif: false }, "abc")).status).toBe(400);
  });
});

describe("statistiques de la plateforme", () => {
  it("additionne le CA de toutes les boutiques, sans les ventes annulées et sans mélanger les devises", async () => {
    const a = await createShop("Alpha");
    const b = await createShop("Bêta");
    const euro = await createShop("Gamma");
    await prisma.organisation.update({ where: { id: euro.organisation.id }, data: { devise: "EUR" } });

    const pa = await createProduit(a.organisation.id, a.boutique.id, { prixVente: 1000, stock: 50 });
    const pb = await createProduit(b.organisation.id, b.boutique.id, { prixVente: 2000, stock: 50 });
    const pe = await createProduit(euro.organisation.id, euro.boutique.id, { prixVente: 10, stock: 50 });

    await sell(a, pa.id, 3, 500); // 2 500 XOF
    await sell(b, pb.id, 2); // 4 000 XOF
    await sell(b, pb.id, 1); // 2 000 XOF
    await sell(euro, pe.id, 4); // 40 EUR : jamais additionné aux XOF
    await cancelSale(a.context, (await sell(a, pa.id, 10)).id); // annulée : ignorée

    const overview = await getPlatformOverview({ range: "30d" });

    expect(overview.currency).toBe("XOF");
    expect(overview.currencies).toEqual(["XOF", "EUR"]);
    expect(overview.revenue.allTime).toBe(8500);
    expect(overview.revenue.period).toBe(8500);
    expect(overview.revenue.today).toBe(8500);
    expect(overview.revenue.month).toBe(8500);
    expect(overview.revenue.periodChange).toBeNull();
    expect(overview.sales).toMatchObject({ allTime: 4, today: 4, period: 4 }); // toutes devises
    expect(overview.organizations).toMatchObject({ total: 3, suspended: 0, active: 3, inactive: 0, created: 3 });
    expect(overview.users.total).toBe(3);
    expect(overview.products).toBe(3);
    expect(overview.stores).toBe(3);

    // La série couvre 30 jours et son total retombe sur le CA de la période.
    expect(overview.series).toHaveLength(30);
    expect(overview.series.reduce((total, point) => total + point.value, 0)).toBe(8500);
    expect(overview.series.reduce((total, point) => total + point.count, 0)).toBe(4);
    expect(overview.series.at(-1)).toMatchObject({ value: 8500, count: 4 });

    expect(overview.topOrganizations.map((row) => [row.name, row.sales, row.revenue])).toEqual([
      ["Bêta", 2, 6000],
      ["Alpha", 1, 2500],
      ["Gamma", 1, 40],
    ]);
    expect(overview.topProducts[0]).toMatchObject({ quantity: 4, organization: "Gamma", currency: "EUR" });

    const inEuro = await getPlatformOverview({ range: "today", currency: "EUR" });
    expect(inEuro.revenue.allTime).toBe(40);
    expect(inEuro.series).toHaveLength(24);
    expect(inEuro.series.reduce((total, point) => total + point.value, 0)).toBe(40);

    // Une devise inconnue retombe sur la devise principale.
    expect((await getPlatformOverview({ currency: "ZZZ" })).currency).toBe("XOF");
  });

  it("compare la période à la précédente et classe hors période les ventes anciennes", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 1000, stock: 50 });
    await sell(shop, produit.id, 3); // 3 000 aujourd'hui

    const previous = await sell(shop, produit.id, 2); // 2 000, il y a 10 jours
    await prisma.vente.update({ where: { id: previous.id }, data: { creeLe: new Date(Date.now() - 10 * DAY_MS) } });
    const old = await sell(shop, produit.id, 1); // 1 000, il y a 200 jours
    await prisma.vente.update({ where: { id: old.id }, data: { creeLe: new Date(Date.now() - 200 * DAY_MS) } });

    const week = await getPlatformOverview({ range: "7d" });
    expect(week.revenue.period).toBe(3000);
    expect(week.revenue.periodChange).toBeCloseTo(50, 5); // 3 000 contre 2 000 les 7 jours d'avant
    expect(week.revenue.allTime).toBe(6000);
    expect(week.sales.period).toBe(1);
    expect(week.series).toHaveLength(7);

    const quarter = await getPlatformOverview({ range: "90d" });
    expect(quarter.revenue.period).toBe(5000);
    expect(quarter.series).toHaveLength(90);
  });

  it("distingue boutiques actives, inactives et suspendues, et signale ce qui demande attention", async () => {
    const admin = await createSuperAdmin();
    const active = await createShop("Active");
    const sleeping = await createShop("Endormie");
    const empty = await createShop("Sans vente");
    const suspended = await createShop("Suspendue");

    const p1 = await createProduit(active.organisation.id, active.boutique.id, { stock: 50 });
    await sell(active, p1.id, 1);
    const p2 = await createProduit(sleeping.organisation.id, sleeping.boutique.id, { stock: 50 });
    const oldSale = await sell(sleeping, p2.id, 1);
    await prisma.vente.update({ where: { id: oldSale.id }, data: { creeLe: new Date(Date.now() - 45 * DAY_MS) } });
    await prisma.organisation.update({
      where: { id: empty.organisation.id },
      data: { creeLe: new Date(Date.now() - 20 * DAY_MS) },
    });
    await setOrganizationActive(admin.id, suspended.organisation.id, false);
    await prisma.utilisateur.create({
      data: {
        prenom: "Sans",
        nom: "Boutique",
        email: "attente@test.local",
        motDePasseHash: "x",
        creeLe: new Date(Date.now() - 3 * DAY_MS),
      },
    });

    const overview = await getPlatformOverview();
    expect(overview.organizations).toMatchObject({ total: 4, active: 1, inactive: 2, suspended: 1 });

    const alerts = Object.fromEntries((await getPlatformAlerts()).map((alert) => [alert.key, alert.count]));
    expect(alerts).toEqual({ inactive: 1, noSales: 1, onboarding: 1, suspended: 1 });

    const names = async (status: "active" | "inactive" | "suspended" | "nosales") =>
      (await listOrganizations({ status, sort: "nom", order: "asc", pagination: page })).items.map((item) => item.nom);
    expect(await names("active")).toEqual(["Active"]);
    expect(await names("inactive")).toEqual(["Endormie", "Sans vente"]);
    expect(await names("suspended")).toEqual(["Suspendue"]);
    expect(await names("nosales")).toEqual(["Sans vente", "Suspendue"]);
  });

  it("calcule les statistiques détaillées : paiements, annulations, classement, inscriptions", async () => {
    const shop = await createShop("Alpha");
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 1000, stock: 50 });
    await sell(shop, produit.id, 2);
    await createSale(shop.context, shop.boutique.id, {
      lignes: [{ produitId: produit.id, quantite: 1 }],
      modePaiement: "MOBILE_MONEY",
      remise: 0,
    });
    await sell(shop, produit.id, 4);
    await cancelSale(shop.context, (await sell(shop, produit.id, 1)).id);

    const analytics = await getPlatformAnalytics({ range: "30d" });

    expect(analytics.revenue.period).toBe(7000);
    expect(analytics.revenue.averageBasket).toBeCloseTo(7000 / 3, 5);
    expect(analytics.sales).toMatchObject({ period: 3, cancelled: 1 });
    expect(analytics.sales.cancellationRate).toBeCloseTo(25, 5);
    expect(analytics.paymentMethods).toEqual([
      { method: "CASH", count: 2, revenue: 6000 },
      { method: "MOBILE_MONEY", count: 1, revenue: 1000 },
    ]);
    expect(analytics.ranking).toHaveLength(1);
    expect(analytics.ranking[0]).toMatchObject({ name: "Alpha", sales: 3, revenue: 7000, status: "active" });
    expect(analytics.signups).toHaveLength(12);
    expect(analytics.signups.at(-1)).toEqual(expect.objectContaining({ organizations: 1, users: 1 }));
  });
});

describe("gestion des boutiques et des utilisateurs", () => {
  it("liste les boutiques avec propriétaire, compteurs, CA, recherche, tri et pagination", async () => {
    const a = await createShop("Alpha Market");
    const b = await createShop("Bêta Shop");
    await createMember(a.organisation.id, Role.SELLER);
    const pa = await createProduit(a.organisation.id, a.boutique.id, { prixVente: 1000, stock: 50 });
    await createProduit(a.organisation.id, a.boutique.id);
    const pb = await createProduit(b.organisation.id, b.boutique.id, { prixVente: 5000, stock: 50 });
    await sell(a, pa.id, 2);
    await sell(a, pa.id, 1);
    await sell(b, pb.id, 1);
    await cancelSale(b.context, (await sell(b, pb.id, 9)).id);

    const byRevenue = await listOrganizations({ sort: "revenue", order: "desc", pagination: page });
    expect(byRevenue.total).toBe(2);
    expect(byRevenue.items.map((item) => [item.nom, item.sales, item.revenue, item.products, item.members])).toEqual([
      ["Bêta Shop", 1, 5000, 1, 1],
      ["Alpha Market", 2, 3000, 2, 2],
    ]);
    expect(byRevenue.items[1].owner?.email).toBe(a.owner.utilisateur.email);
    expect(byRevenue.items[0].status).toBe("active");

    const bySales = await listOrganizations({ sort: "sales", order: "desc", pagination: page });
    expect(bySales.items[0].nom).toBe("Alpha Market");

    const search = await listOrganizations({ search: "bêta", pagination: page });
    expect(search.items.map((item) => item.nom)).toEqual(["Bêta Shop"]);
    const byOwner = await listOrganizations({ search: a.owner.utilisateur.email!, pagination: page });
    expect(byOwner.items.map((item) => item.nom)).toEqual(["Alpha Market"]);
    // Les caractères joker ne sont pas interprétés.
    expect((await listOrganizations({ search: "%", pagination: page })).total).toBe(0);

    const second = await listOrganizations({ sort: "nom", order: "asc", pagination: { page: 2, limit: 1 } });
    expect(second.total).toBe(2);
    expect(second.items.map((item) => item.nom)).toEqual(["Bêta Shop"]);
  });

  it("donne le détail d'une boutique sans rien exposer des autres", async () => {
    const a = await createShop("Alpha");
    const b = await createShop("Bêta");
    const pa = await createProduit(a.organisation.id, a.boutique.id, { nom: "Riz", prixVente: 1000, stock: 50 });
    const pb = await createProduit(b.organisation.id, b.boutique.id, { nom: "Eau", prixVente: 400, stock: 50 });
    await sell(a, pa.id, 3, 500);
    await sell(b, pb.id, 9);

    const details = await getOrganizationDetails(a.organisation.id);

    expect(details).not.toBeNull();
    expect(details!.owner?.email).toBe(a.owner.utilisateur.email);
    expect(details!.counts).toMatchObject({ products: 1, sales: 1, cancelledSales: 0 });
    expect(details!.revenue).toMatchObject({ allTime: 2500, month: 2500, averageBasket: 2500 });
    expect(details!.trend).toHaveLength(30);
    expect(details!.trend.at(-1)).toMatchObject({ value: 2500, count: 1 });
    expect(details!.topProducts.map((product) => product.nom)).toEqual(["Riz"]);
    expect(details!.recentSales).toHaveLength(1);
    expect(details!.activity.every((event) => event.organization?.id === a.organisation.id)).toBe(true);
    expect(JSON.stringify(details)).not.toContain("motDePasseHash");
    expect(await getOrganizationDetails(9999)).toBeNull();
  });

  it("crée une boutique avec son propriétaire, et refuse un email déjà pris", async () => {
    const admin = await createSuperAdmin();
    signIn(admin.id);
    const body = {
      nomOrganisation: "Chez Awa",
      nomBoutique: "Marché central",
      devise: "GNF",
      prenom: "Awa",
      nom: "Barry",
      identifiant: "Awa@Test.Local",
      motDePasse: "Secret123",
    };

    const response = await postOrganization(body);
    expect(response.status).toBe(201);

    const owner = await prisma.utilisateur.findUniqueOrThrow({
      where: { email: "awa@test.local" },
      include: { membre: { include: { organisation: { include: { boutiques: true } } } } },
    });
    expect(owner.superAdmin).toBe(false);
    expect(owner.motDePasseHash).not.toBe("Secret123");
    expect(owner.membre?.role).toBe(Role.OWNER);
    expect(owner.membre?.organisation).toMatchObject({ nom: "Chez Awa", devise: "GNF", actif: true });
    expect(owner.membre?.organisation.boutiques).toMatchObject([{ nom: "Marché central", parDefaut: true }]);

    expect((await postOrganization(body)).status).toBe(409);
    expect((await postOrganization({ ...body, identifiant: "autre@test.local", motDePasse: "court" })).status).toBe(400);
    expect(await prisma.organisation.count()).toBe(1);
    await expect(
      createOrganizationWithOwner(admin.id, { ...body, devise: "GNF", identifiant: "awa@test.local" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("liste les utilisateurs avec rôle, boutique, filtres et recherche, sans jamais exposer le mot de passe", async () => {
    await createSuperAdmin();
    const shop = await createShop("Alpha");
    const seller = await createMember(shop.organisation.id, Role.SELLER, shop.boutique.id);
    await prisma.utilisateur.update({ where: { id: seller.utilisateur.id }, data: { actif: false } });
    await prisma.utilisateur.create({
      data: { prenom: "Sans", nom: "Boutique", email: "attente@test.local", motDePasseHash: "x" },
    });

    const all = await listUsers({ pagination: { page: 1, limit: 15 } });
    expect(all.total).toBe(4);
    expect(JSON.stringify(all)).not.toContain("motDePasseHash");

    const emails = async (options: Omit<Parameters<typeof listUsers>[0], "pagination">) =>
      (await listUsers({ ...options, pagination: { page: 1, limit: 15 } })).items.map((item) => item.email);
    expect(await emails({ role: "SUPER_ADMIN" })).toEqual(["admin@test.local"]);
    expect(await emails({ role: Role.SELLER })).toEqual([seller.utilisateur.email]);
    expect(await emails({ status: "disabled" })).toEqual([seller.utilisateur.email]);
    expect(await emails({ status: "onboarding" })).toEqual(["attente@test.local"]);
    expect(await emails({ search: "ALPHA", sort: "nom", order: "asc" })).toHaveLength(2); // par nom de boutique

    const sellerRow = (await listUsers({ role: Role.SELLER, pagination: page })).items[0];
    expect(sellerRow).toMatchObject({ role: Role.SELLER, storeName: shop.boutique.nom, actif: false });
    expect(sellerRow.organization?.nom).toBe("Alpha");
  });

  it("modifie le profil du super administrateur et exige l'ancien mot de passe", async () => {
    const { hashPassword, verifyPassword } = await import("@/lib/auth/password");
    const admin = await prisma.utilisateur.create({
      data: {
        prenom: "Super",
        nom: "Admin",
        email: "root@test.local",
        motDePasseHash: await hashPassword("Ancien123"),
        superAdmin: true,
      },
    });
    signIn(admin.id);

    const wrong = await patchProfile({
      prenom: "Amadou",
      nom: "Diallo",
      motDePasseActuel: "Mauvais123",
      nouveauMotDePasse: "Nouveau123",
    });
    expect(wrong.status).toBe(409);
    expect((await patchProfile({ prenom: "Amadou", nom: "Diallo", nouveauMotDePasse: "Nouveau123" })).status).toBe(400);

    const ok = await patchProfile({
      prenom: "Amadou",
      nom: "Diallo",
      motDePasseActuel: "Ancien123",
      nouveauMotDePasse: "Nouveau123",
    });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.body)).not.toContain("motDePasseHash");

    const updated = await prisma.utilisateur.findUniqueOrThrow({ where: { id: admin.id } });
    expect(updated.prenom).toBe("Amadou");
    expect(await verifyPassword("Nouveau123", updated.motDePasseHash)).toBe(true);
  });
});

describe("activité récente de la plateforme", () => {
  it("fusionne les événements réels, les filtre par type et les pagine par curseur", async () => {
    const admin = await createSuperAdmin();
    const shop = await createShop("Alpha");
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { nom: "Riz", stock: 50 });
    const sale = await sell(shop, produit.id, 1);
    await cancelSale(shop.context, sale.id);
    await setOrganizationActive(admin.id, shop.organisation.id, false);

    const { events } = await getPlatformActivity({ limit: 20 });

    expect(events.map((event) => event.title).sort()).toEqual(
      [
        "Boutique suspendue",
        "Nouvel utilisateur inscrit",
        "Nouvelle boutique créée",
        "Produit ajouté",
        `Vente #${String(sale.id).padStart(5, "0")} annulée`,
        `Vente #${String(sale.id).padStart(5, "0")} enregistrée`,
      ].sort(),
    );
    // Du plus récent au plus ancien ; le super administrateur n'apparaît pas comme « inscrit ».
    expect(events.map((event) => event.date.getTime())).toEqual(
      [...events].map((event) => event.date.getTime()).sort((x, y) => y - x),
    );
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);

    const onlySales = await getPlatformActivity({ kind: "sale" });
    expect(onlySales.events.every((event) => event.kind === "sale")).toBe(true);
    expect(onlySales.events).toHaveLength(2);

    const first = await getPlatformActivity({ limit: 2 });
    expect(first.events).toHaveLength(2);
    expect(first.nextBefore).not.toBeNull();
    const next = await getPlatformActivity({ limit: 2, before: first.nextBefore! });
    expect(next.events.every((event) => event.date < first.nextBefore!)).toBe(true);
  });
});
