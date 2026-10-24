import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Session } from "@/lib/auth/token";

// Session simulée pour les tests HTTP (même principe que auth-access.test.ts).
const sessionMock = vi.hoisted(() => ({ current: null as Session | null }));
vi.mock("@/lib/auth/token", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/token")>()),
  getRequestSession: vi.fn(async () => sessionMock.current),
}));

import { prisma } from "@/lib/prisma";
import { Role, SaleStatus } from "@/generated/prisma/enums";
import { createApp } from "@/app";
import { addSalePayment, cancelSale, createSale, remainingOf } from "@/services/sale";
import { getSalesStats } from "@/services/sale-stats";
import { createPurchase } from "@/services/purchase";
import { createQuote } from "@/services/quote";
import { updateProduct } from "@/services/product";
import { parsePeriod } from "@/lib/period";
import { createMember, createProduit, createShop, resetDatabase, stockOf } from "./helpers/factories";

beforeEach(async () => {
  await resetDatabase();
  sessionMock.current = null;
});

type Shop = Awaited<ReturnType<typeof createShop>>;

const today = () => parsePeriod(new URLSearchParams());

async function createClient(shop: Shop, nom = "Awa Diop") {
  return prisma.client.create({ data: { organisationId: shop.organisation.id, nom } });
}

/** Vente d'un seul produit ; `montantPaye` n'est utile qu'en crédit. */
async function sell(
  shop: Shop,
  produitId: number,
  quantite: number,
  options: { credit?: { clientId: number; montantPaye: number }; remise?: number } = {},
) {
  return createSale(shop.context, shop.boutique.id, {
    lignes: [{ produitId, quantite }],
    modePaiement: options.credit ? "CREDIT" : "CASH",
    clientId: options.credit?.clientId,
    montantPaye: options.credit?.montantPaye,
    remise: options.remise ?? 0,
  });
}

/** Déplace une vente (et ses paiements) dans le passé. */
async function backdateSale(saleId: number, date: Date) {
  await prisma.vente.update({ where: { id: saleId }, data: { creeLe: date } });
  await prisma.paiementVente.updateMany({ where: { venteId: saleId }, data: { date } });
}

describe("ventes comptant et à crédit — CA, encaissé, créances", () => {
  it("TEST 1 — vente comptant de 50 000 : CA = encaissé = 50 000, aucune créance", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 30_000, prixVente: 50_000 });

    const sale = await sell(shop, produit.id, 1);
    const stats = await getSalesStats(shop.context, shop.boutique.id, today());

    expect(stats.revenue).toBe(50_000);
    expect(stats.collected).toBe(50_000);
    expect(stats.outstanding).toBe(0);
    expect(stats.creditSales).toBe(0);
    expect(Number(remainingOf(sale))).toBe(0);
    expect(sale.paiements.map((p) => Number(p.montant))).toEqual([50_000]);
  });

  it("TESTS 2 à 4 — crédit de 100 000 avec acompte de 30 000 puis versements jusqu'au solde", async () => {
    const shop = await createShop();
    const client = await createClient(shop);
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 60_000, prixVente: 100_000 });

    // TEST 2 : le premier versement est enregistré dès la création de la vente.
    const sale = await sell(shop, produit.id, 1, { credit: { clientId: client.id, montantPaye: 30_000 } });
    expect(sale.paiements.map((p) => Number(p.montant))).toEqual([30_000]);
    expect(sale.paiements[0].utilisateurId).toBe(shop.context.userId);

    let stats = await getSalesStats(shop.context, shop.boutique.id, today());
    expect(stats.revenue).toBe(100_000);
    expect(stats.collected).toBe(30_000);
    expect(stats.outstanding).toBe(70_000);
    expect(stats.creditSales).toBe(100_000);
    expect(stats.grossMargin).toBe(40_000); // marge sur la vente complète

    // TEST 3 : deuxième paiement de 20 000.
    let updated = await addSalePayment(shop.context, sale.id, 20_000);
    expect(Number(updated.montantPaye)).toBe(50_000);
    expect(Number(remainingOf(updated))).toBe(50_000);
    stats = await getSalesStats(shop.context, shop.boutique.id, today());
    expect(stats.collected).toBe(50_000);
    expect(stats.outstanding).toBe(50_000);
    expect(stats.revenue).toBe(100_000); // un paiement n'est jamais une nouvelle vente
    expect(stats.salesCount).toBe(1);

    // TEST 4 : paiements restants jusqu'à 0.
    await addSalePayment(shop.context, sale.id, 30_000);
    updated = await addSalePayment(shop.context, sale.id, 20_000);
    expect(Number(remainingOf(updated))).toBe(0);
    expect(updated.paiements.map((p) => Number(p.montant))).toEqual([30_000, 20_000, 30_000, 20_000]);

    stats = await getSalesStats(shop.context, shop.boutique.id, today());
    expect(stats.outstanding).toBe(0);
    expect(stats.outstandingCount).toBe(0);
    expect(stats.collected).toBe(100_000);
    expect(stats.revenue).toBe(100_000);

    // Statut « Réglée » : la vente apparaît dans le filtre des créances réglées.
    const settled = await prisma.vente.count({
      where: { id: sale.id, montantPaye: { gte: prisma.vente.fields.total } },
    });
    expect(settled).toBe(1);
  });

  it("TEST 5 — refuse un paiement supérieur au reste, négatif, nul, ou sur une vente réglée/annulée", async () => {
    const shop = await createShop();
    const client = await createClient(shop);
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 100_000, stock: 5 });
    const sale = await sell(shop, produit.id, 1, { credit: { clientId: client.id, montantPaye: 30_000 } });

    await expect(addSalePayment(shop.context, sale.id, 70_001)).rejects.toMatchObject({ status: 409 });
    await expect(addSalePayment(shop.context, sale.id, -5_000)).rejects.toMatchObject({ status: 409 });
    await expect(addSalePayment(shop.context, sale.id, 0)).rejects.toMatchObject({ status: 409 });
    // Rien n'a été enregistré.
    expect(await prisma.paiementVente.count({ where: { venteId: sale.id } })).toBe(1);
    expect(Number((await prisma.vente.findUniqueOrThrow({ where: { id: sale.id } })).montantPaye)).toBe(30_000);

    await addSalePayment(shop.context, sale.id, 70_000);
    await expect(addSalePayment(shop.context, sale.id, 1)).rejects.toMatchObject({
      status: 409,
      message: "Cette vente est déjà réglée.",
    });

    const other = await sell(shop, produit.id, 1, { credit: { clientId: client.id, montantPaye: 0 } });
    await cancelSale(shop.context, other.id);
    await expect(addSalePayment(shop.context, other.id, 1_000)).rejects.toMatchObject({ status: 409 });
  });

  it("refuse un premier versement supérieur au total, un crédit sans client et un paiement partiel hors crédit", async () => {
    const shop = await createShop();
    const client = await createClient(shop);
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 10_000 });

    await expect(sell(shop, produit.id, 1, { credit: { clientId: client.id, montantPaye: 10_001 } })).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      createSale(shop.context, shop.boutique.id, {
        lignes: [{ produitId: produit.id, quantite: 1 }],
        modePaiement: "CREDIT",
        remise: 0,
        montantPaye: 0,
      }),
    ).rejects.toMatchObject({ status: 409, message: "Sélectionnez le client pour une vente à crédit." });
    await expect(
      createSale(shop.context, shop.boutique.id, {
        lignes: [{ produitId: produit.id, quantite: 1 }],
        modePaiement: "CASH",
        remise: 0,
        montantPaye: 4_000,
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(await prisma.vente.count()).toBe(0);
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(10);
  });

  it("TEST 15 — le paiement d'une ancienne créance augmente l'encaissé du jour, pas le CA", async () => {
    const shop = await createShop();
    const client = await createClient(shop);
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 100_000 });

    const oldSale = await sell(shop, produit.id, 1, { credit: { clientId: client.id, montantPaye: 30_000 } });
    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
    await backdateSale(oldSale.id, tenDaysAgo);

    await addSalePayment(shop.context, oldSale.id, 70_000);
    const stats = await getSalesStats(shop.context, shop.boutique.id, today());

    expect(stats.salesCount).toBe(0);
    expect(stats.revenue).toBe(0);
    expect(stats.creditSales).toBe(0);
    expect(stats.collected).toBe(70_000);
    expect(stats.collectedOnOlderSales).toBe(70_000);
    expect(stats.grossMargin).toBe(0);
    expect(stats.outstanding).toBe(0);
  });

  it("une vente annulée sort du CA, de l'encaissé et des créances", async () => {
    const shop = await createShop();
    const client = await createClient(shop);
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 100_000 });

    const sale = await sell(shop, produit.id, 1, { credit: { clientId: client.id, montantPaye: 30_000 } });
    await cancelSale(shop.context, sale.id);
    const stats = await getSalesStats(shop.context, shop.boutique.id, today());

    expect(stats).toMatchObject({ salesCount: 0, revenue: 0, collected: 0, creditSales: 0, outstanding: 0 });
  });
});

describe("coût historique, marge brute et bénéfice", () => {
  it("TESTS 6 et 7 — la marge de 4 000 est conservée quand le prix d'achat passe à 7 000", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 6_000, prixVente: 10_000 });

    const sale = await sell(shop, produit.id, 1);
    let stats = await getSalesStats(shop.context, shop.boutique.id, today());
    expect(stats.costOfGoodsSold).toBe(6_000);
    expect(stats.grossMargin).toBe(4_000);

    // Le fournisseur augmente son prix : modification de la fiche produit.
    await updateProduct(shop.context, produit.id, {
      nom: produit.nom,
      unite: produit.unite,
      prixAchat: 7_000,
      prixVente: 10_000,
      seuilAlerte: produit.seuilAlerte,
    });

    const ligne = await prisma.ligneVente.findFirstOrThrow({ where: { venteId: sale.id } });
    expect(Number(ligne.coutUnitaire)).toBe(6_000);
    stats = await getSalesStats(shop.context, shop.boutique.id, today());
    expect(stats.costOfGoodsSold).toBe(6_000);
    expect(stats.grossMargin).toBe(4_000);

    // Une nouvelle vente utilise le nouveau coût, l'ancienne garde le sien.
    await sell(shop, produit.id, 1);
    stats = await getSalesStats(shop.context, shop.boutique.id, today());
    expect(stats.costOfGoodsSold).toBe(13_000);
    expect(stats.grossMargin).toBe(7_000); // 4 000 + 3 000
  });

  it("un achat à un nouveau prix devient le coût des ventes suivantes (dernier prix d'achat)", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 6_000, prixVente: 10_000, stock: 5 });

    const before = await sell(shop, produit.id, 1);
    const purchase = await createPurchase(shop.context, shop.boutique.id, {
      lignes: [{ produitId: produit.id, quantite: 10, coutUnitaire: 7_000 }],
    });
    const after = await sell(shop, produit.id, 1);

    expect(Number(purchase.montantPaye)).toBe(70_000); // payé en totalité par défaut
    expect(Number((await prisma.produit.findUniqueOrThrow({ where: { id: produit.id } })).prixAchat)).toBe(7_000);
    expect(Number(before.lignes[0].coutUnitaire)).toBe(6_000);
    expect(Number(after.lignes[0].coutUnitaire)).toBe(7_000);
  });

  it("enregistre un achat à crédit et refuse un montant payé supérieur au total", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id);

    const purchase = await createPurchase(shop.context, shop.boutique.id, {
      lignes: [{ produitId: produit.id, quantite: 10, coutUnitaire: 500 }],
      montantPaye: 2_000,
    });
    expect(Number(purchase.total)).toBe(5_000);
    expect(Number(purchase.montantPaye)).toBe(2_000);

    await expect(
      createPurchase(shop.context, shop.boutique.id, {
        lignes: [{ produitId: produit.id, quantite: 1, coutUnitaire: 500 }],
        montantPaye: 501,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("TESTS 8 et 9 — marge totale de plusieurs ventes, remise déduite, puis bénéfice = marge − dépenses", async () => {
    const shop = await createShop();
    const client = await createClient(shop);
    const riz = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 6_000, prixVente: 10_000, stock: 50 });
    const huile = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 1_500, prixVente: 2_000, stock: 50 });

    await sell(shop, riz.id, 2); // CA 20 000, coût 12 000
    await sell(shop, huile.id, 4, { remise: 1_000 }); // CA 7 000, coût 6 000
    await sell(shop, riz.id, 1, { credit: { clientId: client.id, montantPaye: 0 } }); // CA 10 000, coût 6 000

    let stats = await getSalesStats(shop.context, shop.boutique.id, today());
    expect(stats.revenue).toBe(37_000);
    expect(stats.costOfGoodsSold).toBe(24_000);
    expect(stats.grossMargin).toBe(13_000);
    expect(stats.netProfit).toBe(13_000);

    const autreBoutique = await prisma.boutique.create({ data: { organisationId: shop.organisation.id, nom: "Annexe" } });
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    await prisma.depense.createMany({
      data: [
        { organisationId: shop.organisation.id, boutiqueId: shop.boutique.id, categorie: "Transport", libelle: "Livraison", montant: 3_000, creeParId: shop.context.userId },
        { organisationId: shop.organisation.id, boutiqueId: null, categorie: "Loyer", libelle: "Charge générale", montant: 2_000, creeParId: shop.context.userId },
        // Hors périmètre : autre boutique, autre jour.
        { organisationId: shop.organisation.id, boutiqueId: autreBoutique.id, categorie: "Loyer", libelle: "Annexe", montant: 9_000, creeParId: shop.context.userId },
        { organisationId: shop.organisation.id, boutiqueId: shop.boutique.id, categorie: "Transport", libelle: "Hier", montant: 4_000, date: yesterday, creeParId: shop.context.userId },
      ],
    });

    stats = await getSalesStats(shop.context, shop.boutique.id, today());
    expect(stats.expensesTotal).toBe(5_000);
    expect(stats.netProfit).toBe(8_000);
    expect(stats.netProfit).toBe(stats.grossMargin - stats.expensesTotal);
  });

  it("TEST 14 — chaque période ne compte que ses propres ventes, paiements et dépenses", async () => {
    const shop = await createShop();
    const client = await createClient(shop);
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 600, prixVente: 1_000, stock: 50 });

    const now = new Date();
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12);
    const longAgo = new Date(now.getFullYear(), now.getMonth() - 2, 15, 12);

    const oldSale = await sell(shop, produit.id, 5, { credit: { clientId: client.id, montantPaye: 1_000 } });
    await backdateSale(oldSale.id, longAgo);
    const yesterdaySale = await sell(shop, produit.id, 2);
    await backdateSale(yesterdaySale.id, yesterday);
    await sell(shop, produit.id, 1);
    await prisma.depense.create({
      data: { organisationId: shop.organisation.id, categorie: "Autre", libelle: "Hier", montant: 300, date: yesterday, creeParId: shop.context.userId },
    });

    const statsToday = await getSalesStats(shop.context, shop.boutique.id, today());
    expect(statsToday).toMatchObject({ salesCount: 1, revenue: 1_000, collected: 1_000, expensesTotal: 0, grossMargin: 400 });

    const statsYesterday = await getSalesStats(
      shop.context,
      shop.boutique.id,
      parsePeriod(new URLSearchParams({ periode: "yesterday" })),
    );
    expect(statsYesterday).toMatchObject({ salesCount: 1, revenue: 2_000, collected: 2_000, expensesTotal: 300, netProfit: 500 });

    const custom = parsePeriod(new URLSearchParams({ periode: "custom", du: toKey(longAgo), au: toKey(longAgo) }));
    const statsCustom = await getSalesStats(shop.context, shop.boutique.id, custom);
    expect(statsCustom).toMatchObject({ salesCount: 1, revenue: 5_000, collected: 1_000, creditSales: 5_000 });

    // Les créances restantes portent sur tout l'historique, quelle que soit la période.
    expect(statsToday.outstanding).toBe(4_000);
    expect(statsYesterday.outstanding).toBe(4_000);
  });
});

function toKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

describe("parsePeriod — périodes de statistiques", () => {
  const now = new Date(2026, 9, 23, 15, 30); // jeudi 23 octobre 2026

  it("aujourd'hui par défaut, hier, semaine (du lundi), mois et période personnalisée", () => {
    const period = (params: Record<string, string>) => {
      const { key, from, to } = parsePeriod(new URLSearchParams(params), now);
      return { key, from, to };
    };
    expect(period({})).toEqual({ key: "today", from: "2026-10-23", to: "2026-10-23" });
    expect(period({ periode: "yesterday" })).toEqual({ key: "yesterday", from: "2026-10-22", to: "2026-10-22" });
    expect(period({ periode: "week" })).toEqual({ key: "week", from: "2026-10-19", to: "2026-10-25" });
    expect(period({ periode: "month" })).toEqual({ key: "month", from: "2026-10-01", to: "2026-10-31" });
    expect(period({ periode: "custom", du: "2026-10-01", au: "2026-10-10" })).toEqual({
      key: "custom",
      from: "2026-10-01",
      to: "2026-10-10",
    });
    expect(period({ periode: "custom", du: "2026-10-05" })).toEqual({ key: "custom", from: "2026-10-05", to: "2026-10-05" });
  });

  it("refuse des dates invalides ou inversées", () => {
    expect(() => parsePeriod(new URLSearchParams({ periode: "custom", du: "2026-02-30" }), now)).toThrow();
    expect(() => parsePeriod(new URLSearchParams({ periode: "custom", du: "2026-10-10", au: "2026-10-01" }), now)).toThrow();
  });
});

describe("TEST 10 — devis", () => {
  it("n'enregistre aucune vente, ne touche pas au stock et n'ajoute rien au CA", async () => {
    const shop = await createShop();
    const riz = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 10_000, stock: 3 });
    const huile = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 2_000, stock: 0 });

    const quote = await createQuote(shop.context, shop.boutique.id, {
      // Un devis peut dépasser le stock disponible : il n'engage rien.
      lignes: [
        { produitId: riz.id, quantite: 5 },
        { produitId: huile.id, quantite: 2 },
      ],
      nomClient: "Entreprise Ndiaye",
      remise: 4_000,
    });

    expect(Number(quote.sousTotal)).toBe(54_000);
    expect(Number(quote.total)).toBe(50_000);
    expect(quote.nomClient).toBe("Entreprise Ndiaye");
    expect(quote.lignes.map((l) => [l.designation, l.quantite, Number(l.prixUnitaire), Number(l.sousTotal)])).toEqual([
      [riz.nom, 5, 10_000, 50_000],
      [huile.nom, 2, 2_000, 4_000],
    ]);

    expect(await prisma.vente.count()).toBe(0);
    expect(await prisma.paiementVente.count()).toBe(0);
    expect(await prisma.mouvementStock.count()).toBe(0);
    expect(await stockOf(shop.boutique.id, riz.id)).toBe(3);
    expect(await stockOf(shop.boutique.id, huile.id)).toBe(0);
    const stats = await getSalesStats(shop.context, shop.boutique.id, today());
    expect(stats).toMatchObject({ salesCount: 0, revenue: 0, outstanding: 0 });
  });

  it("refuse le produit d'une autre organisation", async () => {
    const shop = await createShop("A");
    const other = await createShop("B");
    const produitAutre = await createProduit(other.organisation.id, other.boutique.id);

    await expect(
      createQuote(shop.context, shop.boutique.id, { lignes: [{ produitId: produitAutre.id, quantite: 1 }], remise: 0 }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("API — paiements et statistiques", () => {
  const app = createApp();

  function signIn(userId: number, organizationId: number, role: Role) {
    sessionMock.current = {
      expires: new Date(Date.now() + 3600_000).toISOString(),
      user: { id: userId, name: "Test", tenant: { organizationId, role, storeId: null, organizationName: "Org" } },
    };
  }

  it("POST /api/sales/:id/payments enregistre le versement et refuse un dépassement", async () => {
    const shop = await createShop();
    const client = await createClient(shop);
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 100_000 });
    const sale = await sell(shop, produit.id, 1, { credit: { clientId: client.id, montantPaye: 30_000 } });
    signIn(shop.context.userId, shop.organisation.id, Role.OWNER);

    const ok = await request(app).post(`/api/sales/${sale.id}/payments`).send({ montant: 20_000 });
    expect(ok.status).toBe(201);
    expect(Number(ok.body.data.montantPaye)).toBe(50_000);
    expect(Number(ok.body.data.resteAPayer)).toBe(50_000);

    const tooMuch = await request(app).post(`/api/sales/${sale.id}/payments`).send({ montant: 50_001 });
    expect(tooMuch.status).toBe(409);
    const negative = await request(app).post(`/api/sales/${sale.id}/payments`).send({ montant: -10 });
    expect(negative.status).toBe(400);

    const details = await request(app).get(`/api/sales/${sale.id}`);
    expect(details.body.data.paiements.map((p: { montant: string }) => Number(p.montant))).toEqual([30_000, 20_000]);
    expect(details.body.data.statut).toBe(SaleStatus.COMPLETED);
  });

  it("GET /api/sales/stats masque coûts, marge, dépenses et bénéfice à un vendeur", async () => {
    const shop = await createShop();
    const seller = await createMember(shop.organisation.id, Role.SELLER);
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 600, prixVente: 1_000 });
    await sell(shop, produit.id, 1);

    signIn(seller.utilisateur.id, shop.organisation.id, Role.SELLER);
    const asSeller = await request(app).get(`/api/sales/stats?storeId=${shop.boutique.id}`);
    expect(asSeller.status).toBe(200);
    expect(asSeller.body.data.stats).toMatchObject({ revenue: 1_000, collected: 1_000, grossMargin: null, netProfit: null });

    signIn(shop.context.userId, shop.organisation.id, Role.OWNER);
    const asOwner = await request(app).get(`/api/sales/stats?storeId=${shop.boutique.id}&periode=month`);
    expect(asOwner.body.data.stats).toMatchObject({ revenue: 1_000, grossMargin: 400, netProfit: 400 });
    expect(asOwner.body.data.period.key).toBe("month");
  });
});

describe("prix négocié par ligne et remise globale", () => {
  it("applique le prix négocié à la ligne, puis la remise sur le sous-total ; la marge suit le prix réel", async () => {
    const shop = await createShop();
    const riz = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 6_000, prixVente: 10_000, stock: 10 });
    const huile = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 1_500, prixVente: 2_000, stock: 10 });

    const sale = await createSale(shop.context, shop.boutique.id, {
      lignes: [
        { produitId: riz.id, quantite: 2, prixUnitaire: 9_000 }, // négocié : 10 000 → 9 000
        { produitId: huile.id, quantite: 3 }, // prix catalogue
      ],
      modePaiement: "CASH",
      remise: 1_000,
    });

    const ligneRiz = sale.lignes.find((l) => l.produitId === riz.id)!;
    expect(Number(ligneRiz.prixUnitaire)).toBe(9_000);
    expect(Number(ligneRiz.sousTotal)).toBe(18_000);
    expect(Number(ligneRiz.coutUnitaire)).toBe(6_000);
    expect(Number(sale.sousTotal)).toBe(24_000); // 18 000 + 6 000
    expect(Number(sale.total)).toBe(23_000); // remise globale de 1 000
    expect(Number(sale.montantPaye)).toBe(23_000);

    // Le catalogue n'est pas modifié par la négociation.
    expect(Number((await prisma.produit.findUniqueOrThrow({ where: { id: riz.id } })).prixVente)).toBe(10_000);

    const stats = await getSalesStats(shop.context, shop.boutique.id, today());
    expect(stats.revenue).toBe(23_000);
    expect(stats.costOfGoodsSold).toBe(16_500); // 2 × 6 000 + 3 × 1 500
    expect(stats.grossMargin).toBe(6_500);
  });

  it("refuse un prix négatif ou deux prix différents pour un même produit", async () => {
    const shop = await createShop();
    const riz = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 10_000 });

    const { saleSchema } = await import("@/lib/validations/sale");
    expect(saleSchema.safeParse({ lignes: [{ produitId: riz.id, quantite: 1, prixUnitaire: -1 }] }).success).toBe(false);

    await expect(
      createSale(shop.context, shop.boutique.id, {
        lignes: [
          { produitId: riz.id, quantite: 1, prixUnitaire: 9_000 },
          { produitId: riz.id, quantite: 1, prixUnitaire: 8_000 },
        ],
        modePaiement: "CASH",
        remise: 0,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await stockOf(shop.boutique.id, riz.id)).toBe(10);
  });

  it("un devis reprend aussi le prix négocié", async () => {
    const shop = await createShop();
    const riz = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 10_000 });

    const quote = await createQuote(shop.context, shop.boutique.id, {
      lignes: [{ produitId: riz.id, quantite: 3, prixUnitaire: 8_500 }],
      remise: 500,
    });

    expect(Number(quote.lignes[0].prixUnitaire)).toBe(8_500);
    expect(Number(quote.sousTotal)).toBe(25_500);
    expect(Number(quote.total)).toBe(25_000);
  });
});

describe("transformation d'un devis en vente", () => {
  async function shopWithQuote() {
    const shop = await createShop();
    const client = await createClient(shop);
    const riz = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 6_000, prixVente: 10_000, stock: 10 });
    const quote = await createQuote(shop.context, shop.boutique.id, {
      lignes: [{ produitId: riz.id, quantite: 3, prixUnitaire: 9_000 }],
      clientId: client.id,
      remise: 1_000,
    });
    // Le formulaire de vente reprend les lignes, les prix et la remise du devis.
    const fromQuote = {
      lignes: quote.lignes.map((line) => ({ produitId: line.produitId!, quantite: line.quantite, prixUnitaire: Number(line.prixUnitaire) })),
      clientId: client.id,
      remise: Number(quote.remise),
      devisId: quote.id,
    };
    return { shop, client, riz, quote, fromQuote };
  }

  it("crée la vente (stock, CA, crédit) et relie le devis à cette vente", async () => {
    const { shop, riz, quote, fromQuote } = await shopWithQuote();
    expect(await stockOf(shop.boutique.id, riz.id)).toBe(10); // le devis n'a rien réservé

    const sale = await createSale(shop.context, shop.boutique.id, { ...fromQuote, modePaiement: "CREDIT", montantPaye: 6_000 });

    expect(Number(sale.total)).toBe(26_000); // 3 × 9 000 − 1 000
    expect(Number(sale.lignes[0].prixUnitaire)).toBe(9_000);
    expect(await stockOf(shop.boutique.id, riz.id)).toBe(7);
    expect((await prisma.devis.findUniqueOrThrow({ where: { id: quote.id } })).venteId).toBe(sale.id);

    const stats = await getSalesStats(shop.context, shop.boutique.id, today());
    expect(stats).toMatchObject({ salesCount: 1, revenue: 26_000, collected: 6_000, outstanding: 20_000 });
  });

  it("refuse de transformer deux fois le même devis, sans toucher au stock", async () => {
    const { shop, riz, fromQuote } = await shopWithQuote();
    await createSale(shop.context, shop.boutique.id, { ...fromQuote, modePaiement: "CASH" });

    await expect(createSale(shop.context, shop.boutique.id, { ...fromQuote, modePaiement: "CASH" })).rejects.toMatchObject({
      status: 409,
      message: "Ce devis est introuvable ou a déjà été transformé en vente.",
    });
    expect(await stockOf(shop.boutique.id, riz.id)).toBe(7); // seule la première vente a décrémenté
    expect(await prisma.vente.count()).toBe(1);
  });

  it("annuler la vente rend le devis à nouveau transformable", async () => {
    const { shop, quote, fromQuote } = await shopWithQuote();
    const sale = await createSale(shop.context, shop.boutique.id, { ...fromQuote, modePaiement: "CASH" });

    await cancelSale(shop.context, sale.id);
    expect((await prisma.devis.findUniqueOrThrow({ where: { id: quote.id } })).venteId).toBeNull();

    const again = await createSale(shop.context, shop.boutique.id, { ...fromQuote, modePaiement: "CASH" });
    expect((await prisma.devis.findUniqueOrThrow({ where: { id: quote.id } })).venteId).toBe(again.id);
  });

  it("refuse le devis d'une autre organisation", async () => {
    const { fromQuote } = await shopWithQuote();
    const other = await createShop("Concurrent");
    const produit = await createProduit(other.organisation.id, other.boutique.id);

    await expect(
      createSale(other.context, other.boutique.id, {
        lignes: [{ produitId: produit.id, quantite: 1 }],
        modePaiement: "CASH",
        remise: 0,
        devisId: fromQuote.devisId,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await stockOf(other.boutique.id, produit.id)).toBe(10);
  });
});
