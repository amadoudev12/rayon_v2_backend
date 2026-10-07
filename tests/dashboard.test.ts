import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createSale, cancelSale } from "@/lib/services/sale";
import { getDashboardStats } from "@/lib/services/dashboard";
import { createProduit, createShop, resetDatabase } from "./helpers/factories";

beforeEach(resetDatabase);

/** Début du mois courant et date située à coup sûr dans la « même période » du mois précédent. */
function periods() {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfPreviousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const elapsed = now.getTime() - startOfMonth.getTime();
  return { insidePreviousPeriod: new Date(startOfPreviousMonth.getTime() + elapsed / 2) };
}

async function sell(shop: Awaited<ReturnType<typeof createShop>>, produitId: number, quantite: number, remise = 0) {
  return createSale(shop.context, shop.boutique.id, {
    lignes: [{ produitId, quantite }],
    modePaiement: "CASH",
    remise,
  });
}

describe("getDashboardStats — chiffres du tableau de bord", () => {
  it("calcule CA, marge (remises déduites) et bénéfice net en ignorant les ventes annulées", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 600, prixVente: 1000, stock: 50 });

    await sell(shop, produit.id, 3, 500); // CA 2 500, coût 1 800
    await sell(shop, produit.id, 2); // CA 2 000, coût 1 200
    const annulee = await sell(shop, produit.id, 10); // annulée : ne compte nulle part
    await cancelSale(shop.context, annulee.id);

    const stats = await getDashboardStats(shop.context, shop.boutique.id);

    expect(stats.revenue).toBe(4500);
    expect(stats.salesCount).toBe(2);
    expect(stats.averageBasket).toBe(2250);
    expect(stats.costOfGoodsSold).toBe(3000);
    expect(stats.grossMargin).toBe(1500); // et non 2 000 : la remise de 500 est bien déduite
    expect(stats.grossMarginRate).toBeCloseTo(33.33, 1);
    expect(stats.todayRevenue).toBe(4500);
    expect(stats.todaySalesCount).toBe(2);
    expect(stats.netProfit).toBe(1500); // aucune dépense
  });

  it("compte les dépenses de la boutique et les charges générales, pas celles des autres boutiques", async () => {
    const shop = await createShop();
    const annexe = await prisma.boutique.create({ data: { organisationId: shop.organisation.id, nom: "Annexe" } });
    const other = await createShop("Autre organisation");
    const depense = (organisationId: number, boutiqueId: number | null, montant: number, creeParId: number) =>
      prisma.depense.create({ data: { organisationId, boutiqueId, montant, categorie: "Autre", libelle: "Test", creeParId } });

    await depense(shop.organisation.id, shop.boutique.id, 3000, shop.context.userId); // boutique affichée
    await depense(shop.organisation.id, null, 7000, shop.context.userId); // charge générale
    await depense(shop.organisation.id, annexe.id, 50_000, shop.context.userId); // autre boutique
    await depense(other.organisation.id, null, 99_000, other.context.userId); // autre organisation

    const stats = await getDashboardStats(shop.context, shop.boutique.id);

    expect(stats.expensesTotal).toBe(10_000);
    expect(stats.netProfit).toBe(-10_000);
  });

  it("compte toutes les alertes de stock, même au-delà des 8 affichées", async () => {
    const shop = await createShop();
    for (let i = 0; i < 11; i++) {
      // 6 ruptures (stock 0) et 5 stocks faibles (stock 2, seuil 5)
      await createProduit(shop.organisation.id, shop.boutique.id, { stock: i < 6 ? 0 : 2, seuilAlerte: 5 });
    }
    await createProduit(shop.organisation.id, shop.boutique.id, { stock: 40, seuilAlerte: 5 }); // stock suffisant
    await createProduit(shop.organisation.id, shop.boutique.id, { stock: 0, actif: false }); // archivé : ignoré

    const stats = await getDashboardStats(shop.context, shop.boutique.id);

    expect(stats.lowStockCount).toBe(11);
    expect(stats.outOfStockCount).toBe(6);
    expect(stats.lowStock).toHaveLength(8);
    expect(stats.lowStock[0].quantity).toBe(0); // les ruptures d'abord
    expect(stats.activeProductsCount).toBe(12);
  });

  it("compare le CA à la même période du mois précédent", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 1000, stock: 50 });
    await sell(shop, produit.id, 3); // 3 000 ce mois-ci

    const ancienne = await sell(shop, produit.id, 2); // 2 000, déplacée au mois précédent
    await prisma.vente.update({ where: { id: ancienne.id }, data: { creeLe: periods().insidePreviousPeriod } });

    const stats = await getDashboardStats(shop.context, shop.boutique.id);

    expect(stats.revenue).toBe(3000);
    expect(stats.previousRevenue).toBe(2000);
    expect(stats.revenueChange).toBeCloseTo(50, 5);
  });

  it("classe les meilleures ventes du mois par quantité", async () => {
    const shop = await createShop();
    const riz = await createProduit(shop.organisation.id, shop.boutique.id, { nom: "Riz", stock: 50 });
    const eau = await createProduit(shop.organisation.id, shop.boutique.id, { nom: "Eau", prixVente: 400, stock: 50 });
    await sell(shop, riz.id, 2);
    await sell(shop, eau.id, 9);
    await sell(shop, riz.id, 1);

    const stats = await getDashboardStats(shop.context, shop.boutique.id);

    expect(stats.topProducts.map((p) => [p.productName, p.quantity])).toEqual([
      ["Eau", 9],
      ["Riz", 3],
    ]);
  });

  it("n'affiche jamais les données d'une autre organisation", async () => {
    const shop = await createShop("A");
    const other = await createShop("B");
    const produitAutre = await createProduit(other.organisation.id, other.boutique.id, { stock: 0 });
    await prisma.stock.update({
      where: { boutiqueId_produitId: { boutiqueId: other.boutique.id, produitId: produitAutre.id } },
      data: { quantite: 50 },
    });
    await sell(other, produitAutre.id, 5);

    const stats = await getDashboardStats(shop.context, shop.boutique.id);

    expect(stats.revenue).toBe(0);
    expect(stats.salesCount).toBe(0);
    expect(stats.lowStockCount).toBe(0);
    expect(stats.recentActivity).toHaveLength(0);
    expect(stats.activeProductsCount).toBe(0);
  });
});
