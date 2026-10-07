import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createPurchase } from "@/lib/services/purchase";
import { adjustStock } from "@/lib/services/stock";
import { createProduct, updateProduct } from "@/lib/services/product";
import { StockMovementType } from "@/generated/prisma/enums";
import { createProduit, createShop, resetDatabase, stockOf } from "./helpers/factories";

beforeEach(resetDatabase);

describe("createPurchase — réception fournisseur", () => {
  it("augmente le stock, calcule le total et trace un mouvement par ligne", async () => {
    const shop = await createShop();
    const riz = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 4 });
    const huile = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 0 });
    const fournisseur = await prisma.fournisseur.create({ data: { organisationId: shop.organisation.id, nom: "Grossiste" } });

    const purchase = await createPurchase(shop.context, shop.boutique.id, {
      lignes: [
        { produitId: riz.id, quantite: 10, coutUnitaire: 550 },
        { produitId: huile.id, quantite: 6, coutUnitaire: 1100.5 },
      ],
      fournisseurId: fournisseur.id,
    });

    // 10 × 550 + 6 × 1100,50 = 12 103
    expect(Number(purchase.total)).toBe(12103);
    expect(purchase.creeParId).toBe(shop.context.userId);
    expect(purchase.fournisseur?.id).toBe(fournisseur.id);
    expect(await stockOf(shop.boutique.id, riz.id)).toBe(14);
    expect(await stockOf(shop.boutique.id, huile.id)).toBe(6);

    const mouvements = await prisma.mouvementStock.findMany({ where: { achatId: purchase.id } });
    expect(mouvements).toHaveLength(2);
    expect(mouvements.every((m) => m.type === StockMovementType.PURCHASE)).toBe(true);
  });

  it("crée la ligne de stock si le produit n'en avait pas dans cette boutique", async () => {
    const shop = await createShop();
    const produit = await prisma.produit.create({
      data: { organisationId: shop.organisation.id, nom: "Sans stock", prixAchat: 100, prixVente: 150 },
    });

    await createPurchase(shop.context, shop.boutique.id, {
      lignes: [{ produitId: produit.id, quantite: 5, coutUnitaire: 100 }],
    });

    expect(await stockOf(shop.boutique.id, produit.id)).toBe(5);
  });

  it("refuse un produit ou un fournisseur d'une autre organisation", async () => {
    const shop = await createShop("A");
    const other = await createShop("B");
    const produit = await createProduit(shop.organisation.id, shop.boutique.id);
    const produitAutre = await createProduit(other.organisation.id, other.boutique.id, { stock: 3 });
    const fournisseurAutre = await prisma.fournisseur.create({ data: { organisationId: other.organisation.id, nom: "F" } });

    await expect(
      createPurchase(shop.context, shop.boutique.id, { lignes: [{ produitId: produitAutre.id, quantite: 1, coutUnitaire: 1 }] }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      createPurchase(shop.context, shop.boutique.id, {
        lignes: [{ produitId: produit.id, quantite: 1, coutUnitaire: 1 }],
        fournisseurId: fournisseurAutre.id,
      }),
    ).rejects.toMatchObject({ status: 404 });

    expect(await stockOf(other.boutique.id, produitAutre.id)).toBe(3);
    expect(await prisma.achat.count()).toBe(0);
  });
});

describe("adjustStock — correction manuelle", () => {
  it("applique l'ajustement et le trace dans l'historique", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 10 });

    const stock = await adjustStock(shop.context, shop.boutique.id, produit.id, { variationQuantite: -3, note: "Casse" });

    expect(stock.quantite).toBe(7);
    const mouvement = await prisma.mouvementStock.findFirstOrThrow({ where: { produitId: produit.id } });
    expect(mouvement).toMatchObject({ type: StockMovementType.ADJUSTMENT, variationQuantite: -3, note: "Casse" });
  });

  it("refuse de faire passer le stock sous zéro", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 2 });

    await expect(
      adjustStock(shop.context, shop.boutique.id, produit.id, { variationQuantite: -3 }),
    ).rejects.toMatchObject({ status: 409 });

    expect(await stockOf(shop.boutique.id, produit.id)).toBe(2);
    expect(await prisma.mouvementStock.count()).toBe(0);
  });

  it("refuse un produit ou une boutique d'une autre organisation", async () => {
    const shop = await createShop("A");
    const other = await createShop("B");
    const produit = await createProduit(shop.organisation.id, shop.boutique.id);
    const produitAutre = await createProduit(other.organisation.id, other.boutique.id, { stock: 5 });

    await expect(
      adjustStock(shop.context, shop.boutique.id, produitAutre.id, { variationQuantite: 1 }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      adjustStock(shop.context, other.boutique.id, produit.id, { variationQuantite: 1 }),
    ).rejects.toMatchObject({ status: 403 });

    expect(await stockOf(other.boutique.id, produitAutre.id)).toBe(5);
  });
});

describe("createProduct / updateProduct — catalogue", () => {
  it("crée une ligne de stock dans chaque boutique et le stock initial dans la boutique choisie", async () => {
    const shop = await createShop();
    const annexe = await prisma.boutique.create({ data: { organisationId: shop.organisation.id, nom: "Annexe" } });

    const produit = await createProduct(shop.context, shop.boutique.id, {
      nom: "Thé vert",
      unite: "boîte",
      prixAchat: 400,
      prixVente: 650,
      seuilAlerte: 3,
      quantiteInitiale: 12,
    });

    expect(await stockOf(shop.boutique.id, produit.id)).toBe(12);
    expect(await stockOf(annexe.id, produit.id)).toBe(0);
    expect(await prisma.stock.count({ where: { produitId: produit.id } })).toBe(2);

    const initial = await prisma.mouvementStock.findFirstOrThrow({ where: { produitId: produit.id } });
    expect(initial).toMatchObject({ type: StockMovementType.INITIAL, variationQuantite: 12, boutiqueId: shop.boutique.id });
  });

  it("ne crée pas de mouvement quand le stock initial est nul", async () => {
    const shop = await createShop();
    await createProduct(shop.context, shop.boutique.id, {
      nom: "Vide",
      unite: "pièce",
      prixAchat: 1,
      prixVente: 2,
      seuilAlerte: 0,
    });
    expect(await prisma.mouvementStock.count()).toBe(0);
  });

  it("refuse une catégorie ou une boutique d'une autre organisation", async () => {
    const shop = await createShop("A");
    const other = await createShop("B");
    const categorieAutre = await prisma.categorie.create({ data: { organisationId: other.organisation.id, nom: "Autre" } });
    const base = { nom: "X", unite: "pièce", prixAchat: 1, prixVente: 2, seuilAlerte: 0 };

    await expect(
      createProduct(shop.context, shop.boutique.id, { ...base, categorieId: categorieAutre.id }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(createProduct(shop.context, other.boutique.id, base)).rejects.toMatchObject({ status: 403 });
    expect(await prisma.produit.count()).toBe(0);
  });

  it("ne permet pas de modifier le produit d'une autre organisation", async () => {
    const shop = await createShop("A");
    const other = await createShop("B");
    const produitAutre = await createProduit(other.organisation.id, other.boutique.id, { nom: "Original" });

    await expect(
      updateProduct(shop.context, produitAutre.id, { nom: "Piraté", unite: "pièce", prixAchat: 1, prixVente: 2, seuilAlerte: 0 }),
    ).rejects.toMatchObject({ status: 404 });

    const unchanged = await prisma.produit.findUniqueOrThrow({ where: { id: produitAutre.id } });
    expect(unchanged.nom).toBe("Original");
  });
});
