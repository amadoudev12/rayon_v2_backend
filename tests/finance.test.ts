/**
 * Exactitude financière (phase 1). Chaque test énonce son calcul manuel : le
 * résultat attendu doit pouvoir être refait sur papier.
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
import { Role, SaleStatus, StockMovementType } from "@/generated/prisma/enums";
import { createApp } from "@/app";
import { createSale, payRefund } from "@/services/sale";
import { createSaleReturn } from "@/services/sale-return";
import { getFinancialSummary } from "@/services/finance";
import { getDashboardStats } from "@/services/dashboard";
import { createLoss } from "@/services/loss";
import { countInventoryLine, createInventory, validateInventory } from "@/services/inventory";
import { parsePeriod } from "@/lib/period";
import { serializeSale } from "@/lib/serializers/sale";
import { cancel, contextFor, createMember, createProduit, createShop, pay, resetDatabase, stockOf, testKey } from "./helpers/factories";

beforeEach(async () => {
  await resetDatabase();
  sessionMock.current = null;
});

type Shop = Awaited<ReturnType<typeof createShop>>;
const today = () => parsePeriod(new URLSearchParams());
const summary = (shop: Shop) => getFinancialSummary({ organisationId: shop.organisation.id, storeId: shop.boutique.id }, today());

async function client(shop: Shop) {
  return prisma.client.create({ data: { organisationId: shop.organisation.id, nom: "Awa Diop" } });
}

function cashSale(shop: Shop, produitId: number, quantite: number, remise = 0) {
  return createSale(shop.context, shop.boutique.id, { lignes: [{ produitId, quantite }], modePaiement: "CASH", remise }, testKey("sale"));
}

function creditSale(shop: Shop, produitId: number, quantite: number, clientId: number, montantPaye: number) {
  return createSale(
    shop.context,
    shop.boutique.id,
    { lignes: [{ produitId, quantite }], modePaiement: "CREDIT", clientId, montantPaye, remise: 0 },
    testKey("sale"),
  );
}

function returnLine(shop: Shop, saleId: number, ligneVenteId: number, quantite: number, remiseEnStock: boolean, immediate?: "CASH" | "MOBILE_MONEY") {
  return createSaleReturn(
    shop.context,
    saleId,
    {
      motif: "Retour client",
      lignes: [{ ligneVenteId, quantite, remiseEnStock }],
      ...(immediate ? { remboursementImmediat: { modePaiement: immediate } } : {}),
    },
    testKey("return"),
  );
}

describe("encaissements après annulation (F-01)", () => {
  it("SCÉNARIO OBLIGATOIRE — 10 000 payés, annulés, remboursés, puis vente de 9 000 : encaissé net = 9 000", async () => {
    const shop = await createShop();
    const produitA = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 6_000, prixVente: 10_000 });
    const produitB = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 5_000, prixVente: 9_000 });

    const sale = await cashSale(shop, produitA.id, 1);
    const cancelled = await cancel(shop.context, sale.id, { motif: "Erreur d'article" });
    await payRefund(shop.context, cancelled.remboursements[0]!.id, 10_000, "CASH", testKey());
    await cashSale(shop, produitB.id, 1);

    // Reçu 10 000 + 9 000 = 19 000 ; rendu 10 000 ; net 9 000. CA = 9 000 (la vente annulée sort).
    const stats = await summary(shop);
    expect(stats).toMatchObject({
      collected: 19_000,
      refunded: 10_000,
      netCollected: 9_000,
      pendingRefund: 0,
      revenue: 9_000,
      salesCount: 1,
    });
    expect(stats.collectedByMethod.CASH).toBe(19_000);
    expect(stats.refundedByMethod.CASH).toBe(10_000);

    // Le tableau de bord (jour et mois) affiche exactement les mêmes montants.
    const dashboard = await getDashboardStats(shop.context, shop.boutique.id, true);
    expect(dashboard.todayCollected).toBe(19_000);
    expect(dashboard.todayRefunded).toBe(10_000);
    expect(dashboard.todayNetCollected).toBe(9_000);
    expect(dashboard.today.revenue).toBe(9_000);
    expect(dashboard.month.netCollected).toBe(9_000);
  });

  it("un remboursement demandé mais non versé n'est pas une sortie d'argent", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 10_000 });
    const sale = await cashSale(shop, produit.id, 1);
    const cancelled = await cancel(shop.context, sale.id);

    expect(serializeSale(cancelled, true).etatFinancier).toBe("REMBOURSEMENT_EN_ATTENTE");
    let stats = await summary(shop);
    expect(stats).toMatchObject({ collected: 10_000, refunded: 0, netCollected: 10_000, pendingRefund: 10_000, pendingRefundCount: 1 });

    await payRefund(shop.context, cancelled.remboursements[0]!.id, 4_000, "CASH", testKey());
    stats = await summary(shop);
    // Versement partiel : 4 000 rendus, 6 000 restent dus.
    expect(stats).toMatchObject({ refunded: 4_000, netCollected: 6_000, pendingRefund: 6_000 });
  });

  it("annulation avec remboursement immédiat : mode tracé, vente soldée", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 5_000 });
    const sale = await cashSale(shop, produit.id, 2);
    const cancelled = await cancel(shop.context, sale.id, { remboursementImmediat: { modePaiement: "MOBILE_MONEY" } });

    expect(cancelled.remboursements).toHaveLength(1);
    expect(cancelled.remboursements[0]!.statut).toBe("COMPLETED");
    expect(cancelled.remboursements[0]!.versements[0]!.modePaiement).toBe("MOBILE_MONEY");
    expect(cancelled.paiements).toHaveLength(1); // le paiement initial reste dans l'historique
    const stats = await summary(shop);
    expect(stats).toMatchObject({ collected: 10_000, refunded: 10_000, netCollected: 0, pendingRefund: 0 });
    expect(stats.refundedByMethod.MOBILE_MONEY).toBe(10_000);
  });

  it("erreur de saisie le jour même : paiement annulé (conservé), aucun faux remboursement, stock rétabli", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 10_000, stock: 5 });
    const sale = await cashSale(shop, produit.id, 2);
    const cancelled = await cancel(shop.context, sale.id, { type: "ENTRY_ERROR", motif: "Mauvais panier saisi" });

    expect(cancelled.typeAnnulation).toBe("ENTRY_ERROR");
    expect(cancelled.remboursements).toHaveLength(0);
    expect(cancelled.paiements).toHaveLength(1);
    expect(cancelled.paiements[0]!.annuleLe).toBeInstanceOf(Date);
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(5);
    expect(await summary(shop)).toMatchObject({ collected: 0, refunded: 0, netCollected: 0, pendingRefund: 0, revenue: 0 });
  });

  it("refuse l'erreur de saisie pour un paiement d'un jour précédent", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 10_000 });
    const sale = await cashSale(shop, produit.id, 1);
    await prisma.paiementVente.updateMany({ where: { venteId: sale.id }, data: { date: new Date(Date.now() - 3 * 86_400_000) } });

    await expect(cancel(shop.context, sale.id, { type: "ENTRY_ERROR" })).rejects.toMatchObject({ status: 409 });
    const stillCompleted = await prisma.vente.findUniqueOrThrow({ where: { id: sale.id } });
    expect(stillCompleted.statut).toBe(SaleStatus.COMPLETED); // rien n'a été appliqué
  });

  it("annulation idempotente : même clé rejouée = même résultat, autre clé = refus", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 1_000, stock: 3 });
    const sale = await cashSale(shop, produit.id, 1);
    const key = testKey("cancel");

    const first = await cancel(shop.context, sale.id, {}, key);
    const replay = await cancel(shop.context, sale.id, {}, key);
    expect(replay.remboursements.map((r) => r.id)).toEqual(first.remboursements.map((r) => r.id));
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(3); // recrédité une seule fois
    await expect(cancel(shop.context, sale.id)).rejects.toMatchObject({ status: 409 });
  });
});

describe("ventes à crédit et paiements partiels", () => {
  it("crédit de 10 000, acompte 4 000, versement 3 000 : reste 3 000, encaissé 7 000", async () => {
    const shop = await createShop();
    const awa = await client(shop);
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 10_000 });
    const sale = await creditSale(shop, produit.id, 1, awa.id, 4_000);
    expect(Number(sale.resteAPayer)).toBe(6_000);

    const paid = await pay(shop.context, sale.id, 3_000, "MOBILE_MONEY");
    expect(Number(paid.resteAPayer)).toBe(3_000);
    expect(Number(paid.montantPaye)).toBe(7_000);

    const stats = await summary(shop);
    expect(stats).toMatchObject({ revenue: 10_000, creditSales: 10_000, collected: 7_000, outstanding: 3_000, outstandingCount: 1 });
    expect(stats.collectedByMethod).toMatchObject({ CASH: 4_000, MOBILE_MONEY: 3_000 });
  });

  it("paiement rejoué avec la même clé : enregistré une seule fois", async () => {
    const shop = await createShop();
    const awa = await client(shop);
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 10_000 });
    const sale = await creditSale(shop, produit.id, 1, awa.id, 0);
    const key = testKey("pay");

    await pay(shop.context, sale.id, 2_500, "CASH", key);
    const replay = await pay(shop.context, sale.id, 2_500, "CASH", key);
    expect(replay.paiements).toHaveLength(1);
    expect(Number(replay.resteAPayer)).toBe(7_500);
    await expect(pay(shop.context, sale.id, 1_000, "CASH", key)).rejects.toMatchObject({ status: 409 });
  });
});

describe("retours de produits (F-02)", () => {
  it("retour revendable sur vente comptant : avoir, remise en stock, remboursement dû, CA et marge corrigés", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 3_000, prixVente: 5_000, stock: 10 });
    const sale = await cashSale(shop, produit.id, 2); // 10 000 payés, coût 6 000

    const returned = await returnLine(shop, sale.id, sale.lignes[0]!.id, 1, true);
    // Avoir 5 000 ; le client avait tout payé : 5 000 lui sont dus.
    expect(Number(returned.montantRetourne)).toBe(5_000);
    expect(Number(returned.resteAPayer)).toBe(0);
    expect(returned.remboursements).toHaveLength(1);
    expect(Number(returned.remboursements[0]!.montant)).toBe(5_000);
    expect(returned.lignes[0]!.quantiteRetournee).toBe(1);
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(9); // 10 − 2 + 1

    let stats = await summary(shop);
    // CA net = 10 000 − 5 000 = 5 000 ; coût net = 6 000 − 3 000 = 3 000 ; marge = 2 000.
    expect(stats).toMatchObject({ grossSales: 10_000, returns: 5_000, revenue: 5_000, costOfGoodsSold: 3_000, grossMargin: 2_000, returnLosses: 0, netProfit: 2_000 });
    expect(stats).toMatchObject({ collected: 10_000, refunded: 0, pendingRefund: 5_000 });

    await payRefund(shop.context, returned.remboursements[0]!.id, 5_000, "CASH", testKey());
    stats = await summary(shop);
    expect(stats).toMatchObject({ netCollected: 5_000, pendingRefund: 0 });

    const movement = await prisma.mouvementStock.findFirstOrThrow({ where: { type: StockMovementType.SALE_RETURN } });
    expect(movement).toMatchObject({ variationQuantite: 1, quantiteAvant: 8, quantiteApres: 9 });
  });

  it("retour NON revendable : pas de remise en stock, coût compté en pertes", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 3_000, prixVente: 5_000, stock: 10 });
    const sale = await cashSale(shop, produit.id, 2);
    await returnLine(shop, sale.id, sale.lignes[0]!.id, 1, false, "CASH");

    expect(await stockOf(shop.boutique.id, produit.id)).toBe(8); // inchangé après la vente
    // CA 5 000, coût net 3 000, marge 2 000 ; article cassé : perte 3 000 ; résultat −1 000.
    expect(await summary(shop)).toMatchObject({
      revenue: 5_000, costOfGoodsSold: 3_000, grossMargin: 2_000, returnLosses: 3_000, lossesTotal: 3_000, netProfit: -1_000,
      collected: 10_000, refunded: 5_000, netCollected: 5_000,
    });
  });

  it("retour sur une vente à crédit : l'avoir réduit d'abord la dette, l'excédent seul est remboursé", async () => {
    const shop = await createShop();
    const awa = await client(shop);
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 5_000, stock: 10 });
    const sale = await creditSale(shop, produit.id, 2, awa.id, 2_000); // total 10 000, payé 2 000, reste 8 000

    const first = await returnLine(shop, sale.id, sale.lignes[0]!.id, 1, true);
    // Avoir 5 000 < reste 8 000 : la dette passe à 3 000, rien à rembourser.
    expect(Number(first.resteAPayer)).toBe(3_000);
    expect(first.remboursements).toHaveLength(0);

    const second = await returnLine(shop, sale.id, sale.lignes[0]!.id, 1, true);
    // Avoir 5 000 > reste 3 000 : dette 0, et 2 000 payés en trop sont dus au client.
    expect(Number(second.resteAPayer)).toBe(0);
    expect(Number(second.remboursements[0]!.montant)).toBe(2_000);
    expect(await summary(shop)).toMatchObject({ revenue: 0, outstanding: 0, pendingRefund: 2_000 });
  });

  it("remise globale répartie au centime : la somme des avoirs vaut exactement le total payé", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 1_000, stock: 10 });
    const sale = await cashSale(shop, produit.id, 3, 100); // sous-total 3 000, remise 100, total 2 900
    const lineId = sale.lignes[0]!.id;

    const first = await returnLine(shop, sale.id, lineId, 1, true);
    expect(Number(first.montantRetourne)).toBe(966.67); // 2 900 / 3 arrondi
    const last = await returnLine(shop, sale.id, lineId, 2, true);
    expect(Number(last.montantRetourne)).toBe(2_900); // le dernier retour reprend l'écart d'arrondi
    expect(Number(last.montantARembourser)).toBe(2_900);
    expect((await summary(shop)).revenue).toBe(0);
  });

  it("refuse de retourner plus que vendu moins déjà retourné, et tout retour sur une vente annulée", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 1_000, stock: 10 });
    const sale = await cashSale(shop, produit.id, 2);
    const lineId = sale.lignes[0]!.id;

    await expect(returnLine(shop, sale.id, lineId, 3, true)).rejects.toMatchObject({ status: 409 });
    await returnLine(shop, sale.id, lineId, 2, true);
    await expect(returnLine(shop, sale.id, lineId, 1, true)).rejects.toMatchObject({ status: 409 });

    const other = await cashSale(shop, produit.id, 1);
    await cancel(shop.context, other.id);
    await expect(returnLine(shop, other.id, other.lignes[0]!.id, 1, true)).rejects.toMatchObject({ status: 409 });
  });

  it("annulation après un retour partiel : seul le reste revient en stock, remboursement = payé − déjà dû", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 1_000, stock: 10 });
    const sale = await cashSale(shop, produit.id, 4); // payé 4 000, stock 6
    await returnLine(shop, sale.id, sale.lignes[0]!.id, 1, true); // stock 7, 1 000 dus
    const cancelled = await cancel(shop.context, sale.id);

    expect(await stockOf(shop.boutique.id, produit.id)).toBe(10); // 7 + 3 restants
    const refunds = cancelled.remboursements.map((refund) => Number(refund.montant)).sort((a, b) => a - b);
    expect(refunds).toEqual([1_000, 3_000]); // jamais plus que les 4 000 reçus
    expect(Number(cancelled.montantARembourser)).toBe(4_000);
  });

  it("un retour rejoué avec la même clé n'est appliqué qu'une fois", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 1_000, stock: 10 });
    const sale = await cashSale(shop, produit.id, 2);
    const input = { motif: "Retour", lignes: [{ ligneVenteId: sale.lignes[0]!.id, quantite: 1, remiseEnStock: true }] };
    const key = testKey("return");

    await createSaleReturn(shop.context, sale.id, input, key);
    const replay = await createSaleReturn(shop.context, sale.id, input, key);
    expect(replay.retours).toHaveLength(1);
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(9);
    await expect(
      createSaleReturn(shop.context, sale.id, { ...input, motif: "Autre motif" }, key),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("bénéfice : dépenses, pertes et écarts d'inventaire (F-06)", () => {
  it("résultat = marge − dépenses − pertes déclarées − écarts d'inventaire nets", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 600, prixVente: 1_000, stock: 20 });
    await cashSale(shop, produit.id, 10); // CA 10 000, coût 6 000, marge 4 000 ; stock 10
    await prisma.depense.create({
      data: { organisationId: shop.organisation.id, boutiqueId: shop.boutique.id, categorie: "Transport", libelle: "Livraison", montant: 1_000, creeParId: shop.context.userId },
    });
    await createLoss(shop.context, { boutiqueId: shop.boutique.id, produitId: produit.id, quantite: 2, motif: "CASSE" }, testKey("loss")); // perte 1 200 ; stock 8

    const inventory = await createInventory(shop.context, { boutiqueId: shop.boutique.id, libelle: "Mensuel", selectionType: "MANUAL", produitIds: [produit.id] });
    const line = inventory.lignes[0]!;
    await countInventoryLine(shop.context, inventory.id, line.id, { quantiteComptee: 7, version: line.version }); // 1 manquant : 600
    await validateInventory(shop.context, inventory.id);

    // 4 000 − 1 000 − 1 200 − 600 = 1 200.
    expect(await summary(shop)).toMatchObject({
      grossMargin: 4_000, expensesTotal: 1_000, stockLosses: 1_200, inventoryShortfall: 600, inventorySurplus: 0,
      lossesTotal: 1_800, netProfit: 1_200,
    });
  });
});

describe("opérations simultanées", () => {
  it("5 versements de 3 000 en parallèle sur un reste de 10 000 : exactement 3 acceptés", async () => {
    const shop = await createShop();
    const awa = await client(shop);
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 10_000 });
    const sale = await creditSale(shop, produit.id, 1, awa.id, 0);

    const results = await Promise.allSettled(Array.from({ length: 5 }, () => pay(shop.context, sale.id, 3_000)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    const fresh = await prisma.vente.findUniqueOrThrow({ where: { id: sale.id }, include: { paiements: true } });
    expect(Number(fresh.montantPaye)).toBe(9_000);
    expect(Number(fresh.resteAPayer)).toBe(1_000);
    expect(fresh.paiements.reduce((sum, payment) => sum + Number(payment.montant), 0)).toBe(9_000);
  });

  it("10 ventes simultanées sur un stock de 5 : 5 acceptées, stock 0, jamais négatif", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 1_000, stock: 5 });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => cashSale(shop, produit.id, 1)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(0);
    expect((await summary(shop)).revenue).toBe(5_000);
  });

  it("retours concurrents du dernier article : un seul passe", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 1_000, stock: 5 });
    const sale = await cashSale(shop, produit.id, 1);
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => returnLine(shop, sale.id, sale.lignes[0]!.id, 1, true)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(5);
  });

  it("annulation et versement simultanés : jamais de paiement accepté sur une vente annulée", async () => {
    const shop = await createShop();
    const awa = await client(shop);
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 10_000 });
    const sale = await creditSale(shop, produit.id, 1, awa.id, 1_000);

    await Promise.allSettled([cancel(shop.context, sale.id), pay(shop.context, sale.id, 2_000)]);
    const fresh = await prisma.vente.findUniqueOrThrow({ where: { id: sale.id }, include: { paiements: true, remboursements: true } });
    expect(fresh.statut).toBe(SaleStatus.CANCELLED);
    // Tout l'argent reçu (avec ou sans le versement) est dû au client, ni plus ni moins.
    const received = fresh.paiements.reduce((sum, payment) => sum + Number(payment.montant), 0);
    expect(fresh.remboursements.reduce((sum, refund) => sum + Number(refund.montant), 0)).toBe(received);
  });
});

describe("API — annulation, retours et remboursements", () => {
  const app = createApp();

  function signIn(userId: number, organizationId: number, role: Role) {
    sessionMock.current = {
      expires: new Date(Date.now() + 3600_000).toISOString(),
      user: { id: userId, name: "Test", tenant: { organizationId, role, storeId: null, organizationName: "Org" } },
    };
  }

  it("annulation : clé d'idempotence obligatoire, motif obligatoire, réservée aux gérants", async () => {
    const shop = await createShop();
    const seller = await createMember(shop.organisation.id, Role.SELLER);
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 1_000 });
    const sale = await cashSale(shop, produit.id, 1);

    signIn(seller.utilisateur.id, shop.organisation.id, Role.SELLER);
    expect((await request(app).post(`/api/sales/${sale.id}/cancel`).set("Idempotency-Key", testKey()).send({ motif: "Essai" })).status).toBe(403);

    signIn(shop.context.userId, shop.organisation.id, Role.OWNER);
    expect((await request(app).post(`/api/sales/${sale.id}/cancel`).send({ motif: "Essai" })).status).toBe(400);
    expect((await request(app).post(`/api/sales/${sale.id}/cancel`).set("Idempotency-Key", testKey()).send({})).status).toBe(400);
    const ok = await request(app)
      .post(`/api/sales/${sale.id}/cancel`)
      .set("Idempotency-Key", testKey())
      .send({ motif: "Client parti", remboursementImmediat: { modePaiement: "CASH" } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.etatFinancier).toBe("SOLDEE");
    expect(ok.body.data.cleAnnulation).toBeUndefined();
  });

  it("mode de remboursement contrôlé : CREDIT ou valeur libre refusés", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 1_000 });
    const sale = await cashSale(shop, produit.id, 1);
    const cancelled = await cancel(shop.context, sale.id);
    signIn(shop.context.userId, shop.organisation.id, Role.OWNER);

    for (const modePaiement of ["CREDIT", "cash", "ESPECES"]) {
      const response = await request(app)
        .post(`/api/sales/refunds/${cancelled.remboursements[0]!.id}/payouts`)
        .set("Idempotency-Key", testKey())
        .send({ montant: 1_000, modePaiement });
      expect(response.status).toBe(400);
    }
    const detail = await request(app).get(`/api/sales/${sale.id}`);
    expect(detail.body.data.etatFinancier).toBe("REMBOURSEMENT_EN_ATTENTE");
    expect(Number(detail.body.data.remboursementEnAttente)).toBe(1_000);
  });

  it("un vendeur ne peut ni retourner ni rembourser ; une autre organisation ne voit rien", async () => {
    const shop = await createShop();
    const other = await createShop("Autre");
    const seller = await createMember(shop.organisation.id, Role.SELLER);
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 1_000 });
    const sale = await cashSale(shop, produit.id, 1);
    const body = { motif: "Retour", lignes: [{ ligneVenteId: sale.lignes[0]!.id, quantite: 1, remiseEnStock: true }] };

    signIn(seller.utilisateur.id, shop.organisation.id, Role.SELLER);
    expect((await request(app).post(`/api/sales/${sale.id}/returns`).set("Idempotency-Key", testKey()).send(body)).status).toBe(403);

    signIn(other.context.userId, other.organisation.id, Role.OWNER);
    expect((await request(app).post(`/api/sales/${sale.id}/returns`).set("Idempotency-Key", testKey()).send(body)).status).toBe(404);
    expect((await request(app).get(`/api/sales/${sale.id}`)).status).toBe(404);
    await expect(
      createSaleReturn(contextFor({ ...other.owner.membre }), sale.id, body, testKey()),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("l'ancien remboursement partiel sans retour n'existe plus", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 1_000 });
    const sale = await cashSale(shop, produit.id, 1);
    signIn(shop.context.userId, shop.organisation.id, Role.OWNER);
    const response = await request(app).post(`/api/sales/${sale.id}/refunds`).set("Idempotency-Key", testKey()).send({ montant: 100, motif: "Geste" });
    expect(response.status).toBe(404);
  });
});
