/**
 * Phase 3 : inventaires à grande échelle et sans chevauchement (F-07, F-12),
 * pertes déjà absorbées par un inventaire (F-13), achats idempotents avec
 * paiements et annulation (F-08), produits (F-11, F-20) et contraintes SQL (F-19).
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
import { PurchaseStatus, Role, StockMovementType } from "@/generated/prisma/enums";
import { createApp } from "@/app";
import { createSale } from "@/services/sale";
import { cancelLoss, createLoss } from "@/services/loss";
import { countInventoryLine, createInventory, validateInventory } from "@/services/inventory";
import { addSupplierPayment, cancelPurchase, createPurchase } from "@/services/purchase";
import { updateProduct } from "@/services/product";
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

type Shop = Awaited<ReturnType<typeof createShop>>;

async function countAll(shop: Shop, inventoryId: number, quantityOf: (produitId: number) => number) {
  const lines = await prisma.ligneInventaire.findMany({ where: { inventaireId: inventoryId } });
  for (const line of lines) await countInventoryLine(shop.context, inventoryId, line.id, { quantiteComptee: quantityOf(line.produitId), version: line.version });
}

describe("inventaires (F-07, F-12)", () => {
  it("valide un inventaire de 3 000 produits en un nombre fixe de requêtes, ventes pendant le comptage comprises", async () => {
    const shop = await createShop();
    const count = 3_000;
    const products = await prisma.produit.createManyAndReturn({
      data: Array.from({ length: count }, (_, index) => ({ organisationId: shop.organisation.id, nom: `P${index}`, prixAchat: 100, prixVente: 200 })),
      select: { id: true },
    });
    await prisma.stock.createMany({ data: products.map((product) => ({ boutiqueId: shop.boutique.id, produitId: product.id, quantite: 10 })) });

    const inventory = await createInventory(shop.context, { boutiqueId: shop.boutique.id, libelle: "Annuel", selectionType: "ALL" });
    expect(inventory.lignes).toHaveLength(count);

    // Comptage direct en base (le comptage ligne à ligne est testé ailleurs) : il manque 1 article partout.
    await prisma.ligneInventaire.updateMany({ where: { inventaireId: inventory.id }, data: { quantiteComptee: 9, compteLe: new Date(Date.now() - 60_000) } });
    // Une vente après le comptage : elle doit être conservée par la validation.
    await createSale(shop.context, shop.boutique.id, { lignes: [{ produitId: products[0]!.id, quantite: 2 }], modePaiement: "CASH", remise: 0 }, testKey());

    const started = Date.now();
    await validateInventory(shop.context, inventory.id);
    const elapsed = Date.now() - started;

    expect(await stockOf(shop.boutique.id, products[0]!.id)).toBe(7); // compté 9, puis 2 vendus
    expect(await stockOf(shop.boutique.id, products[1]!.id)).toBe(9);
    const adjustments = await prisma.mouvementStock.count({ where: { type: StockMovementType.INVENTORY_ADJUSTMENT } });
    expect(adjustments).toBe(count);
    const shortfall = await prisma.mouvementStock.aggregate({ where: { type: StockMovementType.INVENTORY_ADJUSTMENT }, _sum: { variationQuantite: true } });
    expect(shortfall._sum.variationQuantite).toBe(-count);
    expect(elapsed).toBeLessThan(30_000);
  }, 120_000);

  it("refuse un second inventaire en cours sur les mêmes produits, accepte des produits distincts", async () => {
    const shop = await createShop();
    const a = await createProduit(shop.organisation.id, shop.boutique.id);
    const b = await createProduit(shop.organisation.id, shop.boutique.id);
    await createInventory(shop.context, { boutiqueId: shop.boutique.id, libelle: "Rayon A", selectionType: "MANUAL", produitIds: [a.id] });

    await expect(
      createInventory(shop.context, { boutiqueId: shop.boutique.id, libelle: "Tout", selectionType: "ALL" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      createInventory(shop.context, { boutiqueId: shop.boutique.id, libelle: "Rayon B", selectionType: "MANUAL", produitIds: [b.id] }),
    ).resolves.toMatchObject({ libelle: "Rayon B" });
  });

  it("deux créations simultanées sur les mêmes produits : une seule réussit", async () => {
    const shop = await createShop();
    await createProduit(shop.organisation.id, shop.boutique.id);
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, (_, index) => createInventory(shop.context, { boutiqueId: shop.boutique.id, libelle: `Inv ${index}`, selectionType: "ALL" })),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  it("deux validations simultanées : le stock n'est corrigé qu'une fois", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 10 });
    const inventory = await createInventory(shop.context, { boutiqueId: shop.boutique.id, libelle: "Inv", selectionType: "ALL" });
    await countAll(shop, inventory.id, () => 6);

    const results = await Promise.allSettled([validateInventory(shop.context, inventory.id), validateInventory(shop.context, inventory.id)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(6);
    expect(await prisma.mouvementStock.count({ where: { type: StockMovementType.INVENTORY_ADJUSTMENT } })).toBe(1);
  });
});

describe("pertes et inventaires (F-13)", () => {
  it("refuse d'annuler une perte déjà absorbée par un inventaire validé, l'accepte avant", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 10 });
    const early = await createLoss(shop.context, { boutiqueId: shop.boutique.id, produitId: produit.id, quantite: 1, motif: "CASSE" }, testKey());
    await cancelLoss(shop.context, early.id, "Erreur de saisie"); // aucun inventaire : accepté
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(10);

    const loss = await createLoss(shop.context, { boutiqueId: shop.boutique.id, produitId: produit.id, quantite: 2, motif: "VOL" }, testKey());
    const inventory = await createInventory(shop.context, { boutiqueId: shop.boutique.id, libelle: "Inv", selectionType: "ALL" });
    await countAll(shop, inventory.id, () => 8);
    await validateInventory(shop.context, inventory.id);

    await expect(cancelLoss(shop.context, loss.id, "Retrouvé")).rejects.toMatchObject({ status: 409 });
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(8); // pas de stock fantôme
  });
});

describe("achats (F-08)", () => {
  it("rejouer la création avec la même clé ne double ni le stock ni la dette", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 0 });
    const input = { lignes: [{ produitId: produit.id, quantite: 5, coutUnitaire: 400 }], montantPaye: 500 };
    const key = testKey("purchase");

    const first = await createPurchase(shop.context, shop.boutique.id, input, key);
    const replay = await createPurchase(shop.context, shop.boutique.id, input, key);
    expect(replay.id).toBe(first.id);
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(5);
    expect(await prisma.achat.count()).toBe(1);
    await expect(createPurchase(shop.context, shop.boutique.id, { ...input, montantPaye: 0 }, key)).rejects.toMatchObject({ status: 409 });
    expect(Number(first.resteAPayer)).toBe(1_500);
    expect(first.paiements).toHaveLength(1);
  });

  it("règlements fournisseur : historique, solde, refus au-delà du dû, idempotence", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id);
    const purchase = await createPurchase(shop.context, shop.boutique.id, { lignes: [{ produitId: produit.id, quantite: 10, coutUnitaire: 1_000 }], montantPaye: 2_000 }, testKey());
    const key = testKey("supplier-pay");

    await addSupplierPayment(shop.context, purchase.id, 3_000, "MOBILE_MONEY", key);
    const replay = await addSupplierPayment(shop.context, purchase.id, 3_000, "MOBILE_MONEY", key);
    expect(replay.paiements).toHaveLength(2);
    expect(Number(replay.resteAPayer)).toBe(5_000); // 10 000 − 2 000 − 3 000
    await expect(addSupplierPayment(shop.context, purchase.id, 5_001, "CASH", testKey())).rejects.toMatchObject({ status: 409 });
    const settled = await addSupplierPayment(shop.context, purchase.id, 5_000, "CASH", testKey());
    expect(Number(settled.resteAPayer)).toBe(0);
    expect(Number(settled.montantPaye)).toBe(10_000);
  });

  it("annulation : contre-mouvements, dette à 0, paiements conservés ; refusée si des articles ont été vendus", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 0, prixVente: 2_000 });
    const sold = await createPurchase(shop.context, shop.boutique.id, { lignes: [{ produitId: produit.id, quantite: 3, coutUnitaire: 1_000 }], montantPaye: 0 }, testKey());
    await createSale(shop.context, shop.boutique.id, { lignes: [{ produitId: produit.id, quantite: 2 }], modePaiement: "CASH", remise: 0 }, testKey());
    await expect(cancelPurchase(shop.context, sold.id, "Erreur", testKey())).rejects.toMatchObject({ status: 409 });
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(1); // rien n'a bougé

    const wrong = await createPurchase(shop.context, shop.boutique.id, { lignes: [{ produitId: produit.id, quantite: 4, coutUnitaire: 1_000 }], montantPaye: 1_000 }, testKey());
    const key = testKey("cancel-purchase");
    const cancelled = await cancelPurchase(shop.context, wrong.id, "Livraison saisie deux fois", key);
    expect(cancelled.statut).toBe(PurchaseStatus.CANCELLED);
    expect(Number(cancelled.resteAPayer)).toBe(0);
    expect(cancelled.paiements).toHaveLength(1); // 1 000 versés : à récupérer auprès du fournisseur
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(1);
    const counter = await prisma.mouvementStock.findFirstOrThrow({ where: { type: StockMovementType.PURCHASE_CANCELLATION } });
    expect(counter).toMatchObject({ variationQuantite: -4, quantiteAvant: 5, quantiteApres: 1, achatId: wrong.id });

    await cancelPurchase(shop.context, wrong.id, "Livraison saisie deux fois", key); // rejeu : sans effet
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(1);
    await expect(addSupplierPayment(shop.context, wrong.id, 100, "CASH", testKey())).rejects.toMatchObject({ status: 409 });
  });

  it("API : clé obligatoire, annulation réservée aux responsables", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id);
    const stockManager = await createMember(shop.organisation.id, Role.STOCK_MANAGER);
    signIn(stockManager.utilisateur.id, shop.organisation.id, Role.STOCK_MANAGER);
    const body = { lignes: [{ produitId: produit.id, quantite: 1, coutUnitaire: 100 }] };

    expect((await request(app).post("/api/purchases").send(body)).status).toBe(400);
    const created = await request(app).post("/api/purchases").set("Idempotency-Key", testKey()).send(body);
    expect(created.status).toBe(201);
    expect(created.body.data.cleIdempotence).toBeUndefined();
    const cancel = await request(app).post(`/api/purchases/${created.body.data.id}/cancel`).set("Idempotency-Key", testKey()).send({ motif: "Erreur" });
    expect(cancel.status).toBe(403);
    const duplicate = await request(app)
      .post("/api/purchases")
      .set("Idempotency-Key", testKey())
      .send({ lignes: [body.lignes[0], body.lignes[0]] });
    expect(duplicate.status).toBe(400);
  });
});

describe("produits (F-11, F-20)", () => {
  it("une modification partielle ne réactive pas un produit archivé et garde sa catégorie", async () => {
    const shop = await createShop();
    const category = await prisma.categorie.create({ data: { organisationId: shop.organisation.id, nom: "Boissons" } });
    const produit = await prisma.produit.create({
      data: { organisationId: shop.organisation.id, nom: "Jus", prixAchat: 100, prixVente: 200, actif: false, categorieId: category.id },
    });
    const updated = await updateProduct(shop.context, produit.id, { prixVente: 250 });
    expect(updated).toMatchObject({ actif: false, categorieId: category.id });
    expect(Number(updated.prixVente)).toBe(250);
    const cleared = await updateProduct(shop.context, produit.id, { categorieId: null });
    expect(cleared.categorieId).toBeNull();
  });

  it("supprimer un produit vendu l'archive ; l'historique des mouvements est protégé par la base", async () => {
    const shop = await createShop();
    const sold = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 5 });
    await createSale(shop.context, shop.boutique.id, { lignes: [{ produitId: sold.id, quantite: 1 }], modePaiement: "CASH", remise: 0 }, testKey());
    const fresh = await prisma.produit.create({ data: { organisationId: shop.organisation.id, nom: "Neuf", prixAchat: 1, prixVente: 2 } });
    signIn(shop.owner.utilisateur.id, shop.organisation.id, Role.OWNER);

    expect((await request(app).delete(`/api/products/${sold.id}`)).body.data.mode).toBe("archived");
    expect((await prisma.produit.findUniqueOrThrow({ where: { id: sold.id } })).actif).toBe(false);
    expect((await request(app).delete(`/api/products/${fresh.id}`)).body.data.mode).toBe("deleted");

    const withMovementOnly = await prisma.produit.create({ data: { organisationId: shop.organisation.id, nom: "Ajusté", prixAchat: 1, prixVente: 2 } });
    await prisma.mouvementStock.create({ data: { boutiqueId: shop.boutique.id, produitId: withMovementOnly.id, utilisateurId: shop.context.userId, type: "ADJUSTMENT", variationQuantite: 1 } });
    await expect(prisma.produit.delete({ where: { id: withMovementOnly.id } })).rejects.toMatchObject({ code: "P2003" });
  });
});

describe("contraintes d'intégrité en base (F-19)", () => {
  it("la base refuse un stock négatif, un retour supérieur au vendu, un paiement nul ou un trop-payé fournisseur", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 2 });
    const sale = await createSale(shop.context, shop.boutique.id, { lignes: [{ produitId: produit.id, quantite: 1 }], modePaiement: "CASH", remise: 0 }, testKey());
    const purchase = await createPurchase(shop.context, shop.boutique.id, { lignes: [{ produitId: produit.id, quantite: 1, coutUnitaire: 100 }] }, testKey());

    const violations = [
      prisma.$executeRaw`UPDATE "Stock" SET "quantite" = -1 WHERE "produitId" = ${produit.id}`,
      prisma.$executeRaw`UPDATE "LigneVente" SET "quantiteRetournee" = 2 WHERE "venteId" = ${sale.id}`,
      prisma.$executeRaw`INSERT INTO "PaiementVente" ("montant", "venteId") VALUES (0, ${sale.id})`,
      prisma.$executeRaw`UPDATE "Vente" SET "resteAPayer" = -5 WHERE "id" = ${sale.id}`,
      prisma.$executeRaw`UPDATE "Achat" SET "montantPaye" = "total" + 1 WHERE "id" = ${purchase.id}`,
      prisma.$executeRaw`UPDATE "Organisation" SET "remiseMaxVendeurPct" = 150 WHERE "id" = ${shop.organisation.id}`,
    ];
    for (const attempt of violations) {
      await expect(attempt).rejects.toThrow(/check constraint|23514/i);
    }
  });
});
