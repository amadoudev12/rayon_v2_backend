/**
 * Isolation multi-tenant par manipulation directe des requêtes HTTP : un
 * membre d'une organisation B (ou d'une autre boutique de A) vise par
 * identifiant chaque ressource de A. Aucune ne doit être lue, modifiée,
 * annulée ni supprimée, et aucune liste ne doit en contenir.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
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
import { createQuote } from "@/services/quote";
import { createLoss } from "@/services/loss";
import { createInventory } from "@/services/inventory";
import { cancel, createMember, createProduit, createShop, resetDatabase, testKey } from "./helpers/factories";

const app = createApp();

function signIn(userId: number, organizationId: number, role: Role) {
  sessionMock.current = {
    expires: new Date(Date.now() + 3600_000).toISOString(),
    user: { id: userId, name: "Test", tenant: { organizationId, role, storeId: null, organizationName: "Org" } },
  };
}

type Fixture = Awaited<ReturnType<typeof buildOrganization>>;

/** Une organisation complète : 2 boutiques et une ressource de chaque type. */
async function buildOrganization(name: string) {
  const shop = await createShop(name);
  const annexe = await prisma.boutique.create({ data: { organisationId: shop.organisation.id, nom: `${name} annexe` } });
  const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 500, prixVente: 1_000, stock: 50 });
  await prisma.stock.create({ data: { boutiqueId: annexe.id, produitId: produit.id, quantite: 10 } });
  const categorie = await prisma.categorie.create({ data: { organisationId: shop.organisation.id, nom: `Cat ${name}` } });
  const client = await prisma.client.create({ data: { organisationId: shop.organisation.id, nom: `Client ${name}` } });
  const fournisseur = await prisma.fournisseur.create({ data: { organisationId: shop.organisation.id, nom: `Fournisseur ${name}` } });
  const sale = await createSale(shop.context, shop.boutique.id, { lignes: [{ produitId: produit.id, quantite: 2 }], modePaiement: "CREDIT", clientId: client.id, montantPaye: 500, remise: 0 }, testKey());
  const paidSale = await createSale(shop.context, shop.boutique.id, { lignes: [{ produitId: produit.id, quantite: 1 }], modePaiement: "CASH", remise: 0 }, testKey());
  const cancelled = await cancel(shop.context, paidSale.id);
  const purchase = await createPurchase(shop.context, shop.boutique.id, { lignes: [{ produitId: produit.id, quantite: 3, coutUnitaire: 500 }], fournisseurId: fournisseur.id, montantPaye: 0 });
  const quote = await createQuote(shop.context, shop.boutique.id, { lignes: [{ produitId: produit.id, quantite: 1 }], remise: 0 });
  const expense = await prisma.depense.create({ data: { organisationId: shop.organisation.id, boutiqueId: shop.boutique.id, categorie: "Loyer", libelle: "Loyer", montant: 1_000, creeParId: shop.context.userId } });
  const loss = await createLoss(shop.context, { boutiqueId: shop.boutique.id, produitId: produit.id, quantite: 1, motif: "CASSE" }, testKey());
  const inventory = await createInventory(shop.context, { boutiqueId: shop.boutique.id, libelle: "Inv", selectionType: "ALL" });
  const seller = await createMember(shop.organisation.id, Role.SELLER);
  const annexeManager = await createMember(shop.organisation.id, Role.MANAGER, annexe.id);
  return {
    shop, annexe, produit, categorie, client, fournisseur, sale, purchase, quote, expense, loss, inventory, seller, annexeManager,
    refundId: cancelled.remboursements[0]!.id,
    saleLineId: sale.lignes[0]!.id,
    inventoryLineId: inventory.lignes[0]!.id,
  };
}

let A: Fixture;
let B: Fixture;

beforeAll(async () => {
  await resetDatabase();
  A = await buildOrganization("Alpha");
  B = await buildOrganization("Beta");
});

/** Toutes les tentatives d'un intrus sur les ressources de A. */
function attacksOn(target: Fixture) {
  const key = () => ({ "Idempotency-Key": testKey("attack") });
  return [
    ["GET produit", request(app).get(`/api/products/${target.produit.id}`)],
    ["PUT produit", request(app).put(`/api/products/${target.produit.id}`).send({ nom: "Piraté", unite: "u", prixAchat: 1, prixVente: 2, seuilAlerte: 1 })],
    ["DELETE produit", request(app).delete(`/api/products/${target.produit.id}`)],
    ["Ajustement de stock", request(app).post(`/api/products/${target.produit.id}/stock`).send({ variationQuantite: -5 })],
    ["PUT catégorie", request(app).put(`/api/categories/${target.categorie.id}`).send({ nom: "Piratée" })],
    ["DELETE catégorie", request(app).delete(`/api/categories/${target.categorie.id}`)],
    ["PUT client", request(app).put(`/api/customers/${target.client.id}`).send({ nom: "Piraté" })],
    ["DELETE client", request(app).delete(`/api/customers/${target.client.id}`)],
    ["PUT fournisseur", request(app).put(`/api/suppliers/${target.fournisseur.id}`).send({ nom: "Piraté" })],
    ["DELETE fournisseur", request(app).delete(`/api/suppliers/${target.fournisseur.id}`)],
    ["GET vente", request(app).get(`/api/sales/${target.sale.id}`)],
    ["Paiement sur la vente", request(app).post(`/api/sales/${target.sale.id}/payments`).set(key()).send({ montant: 10, modePaiement: "CASH" })],
    ["Annulation de la vente", request(app).post(`/api/sales/${target.sale.id}/cancel`).set(key()).send({ motif: "Intrusion" })],
    ["Retour sur la vente", request(app).post(`/api/sales/${target.sale.id}/returns`).set(key()).send({ motif: "Intrusion", lignes: [{ ligneVenteId: target.saleLineId, quantite: 1, remiseEnStock: true }] })],
    ["Versement de remboursement", request(app).post(`/api/sales/refunds/${target.refundId}/payouts`).set(key()).send({ montant: 1, modePaiement: "CASH" })],
    ["GET achat", request(app).get(`/api/purchases/${target.purchase.id}`)],
    ["GET devis", request(app).get(`/api/quotes/${target.quote.id}`)],
    ["DELETE devis", request(app).delete(`/api/quotes/${target.quote.id}`)],
    ["DELETE dépense", request(app).delete(`/api/expenses/${target.expense.id}`)],
    ["Annulation de perte", request(app).post(`/api/losses/${target.loss.id}/cancel`).send({ motif: "Intrusion" })],
    ["GET inventaire", request(app).get(`/api/inventories/${target.inventory.id}`)],
    ["Comptage d'inventaire", request(app).put(`/api/inventories/${target.inventory.id}/lines/${target.inventoryLineId}/count`).send({ quantiteComptee: 0, version: 0 })],
    ["Validation d'inventaire", request(app).post(`/api/inventories/${target.inventory.id}/validate`).send({})],
    ["Retrait d'un membre", request(app).delete(`/api/members/${target.seller.membre.id}`)],
    ["Réinitialisation de mot de passe", request(app).post(`/api/members/${target.seller.membre.id}/reset-password`).send({ motDePasseTemporaire: "Pirate123" })],
    ["Liste des produits d'une boutique étrangère", request(app).get(`/api/products?storeId=${target.shop.boutique.id}`)],
    ["Ventes d'une boutique étrangère", request(app).get(`/api/sales?storeId=${target.shop.boutique.id}`)],
    ["Statistiques d'une boutique étrangère", request(app).get(`/api/sales/stats?storeId=${target.shop.boutique.id}`)],
    ["Tableau de bord d'une boutique étrangère", request(app).get(`/api/dashboard?storeId=${target.shop.boutique.id}`)],
    ["Valorisation d'une boutique étrangère", request(app).get(`/api/stock/valuation?storeId=${target.shop.boutique.id}`)],
    ["Vente dans une boutique étrangère", request(app).post("/api/sales").set(key()).send({ boutiqueId: target.shop.boutique.id, modePaiement: "CASH", lignes: [{ produitId: target.produit.id, quantite: 1 }] })],
  ] as const;
}

async function snapshot(target: Fixture) {
  const [sale, stock, product, customer, supplier, refund, loss, inventory, expense, quote, seller] = await Promise.all([
    prisma.vente.findUniqueOrThrow({ where: { id: target.sale.id }, include: { paiements: true, retours: true } }),
    prisma.stock.findMany({ where: { produitId: target.produit.id }, orderBy: { id: "asc" } }),
    prisma.produit.findUniqueOrThrow({ where: { id: target.produit.id } }),
    prisma.client.findUniqueOrThrow({ where: { id: target.client.id } }),
    prisma.fournisseur.findUniqueOrThrow({ where: { id: target.fournisseur.id } }),
    prisma.remboursementVente.findUniqueOrThrow({ where: { id: target.refundId }, include: { versements: true } }),
    prisma.perteStock.findUniqueOrThrow({ where: { id: target.loss.id } }),
    prisma.inventaire.findUniqueOrThrow({ where: { id: target.inventory.id }, include: { lignes: true } }),
    prisma.depense.findUniqueOrThrow({ where: { id: target.expense.id } }),
    prisma.devis.findUnique({ where: { id: target.quote.id } }),
    prisma.utilisateur.findUniqueOrThrow({ where: { id: target.seller.utilisateur.id }, select: { motDePasseHash: true, membre: true } }),
  ]);
  return JSON.stringify({ sale, stock, product, customer, supplier, refund, loss, inventory, expense, quote, seller });
}

describe("isolation entre organisations", () => {
  it("le propriétaire de B ne peut ni lire ni modifier aucune ressource de A", async () => {
    const before = await snapshot(A);
    signIn(B.shop.owner.utilisateur.id, B.shop.organisation.id, Role.OWNER);

    const breaches: string[] = [];
    for (const [label, attempt] of attacksOn(A)) {
      const response = await attempt;
      if (![403, 404].includes(response.status)) breaches.push(`${label} → ${response.status}`);
    }
    expect(breaches).toEqual([]);
    expect(await snapshot(A)).toBe(before);
  });

  it("les listes de B ne contiennent jamais une donnée de A", async () => {
    signIn(B.shop.owner.utilisateur.id, B.shop.organisation.id, Role.OWNER);
    const foreignIds = {
      products: A.produit.id, customers: A.client.id, suppliers: A.fournisseur.id, sales: A.sale.id,
      purchases: A.purchase.id, quotes: A.quote.id, expenses: A.expense.id, losses: A.loss.id, inventories: A.inventory.id, members: A.seller.membre.id, categories: A.categorie.id, stores: A.shop.boutique.id,
    };
    for (const [resource, foreignId] of Object.entries(foreignIds)) {
      const response = await request(app).get(`/api/${resource}${resource === "customers" || resource === "suppliers" ? "?archives=false" : ""}`);
      expect(response.status, resource).toBe(200);
      const ids = (response.body.data as { id: number }[]).map((item) => item.id);
      expect(ids, resource).not.toContain(foreignId);
    }
    const stats = await request(app).get("/api/dashboard");
    expect(stats.body.data.revenue).toBe(2_000); // uniquement la vente à crédit de B (la vente annulée est exclue)
  });
});

describe("isolation entre boutiques d'une même organisation", () => {
  it("un gérant limité à l'annexe n'accède pas aux opérations de la boutique principale", async () => {
    const before = await snapshot(A);
    signIn(A.annexeManager.utilisateur.id, A.shop.organisation.id, Role.MANAGER);

    const storeScoped = [
      ["GET vente", request(app).get(`/api/sales/${A.sale.id}`)],
      ["Annulation", request(app).post(`/api/sales/${A.sale.id}/cancel`).set("Idempotency-Key", testKey()).send({ motif: "Autre boutique" })],
      ["Paiement", request(app).post(`/api/sales/${A.sale.id}/payments`).set("Idempotency-Key", testKey()).send({ montant: 10, modePaiement: "CASH" })],
      ["Versement de remboursement", request(app).post(`/api/sales/refunds/${A.refundId}/payouts`).set("Idempotency-Key", testKey()).send({ montant: 1, modePaiement: "CASH" })],
      ["GET achat", request(app).get(`/api/purchases/${A.purchase.id}`)],
      ["GET devis", request(app).get(`/api/quotes/${A.quote.id}`)],
      ["DELETE devis", request(app).delete(`/api/quotes/${A.quote.id}`)],
      ["DELETE dépense", request(app).delete(`/api/expenses/${A.expense.id}`)],
      ["Annulation de perte", request(app).post(`/api/losses/${A.loss.id}/cancel`).send({ motif: "Autre boutique" })],
      ["GET inventaire", request(app).get(`/api/inventories/${A.inventory.id}`)],
      ["Ventes de la boutique principale", request(app).get(`/api/sales?storeId=${A.shop.boutique.id}`)],
      ["Ajustement de stock principal", request(app).post(`/api/products/${A.produit.id}/stock`).send({ variationQuantite: -1, boutiqueId: A.shop.boutique.id })],
    ] as const;

    const breaches: string[] = [];
    for (const [label, attempt] of storeScoped) {
      const response = await attempt;
      if (![403, 404].includes(response.status)) breaches.push(`${label} → ${response.status}`);
    }
    expect(breaches).toEqual([]);
    expect(await snapshot(A)).toBe(before);

    const ownSales = await request(app).get("/api/sales");
    expect(ownSales.status).toBe(200);
    expect((ownSales.body.data as { id: number }[]).map((sale) => sale.id)).not.toContain(A.sale.id);
  });
});
