/**
 * Ventes en attente (panier mis de côté au comptoir) et boutique active du site.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Session } from "@/lib/auth/token";

const sessionMock = vi.hoisted(() => ({ current: null as Session | null }));
vi.mock("@/lib/auth/token", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/token")>()),
  getRequestSession: vi.fn(async () => sessionMock.current),
}));

import { prisma } from "@/lib/prisma";
import { Role } from "@/generated/prisma/enums";
import { createApp } from "@/app";
import { ACTIVE_STORE_COOKIE } from "@/lib/auth/store";
import { createMember, createProduit, createShop, resetDatabase, stockOf, testKey } from "./helpers/factories";

const app = createApp();

beforeEach(async () => {
  await resetDatabase();
  sessionMock.current = null;
});

function signIn(userId: number, organizationId: number, role: Role) {
  sessionMock.current = {
    expires: new Date(Date.now() + 3600_000).toISOString(),
    user: { id: userId, name: "Test", tenant: { organizationId, role, storeId: null, organizationName: "Org" } },
  };
}

describe("ventes en attente", () => {
  it("le scénario des deux clients : mettre en attente, servir le second, reprendre le premier intact", async () => {
    const shop = await createShop();
    const riz = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 1_000, stock: 10 });
    const huile = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 2_500, stock: 10 });
    const awa = await prisma.client.create({ data: { organisationId: shop.organisation.id, nom: "Awa" } });
    const seller = await createMember(shop.organisation.id, Role.SELLER);
    signIn(seller.utilisateur.id, shop.organisation.id, Role.SELLER);

    // Client 1 : panier long, mis en attente. Rien ne sort du stock.
    const panier = { lignes: [{ produitId: riz.id, quantite: 3 }, { produitId: huile.id, quantite: 1, prixUnitaire: 2_400 }], clientId: awa.id, modePaiement: "CASH", remise: 100 };
    const held = await request(app).post("/api/held-sales").send({ panier });
    expect(held.status).toBe(201);
    expect(held.body.data).toMatchObject({ libelle: "Awa", nombreArticles: 4 });
    expect(Number(held.body.data.totalEstime)).toBe(5_300); // 3 × 1 000 + 2 400 − 100
    expect(await stockOf(shop.boutique.id, riz.id)).toBe(10);

    // Client 2 : vente rapide.
    expect((await request(app).post("/api/sales").set("Idempotency-Key", testKey()).send({ modePaiement: "CASH", lignes: [{ produitId: riz.id, quantite: 1 }] })).status).toBe(201);

    // Reprise du client 1 : panier identique, et il quitte la liste.
    const list = await request(app).get("/api/held-sales");
    expect(list.body.data).toHaveLength(1);
    const resumed = await request(app).post(`/api/held-sales/${held.body.data.id}/resume`);
    expect(resumed.status).toBe(200);
    expect(resumed.body.data.panier).toMatchObject({ clientId: awa.id, remise: 100, lignes: panier.lignes });
    expect((await request(app).get("/api/held-sales")).body.data).toHaveLength(0);

    // L'encaissement suit le parcours normal (stock revérifié).
    const sale = await request(app).post("/api/sales").set("Idempotency-Key", testKey()).send(resumed.body.data.panier);
    expect(sale.status).toBe(201);
    expect(await stockOf(shop.boutique.id, riz.id)).toBe(6);
  });

  it("deux caissiers reprennent la même vente en même temps : un seul la récupère", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 5 });
    signIn(shop.owner.utilisateur.id, shop.organisation.id, Role.OWNER);
    const held = await request(app).post("/api/held-sales").send({ panier: { lignes: [{ produitId: produit.id, quantite: 1 }] } });

    const results = await Promise.all([1, 2, 3].map(() => request(app).post(`/api/held-sales/${held.body.data.id}/resume`)));
    expect(results.filter((response) => response.status === 200)).toHaveLength(1);
    expect(results.filter((response) => response.status === 404)).toHaveLength(2);
  });

  it("expire après 24 h ; refuse un panier vide ou un produit d'une autre organisation", async () => {
    const shop = await createShop();
    const other = await createShop("Autre");
    const produit = await createProduit(shop.organisation.id, shop.boutique.id);
    const foreign = await createProduit(other.organisation.id, other.boutique.id);
    signIn(shop.owner.utilisateur.id, shop.organisation.id, Role.OWNER);

    const held = await request(app).post("/api/held-sales").send({ panier: { lignes: [{ produitId: produit.id, quantite: 1 }] } });
    await prisma.venteEnAttente.update({ where: { id: held.body.data.id }, data: { expireLe: new Date(Date.now() - 1_000) } });
    expect((await request(app).get("/api/held-sales")).body.data).toHaveLength(0);
    expect((await request(app).post(`/api/held-sales/${held.body.data.id}/resume`)).status).toBe(404);

    expect((await request(app).post("/api/held-sales").send({ panier: { lignes: [] } })).status).toBe(400);
    expect((await request(app).post("/api/held-sales").send({ panier: { lignes: [{ produitId: foreign.id, quantite: 1 }] } })).status).toBe(404);
  });

  it("isolation : une autre organisation ou une autre boutique ne voit ni ne reprend la vente", async () => {
    const shop = await createShop();
    const annexe = await prisma.boutique.create({ data: { organisationId: shop.organisation.id, nom: "Annexe" } });
    const annexeSeller = await createMember(shop.organisation.id, Role.SELLER, annexe.id);
    const other = await createShop("Autre");
    const produit = await createProduit(shop.organisation.id, shop.boutique.id);
    signIn(shop.owner.utilisateur.id, shop.organisation.id, Role.OWNER);
    const held = await request(app).post("/api/held-sales").send({ panier: { lignes: [{ produitId: produit.id, quantite: 1 }] } });

    signIn(annexeSeller.utilisateur.id, shop.organisation.id, Role.SELLER);
    expect((await request(app).get("/api/held-sales")).body.data).toHaveLength(0);
    expect((await request(app).post(`/api/held-sales/${held.body.data.id}/resume`)).status).toBe(404);

    signIn(other.owner.utilisateur.id, other.organisation.id, Role.OWNER);
    expect((await request(app).get("/api/held-sales")).body.data).toHaveLength(0);
    expect((await request(app).delete(`/api/held-sales/${held.body.data.id}`)).status).toBe(404);

    const stockManager = await createMember(shop.organisation.id, Role.STOCK_MANAGER);
    signIn(stockManager.utilisateur.id, shop.organisation.id, Role.STOCK_MANAGER);
    expect((await request(app).get("/api/held-sales")).status).toBe(403);
  });
});

describe("boutique active du site", () => {
  it("une vente du site est enregistrée dans la boutique du sélecteur, pas dans la boutique par défaut", async () => {
    const shop = await createShop();
    const annexe = await prisma.boutique.create({ data: { organisationId: shop.organisation.id, nom: "Annexe" } });
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 5 });
    await prisma.stock.create({ data: { boutiqueId: annexe.id, produitId: produit.id, quantite: 5 } });
    signIn(shop.owner.utilisateur.id, shop.organisation.id, Role.OWNER);

    const sale = await request(app)
      .post("/api/sales")
      .set("Cookie", `${ACTIVE_STORE_COOKIE}=${annexe.id}`)
      .set("Origin", "http://localhost:5173")
      .set("Idempotency-Key", testKey())
      .send({ modePaiement: "CASH", lignes: [{ produitId: produit.id, quantite: 2 }] });
    expect(sale.status).toBe(201);
    expect(sale.body.data.boutiqueId).toBe(annexe.id);
    expect(await stockOf(annexe.id, produit.id)).toBe(3);
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(5);
  });
});
