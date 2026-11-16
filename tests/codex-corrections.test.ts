/**
 * Corrections du code laissé par Codex : ajustement de stock idempotent,
 * pertes (motifs, audit, annulabilité, rapport exact), valorisation exacte,
 * export complet des mouvements, booléen strict des dépenses et CA net du
 * super administrateur.
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
import { InventorySelectionType, LossStatus, Role, StockMovementType } from "@/generated/prisma/enums";
import { createApp } from "@/app";
import { adjustStock } from "@/services/stock";
import { cancelLoss, createLoss, getLossReport, listLosses } from "@/services/loss";
import { countInventoryLine, createInventory, validateInventory } from "@/services/inventory";
import { createSale } from "@/services/sale";
import { createSaleReturn } from "@/services/sale-return";
import { getFinancialSummary } from "@/services/finance";
import { getOrganizationDetails, listOrganizations } from "@/services/platform-admin";
import { getPlatformOverview } from "@/services/platform";
import { expenseSchema } from "@/lib/validations/expense";
import { parsePeriod } from "@/lib/period";
import { createMember, createProduit, createShop, resetDatabase, stockOf, testKey } from "./helpers/factories";

const app = createApp();

beforeEach(async () => {
  await resetDatabase();
  sessionMock.current = null;
});

type Shop = Awaited<ReturnType<typeof createShop>>;

function signIn(shop: Shop, userId = shop.owner.utilisateur.id, role: Role = Role.OWNER) {
  sessionMock.current = {
    expires: new Date(Date.now() + 3600_000).toISOString(),
    user: { id: userId, name: "Test", tenant: { organizationId: shop.organisation.id, role, storeId: null, organizationName: "Org" } },
  };
}

function csv(path: string) {
  return request(app)
    .get(path)
    .buffer(true)
    .parse((res, done) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => done(null, body));
    });
}

const thisMonth = () => parsePeriod(new URLSearchParams({ periode: "month" }));

describe("ajustement manuel de stock", () => {
  it("est idempotent : la même clé n'applique l'ajustement qu'une fois", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 10, prixAchat: 250 });
    const key = testKey("adjust");

    const first = await adjustStock(shop.context, shop.boutique.id, produit.id, { variationQuantite: -3, note: "Casse" }, key);
    const replay = await adjustStock(shop.context, shop.boutique.id, produit.id, { variationQuantite: -3, note: "Casse" }, key);

    expect(first.quantite).toBe(7);
    expect(replay.quantite).toBe(7);
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(7);
    const movements = await prisma.mouvementStock.findMany({ where: { produitId: produit.id } });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ type: StockMovementType.ADJUSTMENT, quantiteAvant: 10, quantiteApres: 7 });
    expect(movements[0]!.coutUnitaire?.toString()).toBe("250");
  });

  it("refuse une clé réutilisée avec d'autres données", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 10 });
    const key = testKey("adjust");
    await adjustStock(shop.context, shop.boutique.id, produit.id, { variationQuantite: 2 }, key);

    await expect(adjustStock(shop.context, shop.boutique.id, produit.id, { variationQuantite: 5 }, key)).rejects.toMatchObject({ status: 409 });
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(12);
  });

  it("deux envois simultanés de la même clé n'appliquent qu'un ajustement", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 10 });
    const key = testKey("adjust");

    const results = await Promise.allSettled([
      adjustStock(shop.context, shop.boutique.id, produit.id, { variationQuantite: 4 }, key),
      adjustStock(shop.context, shop.boutique.id, produit.id, { variationQuantite: 4 }, key),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(14);
    expect(await prisma.mouvementStock.count({ where: { produitId: produit.id } })).toBe(1);
  });

  it("laisse une trace d'audit et exige la clé par HTTP", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 10 });
    signIn(shop);

    const withoutKey = await request(app).post(`/api/products/${produit.id}/stock`).send({ variationQuantite: 1 });
    expect(withoutKey.status).toBe(400);

    const ok = await request(app).post(`/api/products/${produit.id}/stock`).set("Idempotency-Key", testKey("http")).send({ variationQuantite: 1 });
    expect(ok.status).toBe(200);
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(11);
    const audit = await prisma.journalAudit.findFirstOrThrow({ where: { action: "stock.adjusted" } });
    expect(audit.metadonnees).toMatchObject({ variation: 1, avant: 10, apres: 11 });
  });
});

describe("pertes de stock", () => {
  it("refuse un motif hors liste et trace déclaration et annulation dans l'audit", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 5 });
    signIn(shop);

    const invalid = await request(app)
      .post("/api/losses")
      .set("Idempotency-Key", testKey("loss"))
      .send({ boutiqueId: shop.boutique.id, produitId: produit.id, quantite: 1, motif: "n'importe quoi" });
    expect(invalid.status).toBe(400);
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(5);

    const created = await request(app)
      .post("/api/losses")
      .set("Idempotency-Key", testKey("loss"))
      .send({ produitId: produit.id, quantite: 2, motif: "PERIME" });
    expect(created.status).toBe(200);
    expect(created.body.data.boutiqueId).toBe(shop.boutique.id);

    const cancelled = await request(app).post(`/api/losses/${created.body.data.id}/cancel`).send({ motif: "Erreur de saisie" });
    expect(cancelled.status).toBe(200);
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(5);

    const actions = (await prisma.journalAudit.findMany({ orderBy: { id: "asc" } })).map((row) => row.action);
    expect(actions).toEqual(["loss.created", "loss.cancelled"]);
  });

  it("deux annulations simultanées ne recréditent le stock qu'une fois", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 5 });
    const loss = await createLoss(shop.context, { boutiqueId: shop.boutique.id, produitId: produit.id, quantite: 2, motif: "CASSE" }, testKey());

    const results = await Promise.allSettled([cancelLoss(shop.context, loss.id, "Doublon A"), cancelLoss(shop.context, loss.id, "Doublon B")]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(5);
    expect(await prisma.mouvementStock.count({ where: { type: StockMovementType.LOSS_CANCELLATION } })).toBe(1);
  });

  it("la liste indique ligne par ligne si l'annulation est encore possible", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 10 });
    const other = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 10 });
    const absorbed = await createLoss(shop.context, { boutiqueId: shop.boutique.id, produitId: produit.id, quantite: 1, motif: "CASSE" }, testKey());
    const free = await createLoss(shop.context, { boutiqueId: shop.boutique.id, produitId: other.id, quantite: 1, motif: "VOL" }, testKey());

    // Un inventaire validé a compté `produit` après la perte : elle est absorbée.
    const inventory = await createInventory(shop.context, {
      boutiqueId: shop.boutique.id,
      libelle: "Comptage",
      selectionType: InventorySelectionType.MANUAL,
      produitIds: [produit.id],
    });
    await countInventoryLine(shop.context, inventory.id, inventory.lignes[0]!.id, { quantiteComptee: 9, version: 0 });
    await validateInventory(shop.context, inventory.id);

    const { data, total } = await listLosses(shop.context, shop.boutique.id);
    expect(total).toBe(2);
    const byId = new Map(data.map((row) => [row.id, row]));
    expect(byId.get(absorbed.id)).toMatchObject({ canCancel: false, absorbeeParInventaire: true, motifLibelle: "Casse" });
    expect(byId.get(free.id)).toMatchObject({ canCancel: true, absorbeeParInventaire: false, motifLibelle: "Vol" });

    const seller = await createMember(shop.organisation.id, Role.SELLER);
    const asSeller = await listLosses({ ...shop.context, userId: seller.utilisateur.id, role: Role.SELLER }, shop.boutique.id);
    expect(asSeller.data.every((row) => !row.canCancel)).toBe(true);
  });

  it("le rapport est exact au centime et concorde avec le résultat du tableau de bord", async () => {
    const shop = await createShop();
    // 0,10 × 3 = 0,30 exactement (0.1 * 3 = 0.30000000000000004 en flottant).
    const cheap = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 10, prixAchat: 0.1 });
    const dear = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 10, prixAchat: 1234.56 });
    await createLoss(shop.context, { boutiqueId: shop.boutique.id, produitId: cheap.id, quantite: 3, motif: "PERIME" }, testKey());
    await createLoss(shop.context, { boutiqueId: shop.boutique.id, produitId: dear.id, quantite: 2, motif: "CASSE" }, testKey());
    const cancelled = await createLoss(shop.context, { boutiqueId: shop.boutique.id, produitId: dear.id, quantite: 1, motif: "VOL" }, testKey());
    await cancelLoss(shop.context, cancelled.id, "Retrouvé");

    const period = thisMonth();
    const report = await getLossReport(shop.context, shop.boutique.id, period);

    expect(report.declarations).toBe(2);
    expect(report.quantiteTotale).toBe(5);
    expect(report.valeurTotale.toString()).toBe("2469.42");
    expect(report.parMotif.map((row) => [row.libelle, row.valeur.toString()])).toEqual([
      ["Casse", "2469.12"],
      ["Périmé", "0.3"],
    ]);
    const summary = await getFinancialSummary({ organisationId: shop.organisation.id, storeId: shop.boutique.id }, period);
    expect(summary.stockLosses).toBe(2469.42);
  });
});

describe("valorisation du stock", () => {
  it("est calculée en montants exacts et sur tout le stock", async () => {
    const shop = await createShop();
    await createProduit(shop.organisation.id, shop.boutique.id, { stock: 3, prixAchat: 0.1 });
    await createProduit(shop.organisation.id, shop.boutique.id, { stock: 7, prixAchat: 0.2 });
    await createProduit(shop.organisation.id, shop.boutique.id, { stock: 0, prixAchat: 99 });
    signIn(shop);

    const response = await request(app).get("/api/stock/valuation");
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ produits: 2, quantiteTotale: 10, valeurTotale: "1.7", detailComplet: true });
    expect(response.body.data.lignes.map((line: { valeur: string }) => line.valeur)).toEqual(["1.4", "0.3"]);
  });
});

describe("historique des mouvements", () => {
  it("l'export contient tous les mouvements filtrés, pas seulement la page affichée", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 100 });
    for (let index = 0; index < 35; index += 1) {
      await adjustStock(shop.context, shop.boutique.id, produit.id, { variationQuantite: 1 }, testKey("adjust"));
    }
    signIn(shop);

    const page = await request(app).get("/api/stock/movements");
    expect(page.body.data).toHaveLength(30);
    expect(page.body.pagination.total).toBe(35);

    const exported = await csv("/api/exports/movements?periode=month&type=ADJUSTMENT");
    expect(exported.status).toBe(200);
    const lines = (exported.body as string).trim().split("\r\n");
    expect(lines).toHaveLength(36); // en-tête + 35 mouvements
    expect(lines[1]).toContain(";Ajustement;1;100;101;");

    const otherType = await csv("/api/exports/movements?periode=month&type=SALE");
    expect((otherType.body as string).trim().split("\r\n")).toHaveLength(1);
  });

  it("filtre les jours dans le fuseau de l'organisation", async () => {
    const shop = await createShop();
    await prisma.organisation.update({ where: { id: shop.organisation.id }, data: { fuseauHoraire: "Asia/Tokyo" } });
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 10 });
    // 15 novembre 23 h 30 UTC = 16 novembre 8 h 30 à Tokyo.
    await prisma.mouvementStock.create({
      data: {
        boutiqueId: shop.boutique.id,
        produitId: produit.id,
        utilisateurId: shop.context.userId,
        type: StockMovementType.ADJUSTMENT,
        variationQuantite: 1,
        creeLe: new Date("2026-11-15T23:30:00Z"),
      },
    });
    signIn(shop);

    const day15 = await request(app).get("/api/stock/movements?periode=custom&du=2026-11-15&au=2026-11-15");
    const day16 = await request(app).get("/api/stock/movements?periode=custom&du=2026-11-16&au=2026-11-16");
    expect(day15.body.pagination.total).toBe(0);
    expect(day16.body.pagination.total).toBe(1);
  });
});

describe("dépenses : charge organisationnelle", () => {
  it("lit « false » comme faux (et non comme vrai)", () => {
    const base = { libelle: "Loyer", montant: 1000, categorie: "LOYER" };
    expect(expenseSchema.parse({ ...base, organisationnelle: "false" }).organisationnelle).toBe(false);
    expect(expenseSchema.parse({ ...base, organisationnelle: "true" }).organisationnelle).toBe(true);
    expect(expenseSchema.parse({ ...base, organisationnelle: false }).organisationnelle).toBe(false);
    expect(expenseSchema.parse(base).organisationnelle).toBe(false);
    expect(() => expenseSchema.parse({ ...base, organisationnelle: "oui" })).toThrow();
  });
});

describe("super administrateur : chiffre d'affaires net", () => {
  it("déduit les retours, comme le tableau de bord de la boutique", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 600, prixVente: 1000, stock: 10 });
    const sale = await createSale(shop.context, shop.boutique.id, { lignes: [{ produitId: produit.id, quantite: 3 }], modePaiement: "CASH", remise: 0 }, testKey("sale"));
    await createSaleReturn(
      shop.context,
      sale.id,
      { motif: "Retour", lignes: [{ ligneVenteId: sale.lignes[0]!.id, quantite: 1, remiseEnStock: true }] },
      testKey("return"),
    );

    const list = await listOrganizations({ sort: "revenue", order: "desc", pagination: { page: 1, limit: 10 } });
    expect(list.items[0]!.revenue).toBe(2000);

    const details = await getOrganizationDetails(shop.organisation.id);
    expect(details!.revenue).toMatchObject({ allTime: 2000, month: 2000, averageBasket: 2000 });
    expect(details!.trend.reduce((total, point) => total + point.value, 0)).toBe(2000);

    const overview = await getPlatformOverview({ range: "30d" });
    expect(overview.revenue).toMatchObject({ allTime: 2000, today: 2000, month: 2000, period: 2000 });

    const dashboard = await getFinancialSummary({ organisationId: shop.organisation.id, storeId: null }, thisMonth());
    expect(dashboard.revenue).toBe(2000);
  });
});

describe("statut des pertes", () => {
  it("une perte annulée garde sa trace et son motif d'annulation", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 4 });
    const loss = await createLoss(shop.context, { boutiqueId: shop.boutique.id, produitId: produit.id, quantite: 1, motif: "AUTRE" }, testKey());
    await cancelLoss(shop.context, loss.id, "Produit retrouvé");

    const stored = await prisma.perteStock.findUniqueOrThrow({ where: { id: loss.id } });
    expect(stored).toMatchObject({ statut: LossStatus.CANCELLED, motifAnnulation: "Produit retrouvé" });
  });
});

describe("application mobile déjà installée (sans clé d'idempotence)", () => {
  it("période de transition : une vente et un ajustement sans clé sont acceptés comme avant", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 10 });
    signIn(shop);
    process.env.IDEMPOTENCY_KEY_REQUIRED = "false";
    try {
      const adjusted = await request(app).post(`/api/products/${produit.id}/stock`).send({ variationQuantite: 2 });
      expect(adjusted.status).toBe(200);
      const sale = await request(app)
        .post("/api/sales")
        .send({ lignes: [{ produitId: produit.id, quantite: 1 }], modePaiement: "CASH", remise: 0, boutiqueId: shop.boutique.id });
      expect(sale.status).toBe(201);
      expect(await stockOf(shop.boutique.id, produit.id)).toBe(11);
    } finally {
      process.env.IDEMPOTENCY_KEY_REQUIRED = "true";
    }
    // Régime cible : la clé est exigée.
    const refused = await request(app).post(`/api/products/${produit.id}/stock`).send({ variationQuantite: 2 });
    expect(refused.status).toBe(400);
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(11);
  });
});

