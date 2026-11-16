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
import { createSale } from "@/services/sale";
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
import { cancel, createMember, createProduit, createShop, resetDatabase } from "./helpers/factories";

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

/**
 * Le super administrateur ne doit voir AUCUNE donnée commerciale : ni clés
 * (revenue, sales, total…) ni montants. Un montant de vente « signature »
 * (ex : 7 777) ne doit apparaître nulle part dans ce qui lui est renvoyé.
 */
const COMMERCIAL_KEYS = /"(revenue|sales|total|amount|averageBasket|paymentMethods|topProducts|topOrganizations|recentSales|recentProducts|products|customers|purchases|suppliers|counts|trend|series|prixVente|devise)"/;

function expectNoCommercialData(payload: unknown, signatureAmounts: number[] = []) {
  // `total` est autorisé quand c'est un nombre de comptes (organisations, utilisateurs) : on le retire avant le contrôle.
  const json = JSON.stringify(payload, (key, value) =>
    key === "total" && (typeof value === "number" || typeof value === "object") ? undefined : value,
  );
  expect(json).not.toMatch(COMMERCIAL_KEYS);
  for (const amount of signatureAmounts) expect(json).not.toContain(String(amount));
}

describe("supervision de la plateforme sans données commerciales", () => {
  it("la vue d'ensemble compte boutiques et utilisateurs, sans chiffre d'affaires ni vente", async () => {
    const a = await createShop("Alpha");
    const b = await createShop("Bêta");
    const pa = await createProduit(a.organisation.id, a.boutique.id, { prixVente: 7777, stock: 50 });
    await sell(a, pa.id, 3);
    await createProduit(b.organisation.id, b.boutique.id, { prixVente: 8888, stock: 50 });

    const overview = await getPlatformOverview({ range: "30d" });

    expect(overview.organizations).toMatchObject({ total: 2, suspended: 0, created: 2 });
    expect(overview.users.total).toBe(2);
    expect(overview.stores).toBe(2);
    // Classement par dernière activité : la boutique qui a travaillé d'abord, avec une date seulement.
    expect(overview.recentlyActive[0]).toMatchObject({ name: "Alpha", status: "active" });
    expect(overview.recentlyActive[0].lastActivity).toBeInstanceOf(Date);
    expectNoCommercialData(overview, [7777, 23331, 8888]);
  });

  it("distingue boutiques actives, inactives, jamais utilisées et suspendues", async () => {
    const admin = await createSuperAdmin();
    const active = await createShop("Active");
    const sleeping = await createShop("Endormie");
    const never = await createShop("Jamais utilisée");
    const suspended = await createShop("Suspendue");

    const p1 = await createProduit(active.organisation.id, active.boutique.id, { stock: 50 });
    await sell(active, p1.id, 1);
    const p2 = await createProduit(sleeping.organisation.id, sleeping.boutique.id, { stock: 50 });
    const oldSale = await sell(sleeping, p2.id, 1);
    await prisma.vente.update({ where: { id: oldSale.id }, data: { creeLe: new Date(Date.now() - 45 * DAY_MS) } });
    await prisma.organisation.update({ where: { id: never.organisation.id }, data: { creeLe: new Date(Date.now() - 20 * DAY_MS) } });
    await setOrganizationActive(admin.id, suspended.organisation.id, false);
    await prisma.utilisateur.create({
      data: { prenom: "Sans", nom: "Boutique", email: "attente@test.local", motDePasseHash: "x", creeLe: new Date(Date.now() - 3 * DAY_MS) },
    });

    const overview = await getPlatformOverview();
    expect(overview.organizations).toMatchObject({ total: 4, active: 1, inactive: 2, suspended: 1 });

    const alerts = Object.fromEntries((await getPlatformAlerts()).map((alert) => [alert.key, alert.count]));
    expect(alerts).toEqual({ inactive: 1, neverUsed: 1, onboarding: 1, suspended: 1 });

    const names = async (status: "active" | "inactive" | "suspended" | "never") =>
      (await listOrganizations({ status, sort: "nom", order: "asc", pagination: page })).items.map((item) => item.nom);
    expect(await names("active")).toEqual(["Active"]);
    expect(await names("inactive")).toEqual(["Endormie", "Jamais utilisée"]);
    expect(await names("suspended")).toEqual(["Suspendue"]);
    expect(await names("never")).toEqual(["Jamais utilisée", "Suspendue"]);
  });

  it("les statistiques d'usage comptent inscriptions et dernières activités, sans vente", async () => {
    const shop = await createShop("Alpha");
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 7777, stock: 50 });
    await sell(shop, produit.id, 2);
    await cancel(shop.context, (await sell(shop, produit.id, 1)).id);
    await createShop("Bêta");

    const analytics = await getPlatformAnalytics();

    expect(analytics.signups).toHaveLength(12);
    expect(analytics.signups.at(-1)).toEqual(expect.objectContaining({ organizations: 2, users: 2 }));
    expect(analytics.organizationActivity).toEqual({ today: 1, week: 0, month: 0, older: 0, never: 1 });
    expect(analytics.userActivity.never + analytics.userActivity.today).toBe(2);
    expectNoCommercialData(analytics, [7777, 15554]);
  });
});

describe("gestion des boutiques et des utilisateurs", () => {
  it("liste les boutiques avec propriétaire, membres, dernière activité, recherche, tri et pagination", async () => {
    const a = await createShop("Alpha Market");
    await createShop("Bêta Shop");
    await createMember(a.organisation.id, Role.SELLER);
    const pa = await createProduit(a.organisation.id, a.boutique.id, { prixVente: 7777, stock: 50 });
    await sell(a, pa.id, 2);

    const byMembers = await listOrganizations({ sort: "members", order: "desc", pagination: page });
    expect(byMembers.total).toBe(2);
    expect(byMembers.items.map((item) => [item.nom, item.members, item.stores])).toEqual([
      ["Alpha Market", 2, 1],
      ["Bêta Shop", 1, 1],
    ]);
    expect(byMembers.items[0].owner?.email).toBe(a.owner.utilisateur.email);
    expect(byMembers.items[0].status).toBe("active");
    expect(byMembers.items[0].lastActivity).toBeInstanceOf(Date);
    expect(byMembers.items[1].lastActivity).toBeNull();
    expectNoCommercialData(byMembers.items, [7777, 15554]);

    const byActivity = await listOrganizations({ sort: "lastActivity", order: "desc", pagination: page });
    expect(byActivity.items[0].nom).toBe("Alpha Market");

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

  it("donne la fiche d'une boutique sans aucune donnée commerciale ni rien des autres", async () => {
    const a = await createShop("Alpha");
    const b = await createShop("Bêta");
    const pa = await createProduit(a.organisation.id, a.boutique.id, { nom: "Riz parfumé", prixVente: 7777, stock: 50 });
    const pb = await createProduit(b.organisation.id, b.boutique.id, { nom: "Eau", prixVente: 400, stock: 50 });
    await sell(a, pa.id, 3);
    await sell(b, pb.id, 9);

    const details = await getOrganizationDetails(a.organisation.id);

    expect(details).not.toBeNull();
    expect(details!.owner?.email).toBe(a.owner.utilisateur.email);
    expect(details!.status).toBe("active");
    expect(details!.lastActivity).toBeInstanceOf(Date);
    expect(details!.stores).toEqual([expect.objectContaining({ id: a.boutique.id, members: 0 })]);
    expect(details!.activity.every((event) => event.organization?.id === a.organisation.id)).toBe(true);
    expectNoCommercialData(details, [7777, 23331]);
    expect(JSON.stringify(details)).not.toContain("Riz parfumé");
    expect(JSON.stringify(details)).not.toContain("motDePasseHash");
    expect(await getOrganizationDetails(9999)).toBeNull();
  });

  it("l'API d'administration ne renvoie aucune donnée commerciale", async () => {
    const admin = await createSuperAdmin();
    signIn(admin.id);
    const shop = await createShop("Alpha");
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 7777, stock: 50 });
    await sell(shop, produit.id, 1);

    for (const path of ["/api/admin/overview", "/api/admin/analytics", "/api/admin/organizations", `/api/admin/organizations/${shop.organisation.id}`, "/api/admin/activity"]) {
      const response = await api.get(path);
      expect(response.status, path).toBe(200);
      expectNoCommercialData(response.body, [7777]);
    }
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
  it("montre comptes et administration, jamais les ventes ni les produits, et pagine par curseur", async () => {
    const admin = await createSuperAdmin();
    const shop = await createShop("Alpha");
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { nom: "Riz parfumé", prixVente: 7777, stock: 50 });
    const sale = await sell(shop, produit.id, 1);
    await cancel(shop.context, sale.id);
    await setOrganizationActive(admin.id, shop.organisation.id, false);

    const { events } = await getPlatformActivity({ limit: 20 });

    expect(events.map((event) => event.title).sort()).toEqual(
      ["Boutique suspendue", "Nouvel utilisateur inscrit", "Nouvelle boutique créée"].sort(),
    );
    expectNoCommercialData(events, [7777]);
    expect(JSON.stringify(events)).not.toContain("Riz parfumé");
    // Du plus récent au plus ancien ; le super administrateur n'apparaît pas comme « inscrit ».
    expect(events.map((event) => event.date.getTime())).toEqual(
      [...events].map((event) => event.date.getTime()).sort((x, y) => y - x),
    );
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);

    const onlyAdmin = await getPlatformActivity({ kind: "admin" });
    expect(onlyAdmin.events.map((event) => event.kind)).toEqual(["admin"]);

    const first = await getPlatformActivity({ limit: 2 });
    expect(first.events).toHaveLength(2);
    expect(first.nextBefore).not.toBeNull();
    const next = await getPlatformActivity({ limit: 2, before: first.nextBefore! });
    expect(next.events.every((event) => event.date < first.nextBefore!)).toBe(true);
  });
});
