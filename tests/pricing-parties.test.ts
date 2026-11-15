/**
 * Phase 2 : politique de prix (F-03), protection des clients et fournisseurs
 * (F-05) et coûts d'achat jamais exposés à un vendeur (F-04).
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
import { createSale } from "@/services/sale";
import { createPurchase } from "@/services/purchase";
import { createMember, createProduit, createShop, resetDatabase, testKey } from "./helpers/factories";

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

type Shop = Awaited<ReturnType<typeof createShop>>;

async function as(shop: Shop, role: Role) {
  if (role === Role.OWNER) {
    signIn(shop.owner.utilisateur.id, shop.organisation.id, Role.OWNER);
    return shop.owner;
  }
  const member = await createMember(shop.organisation.id, role);
  signIn(member.utilisateur.id, shop.organisation.id, role);
  return member;
}

function postSale(body: object) {
  return request(app).post("/api/sales").set("Idempotency-Key", testKey("sale")).send({ modePaiement: "CASH", ...body });
}

describe("politique de prix et de remise (F-03)", () => {
  it("vendeur : 10 % accepté, 10,1 % refusé, vente à 0 F refusée — sans toucher au stock", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 100, prixVente: 1_000, stock: 10 });
    await as(shop, Role.SELLER);

    expect((await postSale({ lignes: [{ produitId: produit.id, quantite: 1 }], remise: 100 })).status).toBe(201);
    const tooMuch = await postSale({ lignes: [{ produitId: produit.id, quantite: 1 }], remise: 101 });
    expect(tooMuch.status).toBe(403);
    expect(tooMuch.body.message).toContain("10 %");
    expect((await postSale({ lignes: [{ produitId: produit.id, quantite: 1, prixUnitaire: 0 }] })).status).toBe(403);
    // Le prix négocié compte comme une remise : 850 au lieu de 1 000 = 15 %.
    expect((await postSale({ lignes: [{ produitId: produit.id, quantite: 1, prixUnitaire: 850 }] })).status).toBe(403);

    const stock = await prisma.stock.findFirstOrThrow({ where: { produitId: produit.id } });
    expect(stock.quantite).toBe(9); // seule la vente autorisée a fait sortir du stock
  });

  it("gérant : 30 % au plus, et jamais sous le coût d'achat", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 800, prixVente: 1_000, stock: 10 });
    await as(shop, Role.MANAGER);

    // 15 % : prix net 850 ≥ coût 800 → accepté.
    expect((await postSale({ lignes: [{ produitId: produit.id, quantite: 1 }], remise: 150 })).status).toBe(201);
    // 25 % : dans le plafond, mais prix net 750 < coût 800 → refusé.
    const belowCost = await postSale({ lignes: [{ produitId: produit.id, quantite: 1 }], remise: 250 });
    expect(belowCost.status).toBe(403);
    expect(belowCost.body.message).toContain("coût d'achat");
  });

  it("propriétaire : sans limite, mais chaque dérogation est tracée", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 800, prixVente: 1_000, stock: 10 });
    await as(shop, Role.OWNER);

    const response = await postSale({ lignes: [{ produitId: produit.id, quantite: 2, prixUnitaire: 0 }] });
    expect(response.status).toBe(201);
    const audit = await prisma.journalAudit.findFirstOrThrow({ where: { action: "sale.price_override", entiteId: response.body.data.id } });
    expect(audit.utilisateurId).toBe(shop.owner.utilisateur.id);
    expect(JSON.stringify(audit.metadonnees)).toContain("\"prixApplique\":\"0\"");
  });

  it("plafonds réglables par le propriétaire seulement, gérant ≥ vendeur, changement tracé", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 100, prixVente: 1_000, stock: 10 });
    const body = { nom: "Boutique", devise: "XOF", fuseauHoraire: "Africa/Abidjan" };

    await as(shop, Role.ADMIN);
    expect((await request(app).put("/api/organization").send({ ...body, remiseMaxVendeurPct: 20 })).status).toBe(403);

    await as(shop, Role.OWNER);
    expect((await request(app).put("/api/organization").send({ ...body, remiseMaxVendeurPct: 40, remiseMaxGerantPct: 30 })).status).toBe(400);
    expect((await request(app).put("/api/organization").send({ ...body, remiseMaxVendeurPct: 20 })).status).toBe(200);
    expect(await prisma.journalAudit.count({ where: { action: "organization.pricing_policy_changed" } })).toBe(1);

    await as(shop, Role.SELLER);
    expect((await postSale({ lignes: [{ produitId: produit.id, quantite: 1 }], remise: 200 })).status).toBe(201);
  });

  it("le changement de prix d'un produit est tracé (avant / après)", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 100, prixVente: 1_000 });
    await as(shop, Role.OWNER);
    await request(app)
      .put(`/api/products/${produit.id}`)
      .send({ nom: produit.nom, unite: "unité", prixAchat: 120, prixVente: 1_100, seuilAlerte: 5 })
      .expect(200);
    const audit = await prisma.journalAudit.findFirstOrThrow({ where: { action: "product.price_changed", entiteId: produit.id } });
    expect(audit.metadonnees).toMatchObject({ prixVente: { avant: "1000", apres: "1100" }, prixAchat: { avant: "100", apres: "120" } });
  });
});

describe("clients et fournisseurs protégés (F-05)", () => {
  it("un client débiteur est archivé, jamais supprimé ; sa créance garde son client", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 10_000 });
    const awa = await prisma.client.create({ data: { organisationId: shop.organisation.id, nom: "Awa" } });
    const sale = await createSale(shop.context, shop.boutique.id, { lignes: [{ produitId: produit.id, quantite: 1 }], modePaiement: "CREDIT", clientId: awa.id, montantPaye: 0, remise: 0 }, testKey());

    await as(shop, Role.SELLER);
    expect((await request(app).delete(`/api/customers/${awa.id}`)).status).toBe(403);

    await as(shop, Role.MANAGER);
    const removed = await request(app).delete(`/api/customers/${awa.id}`);
    expect(removed.body.data.mode).toBe("archived");
    expect((await prisma.vente.findUniqueOrThrow({ where: { id: sale.id } })).clientId).toBe(awa.id);

    const list = await request(app).get("/api/customers");
    expect(list.body.data.map((item: { id: number }) => item.id)).not.toContain(awa.id);
    const archived = await request(app).get("/api/customers?archives=true");
    expect(archived.body.data.map((item: { id: number }) => item.id)).toContain(awa.id);

    const newSale = await postSale({ lignes: [{ produitId: produit.id, quantite: 1 }], modePaiement: "CREDIT", clientId: awa.id, montantPaye: 0 });
    expect(newSale.status).toBe(404);

    await request(app).post(`/api/customers/${awa.id}/restore`).expect(200);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: awa.id } })).archive).toBe(false);
  });

  it("un client sans aucune opération est supprimé définitivement", async () => {
    const shop = await createShop();
    const fresh = await prisma.client.create({ data: { organisationId: shop.organisation.id, nom: "Nouveau" } });
    await as(shop, Role.OWNER);
    expect((await request(app).delete(`/api/customers/${fresh.id}`)).body.data.mode).toBe("deleted");
    expect(await prisma.client.findUnique({ where: { id: fresh.id } })).toBeNull();
  });

  it("la base elle-même interdit de supprimer un client ou un fournisseur ayant un historique", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 1_000 });
    const awa = await prisma.client.create({ data: { organisationId: shop.organisation.id, nom: "Awa" } });
    await createSale(shop.context, shop.boutique.id, { lignes: [{ produitId: produit.id, quantite: 1 }], modePaiement: "CASH", clientId: awa.id, remise: 0 }, testKey());
    const fournisseur = await prisma.fournisseur.create({ data: { organisationId: shop.organisation.id, nom: "Grossiste" } });
    await createPurchase(shop.context, shop.boutique.id, { lignes: [{ produitId: produit.id, quantite: 1, coutUnitaire: 500 }], fournisseurId: fournisseur.id, montantPaye: 0 });

    await expect(prisma.client.delete({ where: { id: awa.id } })).rejects.toMatchObject({ code: "P2003" });
    await expect(prisma.fournisseur.delete({ where: { id: fournisseur.id } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("un fournisseur à qui l'on doit de l'argent est archivé et ne sert plus aux nouveaux achats", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 1_000 });
    const fournisseur = await prisma.fournisseur.create({ data: { organisationId: shop.organisation.id, nom: "Grossiste" } });
    await createPurchase(shop.context, shop.boutique.id, { lignes: [{ produitId: produit.id, quantite: 2, coutUnitaire: 500 }], fournisseurId: fournisseur.id, montantPaye: 0 });

    await as(shop, Role.STOCK_MANAGER);
    expect((await request(app).delete(`/api/suppliers/${fournisseur.id}`)).status).toBe(403);
    await as(shop, Role.OWNER);
    expect((await request(app).delete(`/api/suppliers/${fournisseur.id}`)).body.data.mode).toBe("archived");
    const purchase = await request(app).post("/api/purchases").set("Idempotency-Key", testKey()).send({ lignes: [{ produitId: produit.id, quantite: 1, coutUnitaire: 500 }], fournisseurId: fournisseur.id });
    expect(purchase.status).toBe(404);
  });
});

/** Champs qui ne doivent jamais apparaître (non nuls) dans une réponse destinée à un vendeur. */
const COST_FIELDS = new Set([
  "coutUnitaire",
  "prixAchat",
  "coutTotal",
  "costOfSales",
  "returnsCost",
  "costOfGoodsSold",
  "grossMargin",
  "grossMarginRate",
  "netProfit",
  "expensesTotal",
  "storeExpenses",
  "generalExpenses",
  "lossesTotal",
  "stockLosses",
  "returnLosses",
  "inventoryShortfall",
  "inventorySurplus",
]);

function exposedCosts(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => exposedCosts(item, `${path}[${index}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => [
      ...(COST_FIELDS.has(key) && child !== null && child !== undefined ? [`${path}.${key}`] : []),
      ...exposedCosts(child, `${path}.${key}`),
    ]);
  }
  return [];
}

describe("coûts d'achat jamais exposés à un vendeur (F-04)", () => {
  it("parcourt toutes les réponses lisibles par un vendeur, y compris celles d'écriture", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 600, prixVente: 1_000, stock: 20 });
    const awa = await prisma.client.create({ data: { organisationId: shop.organisation.id, nom: "Awa" } });
    await prisma.depense.create({ data: { organisationId: shop.organisation.id, boutiqueId: shop.boutique.id, categorie: "Loyer", libelle: "Loyer", montant: 5_000, creeParId: shop.context.userId } });
    await as(shop, Role.SELLER);

    const created = await postSale({ lignes: [{ produitId: produit.id, quantite: 2 }], modePaiement: "CREDIT", clientId: awa.id, montantPaye: 500 });
    expect(created.status).toBe(201);
    const saleId = created.body.data.id as number;
    const paid = await request(app).post(`/api/sales/${saleId}/payments`).set("Idempotency-Key", testKey()).send({ montant: 100, modePaiement: "CASH" });
    expect(paid.status).toBe(201);
    const quote = await request(app).post("/api/quotes").send({ lignes: [{ produitId: produit.id, quantite: 1 }], remise: 0 });

    const responses: [string, unknown][] = [
      ["POST /api/sales", created.body],
      ["POST /api/sales/:id/payments", paid.body],
      ["POST /api/quotes", quote.body],
    ];
    for (const path of [
      "/api/sales",
      `/api/sales/${saleId}`,
      "/api/sales/stats?periode=month",
      "/api/dashboard",
      "/api/products",
      `/api/products/${produit.id}`,
      "/api/stock",
      "/api/quotes",
      `/api/quotes/${quote.body.data.id}`,
      "/api/customers",
      "/api/me",
      "/api/pages/dashboard",
      "/api/pages/ventes",
      "/api/pages/ventes/nouvelle",
      "/api/pages/creances",
      "/api/pages/produits",
      "/api/pages/stock",
      "/api/pages/devis",
      "/api/pages/clients",
    ]) {
      const response = await request(app).get(path);
      expect(response.status, path).toBe(200);
      responses.push([`GET ${path}`, response.body]);
    }

    const leaks = responses.flatMap(([label, body]) => exposedCosts(body).map((field) => `${label} → ${field}`));
    expect(leaks).toEqual([]);

    // Les écrans qui ne montrent que des coûts sont fermés au vendeur.
    for (const path of ["/api/stock/movements", "/api/stock/valuation", "/api/stock/alerts", "/api/purchases", "/api/inventories", "/api/losses", "/api/expenses"]) {
      expect((await request(app).get(path)).status, path).toBe(403);
    }
  });
});
