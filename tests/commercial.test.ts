/**
 * Phase 5 : échéances des crédits, exports CSV, fondations des abonnements.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { getFinancialSummary } from "@/services/finance";
import { accessFromSubscription } from "@/services/subscription";
import { parsePeriod } from "@/lib/period";
import { createMember, createProduit, createShop, resetDatabase, testKey } from "./helpers/factories";

const app = createApp();

beforeEach(async () => {
  await resetDatabase();
  sessionMock.current = null;
});
afterEach(() => {
  delete process.env.SUBSCRIPTIONS_ENFORCED;
});

function signIn(userId: number, organizationId: number | null, role: Role | null) {
  sessionMock.current = {
    expires: new Date(Date.now() + 3600_000).toISOString(),
    user: { id: userId, name: "Test", tenant: organizationId && role ? { organizationId, role, storeId: null, organizationName: "Org" } : null },
  };
}

type Shop = Awaited<ReturnType<typeof createShop>>;
const tomorrow = () => new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

function creditSale(shop: Shop, produitId: number, clientId: number, dateEcheance?: string, modePaiement: "CREDIT" | "CASH" = "CREDIT") {
  return createSale(shop.context, shop.boutique.id, { lignes: [{ produitId, quantite: 1 }], modePaiement, clientId, montantPaye: 0, remise: 0, dateEcheance }, testKey());
}

describe("échéances des ventes à crédit", () => {
  it("enregistre l'échéance, refuse une date passée ou une échéance sur une vente comptant", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 10_000 });
    const awa = await prisma.client.create({ data: { organisationId: shop.organisation.id, nom: "Awa" } });

    const sale = await creditSale(shop, produit.id, awa.id, tomorrow());
    expect(sale.dateEcheance).toBeInstanceOf(Date);
    await expect(creditSale(shop, produit.id, awa.id, "2020-01-01")).rejects.toMatchObject({ status: 409 });
    await expect(creditSale(shop, produit.id, awa.id, tomorrow(), "CASH")).rejects.toMatchObject({ status: 409 });
  });

  it("les créances échues apparaissent en retard (résumé et page Créances)", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 10_000 });
    const awa = await prisma.client.create({ data: { organisationId: shop.organisation.id, nom: "Awa" } });
    const late = await creditSale(shop, produit.id, awa.id, tomorrow());
    await creditSale(shop, produit.id, awa.id, tomorrow());
    await prisma.vente.update({ where: { id: late.id }, data: { dateEcheance: new Date(Date.now() - 86_400_000) } });

    const summary = await getFinancialSummary({ organisationId: shop.organisation.id, storeId: shop.boutique.id }, parsePeriod(new URLSearchParams()));
    expect(summary).toMatchObject({ outstanding: 20_000, overdue: 10_000, overdueCount: 1 });

    signIn(shop.owner.utilisateur.id, shop.organisation.id, Role.OWNER);
    const page = await request(app).get("/api/pages/creances?statut=en_retard");
    expect(page.body.data.credits).toHaveLength(1);
    expect(page.body.data.credits[0]).toMatchObject({ id: late.id, enRetard: true });
  });
});

describe("exports CSV", () => {
  it("ventes : CSV Excel français, coûts réservés aux responsables, formules neutralisées, isolation", async () => {
    const shop = await createShop();
    const other = await createShop("Autre");
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 600, prixVente: 1_000 });
    const trap = await prisma.client.create({ data: { organisationId: shop.organisation.id, nom: "=HYPERLINK(\"http://x\")" } });
    await createSale(shop.context, shop.boutique.id, { lignes: [{ produitId: produit.id, quantite: 2 }], modePaiement: "CASH", clientId: trap.id, remise: 0 }, testKey());
    const otherProduct = await createProduit(other.organisation.id, other.boutique.id, { prixVente: 777 });
    await createSale(other.context, other.boutique.id, { lignes: [{ produitId: otherProduct.id, quantite: 1 }], modePaiement: "CASH", remise: 0 }, testKey());

    const seller = await createMember(shop.organisation.id, Role.SELLER);
    signIn(seller.utilisateur.id, shop.organisation.id, Role.SELLER);
    const asSeller = await request(app).get("/api/exports/sales?periode=today").buffer(true).parse((res, done) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => done(null, body));
    });
    expect(asSeller.status).toBe(200);
    expect(asSeller.headers["content-type"]).toContain("text/csv");
    const text = asSeller.body as string;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).not.toContain("Marge brute");
    expect(text).toContain("'=HYPERLINK");
    expect(text).toContain("2000");
    expect(text).not.toContain("777");
    expect((await request(app).get("/api/exports/purchases?periode=today")).status).toBe(403);
    expect((await request(app).get("/api/exports/stock")).status).toBe(403);

    signIn(shop.owner.utilisateur.id, shop.organisation.id, Role.OWNER);
    const asOwner = await request(app).get("/api/exports/sales?periode=today").buffer(true).parse((res, done) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => done(null, body));
    });
    // Coût 2 × 600 = 1 200 ; marge 2 000 − 1 200 = 800.
    expect(asOwner.body).toContain("Marge brute");
    expect(asOwner.body).toMatch(/;1200;800\r\n/);
    expect((await request(app).get(`/api/exports/sales?storeId=${other.boutique.id}`)).status).toBe(403);
  });
});

describe("abonnements (fondations)", () => {
  const day = 86_400_000;

  it("états d'accès : non soumis, essai, actif, grâce, lecture seule", () => {
    const now = new Date("2026-11-15T12:00:00Z");
    const base = { plan: "essentiel", essaiFinLe: null };
    expect(accessFromSubscription(null, now)).toMatchObject({ state: "UNMANAGED", canWrite: true });
    expect(accessFromSubscription({ ...base, statut: "TRIAL", essaiFinLe: new Date(now.getTime() + day), periodeFin: new Date(now.getTime() + day) }, now)).toMatchObject({ state: "TRIAL", canWrite: true });
    expect(accessFromSubscription({ ...base, statut: "TRIAL", essaiFinLe: new Date(now.getTime() - day), periodeFin: new Date(now.getTime() - day) }, now)).toMatchObject({ state: "READ_ONLY", canWrite: false });
    expect(accessFromSubscription({ ...base, statut: "ACTIVE", periodeFin: new Date(now.getTime() + day) }, now)).toMatchObject({ state: "ACTIVE" });
    expect(accessFromSubscription({ ...base, statut: "ACTIVE", periodeFin: new Date(now.getTime() - 3 * day) }, now)).toMatchObject({ state: "GRACE", canWrite: true });
    expect(accessFromSubscription({ ...base, statut: "ACTIVE", periodeFin: new Date(now.getTime() - 8 * day) }, now)).toMatchObject({ state: "READ_ONLY", canWrite: false });
    expect(accessFromSubscription({ ...base, statut: "SUSPENDED", periodeFin: new Date(now.getTime() + day) }, now)).toMatchObject({ state: "READ_ONLY" });
  });

  it("contrôle activé : un abonnement expiré passe l'organisation en lecture seule ; un paiement saisi la réactive, une seule fois", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 1_000 });
    const admin = await prisma.utilisateur.create({ data: { prenom: "Super", nom: "Admin", email: "admin@plateforme.test", motDePasseHash: "x", superAdmin: true } });
    const past = new Date(Date.now() - 40 * day);
    const expired = new Date(Date.now() - 10 * day);

    // Le propriétaire d'une boutique n'accède pas à l'administration des abonnements.
    signIn(shop.owner.utilisateur.id, shop.organisation.id, Role.OWNER);
    expect((await request(app).put(`/api/admin/organizations/${shop.organisation.id}/subscription`).send({})).status).toBe(403);

    signIn(admin.id, null, null);
    await request(app)
      .put(`/api/admin/organizations/${shop.organisation.id}/subscription`)
      .send({ plan: "essentiel", statut: "ACTIVE", periodeDebut: past, periodeFin: expired })
      .expect(200);

    process.env.SUBSCRIPTIONS_ENFORCED = "true";
    signIn(shop.owner.utilisateur.id, shop.organisation.id, Role.OWNER);
    const blocked = await request(app).post("/api/sales").set("Idempotency-Key", testKey()).send({ modePaiement: "CASH", lignes: [{ produitId: produit.id, quantite: 1 }] });
    expect(blocked.status).toBe(402);
    expect(blocked.body.code).toBe("SUBSCRIPTION_INACTIVE");
    expect((await request(app).get("/api/sales")).status).toBe(200); // lecture toujours possible
    expect((await request(app).get("/api/exports/sales?periode=month")).status).toBe(200);
    expect((await request(app).get("/api/me")).body.data.subscription).toMatchObject({ state: "READ_ONLY", canWrite: false });

    signIn(admin.id, null, null);
    const payment = { referenceExterne: "OM-2026-000123", montant: 15_000, devise: "XOF", periodeDebut: new Date(), periodeFin: new Date(Date.now() + 30 * day) };
    expect((await request(app).post(`/api/admin/organizations/${shop.organisation.id}/subscription/payments`).send(payment)).status).toBe(201);
    expect((await request(app).post(`/api/admin/organizations/${shop.organisation.id}/subscription/payments`).send(payment)).status).toBe(200);
    expect(await prisma.paiementAbonnement.count()).toBe(1);
    expect((await request(app).post(`/api/admin/organizations/${shop.organisation.id}/subscription/payments`).send({ ...payment, montant: 1 })).status).toBe(409);

    signIn(shop.owner.utilisateur.id, shop.organisation.id, Role.OWNER);
    const allowed = await request(app).post("/api/sales").set("Idempotency-Key", testKey()).send({ modePaiement: "CASH", lignes: [{ produitId: produit.id, quantite: 1 }] });
    expect(allowed.status).toBe(201);
  });

  it("sans abonnement enregistré, l'organisation n'est jamais bloquée, même contrôle activé", async () => {
    process.env.SUBSCRIPTIONS_ENFORCED = "true";
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 1_000 });
    signIn(shop.owner.utilisateur.id, shop.organisation.id, Role.OWNER);
    const sale = await request(app).post("/api/sales").set("Idempotency-Key", testKey()).send({ modePaiement: "CASH", lignes: [{ produitId: produit.id, quantite: 1 }] });
    expect(sale.status).toBe(201);
  });
});
