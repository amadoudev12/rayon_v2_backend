/**
 * Administration centrale des abonnements (cahier §12, mission §6 et §9) :
 * tableau de bord, attribution de forfait, prolongation, suspension et
 * réactivation avec motif, essai accordé, transactions et incohérences,
 * journal d'audit, séparation stricte des accès.
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
import { Role, SubscriptionStatus } from "@/generated/prisma/enums";
import { createApp } from "@/app";
import { acceptedDocuments, createProduit, createShop, resetDatabase, testKey } from "./helpers/factories";

const app = createApp();
const DAY = 86_400_000;

beforeEach(async () => {
  await resetDatabase();
  sessionMock.current = null;
  process.env.SUBSCRIPTIONS_ENFORCED = "true";
});
afterEach(() => {
  delete process.env.SUBSCRIPTIONS_ENFORCED;
});

function signIn(userId: number, organizationId: number | null = null, role: Role | null = null) {
  sessionMock.current = {
    expires: new Date(Date.now() + 3600_000).toISOString(),
    user: { id: userId, name: "Test", tenant: organizationId && role ? { organizationId, role, storeId: null, organizationName: "Org" } : null },
  };
}

type Shop = Awaited<ReturnType<typeof createShop>>;
const asOwner = (shop: Shop) => signIn(shop.owner.utilisateur.id, shop.organisation.id, Role.OWNER);

async function asSuperAdmin() {
  const admin = await prisma.utilisateur.create({ data: { prenom: "Super", nom: "Admin", email: `root${Date.now()}${Math.random()}@plateforme.test`, motDePasseHash: "x", superAdmin: true, ...acceptedDocuments() } });
  signIn(admin.id);
  return admin;
}

async function subscribe(shop: Shop, plan: string, daysLeft: number, statut: SubscriptionStatus = SubscriptionStatus.ACTIVE) {
  const now = Date.now();
  return prisma.abonnement.create({
    data: {
      organisationId: shop.organisation.id,
      plan,
      statut,
      periodeDebut: new Date(now + Math.min(daysLeft, 0) * DAY - 30 * DAY),
      periodeFin: new Date(now + daysLeft * DAY),
      ...(statut === SubscriptionStatus.TRIAL ? { essaiDebutLe: new Date(now - 3 * DAY), essaiFinLe: new Date(now + daysLeft * DAY) } : {}),
    },
  });
}

const act = (organizationId: number, action: string, body: object) => request(app).post(`/api/admin/organizations/${organizationId}/subscription/${action}`).send(body);
const sale = (produitId: number) => request(app).post("/api/sales").set("Idempotency-Key", testKey()).send({ modePaiement: "CASH", lignes: [{ produitId, quantite: 1 }] });

describe("interventions manuelles : motif obligatoire, historique, journal d'audit, notification", () => {
  it("attribue un forfait à une organisation sans abonnement (décision tracée)", async () => {
    const shop = await createShop("Ancienne cliente");
    const admin = await asSuperAdmin();

    const missing = await act(shop.organisation.id, "assign", { plan: "BUSINESS", months: 3 });
    expect(missing.status).toBe(400);
    expect(await prisma.abonnement.count()).toBe(0);

    const assigned = await act(shop.organisation.id, "assign", { plan: "BUSINESS", months: 3, motif: "Migration d'une cliente historique" });
    expect(assigned.status).toBe(200);
    const subscription = await prisma.abonnement.findUniqueOrThrow({ where: { organisationId: shop.organisation.id } });
    expect(subscription).toMatchObject({ plan: "BUSINESS", statut: "ACTIVE" });

    const [audit] = await prisma.journalAdministration.findMany();
    expect(audit).toMatchObject({ adminId: admin.id, action: "subscription.plan_assigned", organisationId: shop.organisation.id, motif: "Migration d'une cliente historique", ancienneValeur: null });
    expect(audit.nouvelleValeur).toMatchObject({ plan: "BUSINESS", statut: "ACTIVE" });
    expect(await prisma.historiqueAbonnement.findFirst()).toMatchObject({ action: "ADMIN_PLAN_GRANTED", effectueParId: admin.id, motif: "Migration d'une cliente historique" });
    expect(await prisma.notification.findFirst({ where: { organisationId: shop.organisation.id } })).toMatchObject({ type: "PLAN_CHANGED", utilisateurId: shop.owner.utilisateur.id });
  });

  it("change le forfait d'une période payée en cours sans toucher aux dates ; une durée est exigée sinon", async () => {
    const shop = await createShop();
    const before = await subscribe(shop, "STARTER", 20);
    await asSuperAdmin();
    await act(shop.organisation.id, "assign", { plan: "PREMIUM", motif: "Geste commercial validé" }).expect(200);
    const after = await prisma.abonnement.findUniqueOrThrow({ where: { id: before.id } });
    expect(after).toMatchObject({ plan: "PREMIUM", periodeFin: before.periodeFin, periodeDebut: before.periodeDebut });

    const expired = await createShop("Expirée");
    await subscribe(expired, "STARTER", -30);
    expect((await act(expired.organisation.id, "assign", { plan: "PREMIUM", motif: "Sans durée" })).status).toBe(409);
  });

  it("prolonge exceptionnellement une échéance expirée : l'accès est rétabli", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id);
    await subscribe(shop, "BUSINESS", -20);
    asOwner(shop);
    expect((await sale(produit.id)).status).toBe(402);

    await asSuperAdmin();
    const until = new Date(Date.now() + 15 * DAY);
    expect((await act(shop.organisation.id, "extend", { jusquAu: new Date(Date.now() - DAY), motif: "Date passée" })).status).toBe(409);
    await act(shop.organisation.id, "extend", { jusquAu: until, motif: "Panne Mobile Money signalée" }).expect(200);
    expect((await prisma.abonnement.findFirstOrThrow()).periodeFin).toEqual(until);

    asOwner(shop);
    expect((await sale(produit.id)).status).toBe(201);
    expect(await prisma.journalAdministration.count({ where: { action: "subscription.extended" } })).toBe(1);
  });

  it("prolonge un essai : la fin de l'essai suit", async () => {
    const shop = await createShop();
    await subscribe(shop, "PREMIUM", 2, SubscriptionStatus.TRIAL);
    await asSuperAdmin();
    const until = new Date(Date.now() + 10 * DAY);
    await act(shop.organisation.id, "extend", { jusquAu: until, motif: "Démonstration commerciale prolongée" }).expect(200);
    expect(await prisma.abonnement.findFirstOrThrow()).toMatchObject({ statut: "TRIAL", essaiFinLe: until, periodeFin: until });
  });

  it("suspension avec motif : lecture seule distincte de l'expiration, aucun achat ; réactivation au statut d'origine", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id);
    await subscribe(shop, "PREMIUM", 5, SubscriptionStatus.TRIAL);
    await asSuperAdmin();
    expect((await act(shop.organisation.id, "suspend", {})).status).toBe(400);
    await act(shop.organisation.id, "suspend", { motif: "Fraude suspectée sur le compte" }).expect(200);
    expect(await prisma.abonnement.findFirstOrThrow()).toMatchObject({ statut: "SUSPENDED", statutAvantSuspension: "TRIAL", motifSuspension: "Fraude suspectée sur le compte" });

    asOwner(shop);
    const blocked = await sale(produit.id);
    expect(blocked.status).toBe(402);
    expect(blocked.body.errors.reason).toBe("SUSPENDED");
    expect((await request(app).get("/api/sales")).status).toBe(200); // données consultables
    expect((await request(app).post("/api/subscription/quote").send({ type: "PERIOD", plan: "STARTER", months: 1 })).body.code).toBe("SUBSCRIPTION_SUSPENDED");

    await asSuperAdmin();
    expect((await act(shop.organisation.id, "suspend", { motif: "Deuxième suspension" })).status).toBe(409);
    await act(shop.organisation.id, "reactivate", { motif: "Vérification terminée, compte sain" }).expect(200);
    expect(await prisma.abonnement.findFirstOrThrow()).toMatchObject({ statut: "TRIAL", statutAvantSuspension: null, motifSuspension: null });
    asOwner(shop);
    expect((await sale(produit.id)).status).toBe(201);

    const actions = (await prisma.journalAdministration.findMany({ orderBy: { id: "asc" } })).map((entry) => entry.action);
    expect(actions).toEqual(["subscription.suspended", "subscription.reactivated"]);
  });

  it("essai accordé à une organisation sans abonnement ; jamais un second essai", async () => {
    const shop = await createShop();
    await asSuperAdmin();
    await act(shop.organisation.id, "trial", { motif: "Organisation inscrite avant le lancement" }).expect(201);
    expect(await prisma.abonnement.findFirstOrThrow()).toMatchObject({ statut: "TRIAL", plan: "PREMIUM" });
    expect((await act(shop.organisation.id, "trial", { motif: "Nouvelle tentative" })).status).toBe(409);
  });

  it("aucune intervention n'efface l'historique financier", async () => {
    const shop = await createShop();
    const subscription = await subscribe(shop, "BUSINESS", 10);
    await prisma.paiementAbonnement.create({
      data: { organisationId: shop.organisation.id, abonnementId: subscription.id, montant: 10_000, montantRecu: 10_000, devise: "XOF", statut: "SUCCEEDED", fournisseur: "MANUEL", referenceInterne: "RAY-HISTORIQUE", periodeDebut: new Date(), periodeFin: new Date(Date.now() + 30 * DAY), payeLe: new Date() },
    });
    await asSuperAdmin();
    await act(shop.organisation.id, "assign", { plan: "STARTER", motif: "Demande du client" }).expect(200);
    await act(shop.organisation.id, "suspend", { motif: "Contrôle de conformité" }).expect(200);
    expect(await prisma.paiementAbonnement.findFirstOrThrow()).toMatchObject({ referenceInterne: "RAY-HISTORIQUE", statut: "SUCCEEDED" });
    expect(await prisma.historiqueAbonnement.count()).toBe(2);
  });
});

describe("tableau de bord, liste, fiche et transactions", () => {
  it("indicateurs : organisations, essais, actifs, expirés, lecture seule, par forfait, paiements, chiffre d'affaires", async () => {
    const trial = await createShop("Essai");
    const starter = await createShop("Starter");
    const premium = await createShop("Premium");
    const expired = await createShop("Expirée");
    await createShop("Historique");
    await subscribe(trial, "PREMIUM", 5, SubscriptionStatus.TRIAL);
    const sub = await subscribe(starter, "STARTER", 3);
    await subscribe(premium, "PREMIUM", 40);
    await subscribe(expired, "BUSINESS", -30);
    await prisma.paiementAbonnement.create({
      data: { organisationId: starter.organisation.id, abonnementId: sub.id, montant: 7_500, montantRecu: 7_500, devise: "XOF", statut: "SUCCEEDED", fournisseur: "MANUEL", referenceInterne: "RAY-A", periodeDebut: new Date(), periodeFin: new Date(Date.now() + 30 * DAY), payeLe: new Date() },
    });
    await prisma.paiementAbonnement.create({
      data: { organisationId: premium.organisation.id, montant: 15_000, devise: "XOF", statut: "UNDER_REVIEW", fournisseur: "MANUEL", referenceInterne: "RAY-B", periodeDebut: new Date(), periodeFin: new Date(Date.now() + 30 * DAY) },
    });

    await asSuperAdmin();
    const dashboard = (await request(app).get("/api/admin/subscriptions/dashboard")).body.data;
    expect(dashboard).toMatchObject({
      organizations: 5,
      unmanaged: 1,
      states: { TRIAL: 1, ACTIVE: 2, GRACE: 0, READ_ONLY: 1 },
      readOnly: { EXPIRED: 1 },
      paidByPlan: { STARTER: 1, PREMIUM: 1, BUSINESS: 0 },
      expiringSoon: 2,
      payments: { confirmed: 1, underReview: 1 },
      revenueThisMonth: 7_500,
    });
    expect(dashboard.revenue).toHaveLength(12);

    const readOnly = await request(app).get("/api/admin/subscriptions?state=READ_ONLY");
    expect(readOnly.body.data.map((row: { nom: string }) => row.nom)).toEqual(["Expirée"]);
    const premiumList = await request(app).get("/api/admin/subscriptions?plan=PREMIUM");
    expect(premiumList.body.data.map((row: { nom: string }) => row.nom).sort()).toEqual(["Essai", "Premium"]);

    const page = (await request(app).get("/api/pages/admin/abonnements?state=TRIAL")).body.data;
    expect(page.items).toHaveLength(1);
    expect(page.dashboard.organizations).toBe(5);

    // Alertes de la cloche : paiement à vérifier.
    const shell = (await request(app).get("/api/pages/admin/shell")).body.data;
    expect(shell.alerts.map((alert: { key: string }) => alert.key)).toContain("paymentsToReview");
  });

  it("fiche d'une organisation : abonnement, quotas, historique, paiements et interventions", async () => {
    const shop = await createShop("Chez Awa");
    await prisma.organisation.update({ where: { id: shop.organisation.id }, data: { pays: "SN" } });
    await subscribe(shop, "BUSINESS", 10);
    await asSuperAdmin();
    await act(shop.organisation.id, "extend", { jusquAu: new Date(Date.now() + 40 * DAY), motif: "Compensation d'une panne" }).expect(200);
    const page = (await request(app).get(`/api/pages/admin/boutiques/${shop.organisation.id}`)).body.data;
    expect(page.billing).toMatchObject({ pays: "SN", access: { state: "ACTIVE", plan: "BUSINESS" }, usage: { stores: { used: 1, limit: 2 } } });
    expect(page.billing.history[0]).toMatchObject({ action: "ADMIN_EXTENDED", motif: "Compensation d'une panne", effectuePar: { superAdmin: true } });
    expect(page.billing.interventions[0]).toMatchObject({ action: "subscription.extended", motif: "Compensation d'une panne" });
  });

  it("transactions : filtres, détail avec événements, incohérences", async () => {
    const shop = await createShop("Chez Moussa");
    await subscribe(shop, "STARTER", 5);
    asOwner(shop);
    const pending = (await request(app).post("/api/subscription/payments").send({ type: "PERIOD", plan: "STARTER", months: 1 })).body.data.payment;
    await prisma.paiementAbonnement.create({
      data: { organisationId: shop.organisation.id, montant: 10_000, montantRecu: 10_000, paiementRecuLe: new Date(), devise: "XOF", statut: "PENDING", fournisseur: "MANUEL", referenceInterne: "RAY-RECU-NONACTIVE", periodeDebut: new Date(), periodeFin: new Date(Date.now() + 30 * DAY) },
    });

    await asSuperAdmin();
    const byStatus = await request(app).get("/api/admin/subscription-payments?status=PENDING");
    expect(byStatus.body.data).toHaveLength(2);
    expect(byStatus.body.pagination.total).toBe(2);
    expect((await request(app).get(`/api/admin/subscription-payments?search=${pending.referenceInterne}`)).body.data).toHaveLength(1);
    expect((await request(app).get("/api/admin/subscription-payments?plan=PREMIUM")).body.data).toHaveLength(0);

    const detail = (await request(app).get(`/api/admin/subscription-payments/${pending.id}`)).body.data;
    expect(detail).toMatchObject({ referenceInterne: pending.referenceInterne, organisation: { nom: "Chez Moussa" } });
    expect(detail.evenements.map((event: { type: string }) => event.type)).toEqual(["CREATED"]);

    const anomalies = (await request(app).get("/api/admin/subscription-payments/anomalies")).body.data;
    expect(anomalies.receivedNotActivated.map((payment: { referenceInterne: string }) => payment.referenceInterne)).toEqual(["RAY-RECU-NONACTIVE"]);

    // Confirmation par l'administration : tracée dans le journal d'audit.
    await request(app).post(`/api/admin/subscription-payments/${pending.id}/confirm`).send({ montantRecu: 7_500, moyenPaiement: "WAVE", referenceExterne: "WV-123" }).expect(200);
    const audit = (await request(app).get("/api/admin/audit?action=payment")).body.data;
    expect(audit.items[0]).toMatchObject({ action: "payment.confirmed", entiteId: pending.id, organisation: { nom: "Chez Moussa" } });

    const page = (await request(app).get("/api/pages/admin/paiements?status=SUCCEEDED")).body.data;
    expect(page).toMatchObject({ total: 1, confirmedAmount: 7_500 });
    const receipts = (await request(app).get("/api/admin/subscription-receipts")).body.data;
    expect(receipts).toHaveLength(1);
  });
});

describe("séparation stricte entre administrateurs centraux et organisations", () => {
  it("toutes les routes d'administration des abonnements sont refusées aux membres d'une organisation", async () => {
    const shop = await createShop();
    await subscribe(shop, "STARTER", 5);
    asOwner(shop);
    const id = shop.organisation.id;
    const responses = [
      await act(id, "assign", { plan: "PREMIUM", months: 12, motif: "Auto-attribution" }),
      await act(id, "extend", { jusquAu: new Date(Date.now() + 365 * DAY), motif: "Auto-prolongation" }),
      await act(id, "reactivate", { motif: "Tentative" }),
      await request(app).get("/api/admin/subscriptions"),
      await request(app).get("/api/admin/subscriptions/dashboard"),
      await request(app).get("/api/admin/subscription-payments/anomalies"),
      await request(app).get("/api/admin/subscription-receipts"),
      await request(app).get("/api/admin/audit"),
      await request(app).get("/api/pages/admin/abonnements"),
    ];
    for (const response of responses) expect([401, 403]).toContain(response.status);
    expect(await prisma.abonnement.findFirstOrThrow()).toMatchObject({ plan: "STARTER" });
    expect(await prisma.journalAdministration.count()).toBe(0);
  });

  it("le journal d'audit est en ajout seul : aucune route ne le modifie", async () => {
    await asSuperAdmin();
    for (const method of ["put", "patch", "delete"] as const) {
      expect((await request(app)[method]("/api/admin/audit")).status).toBe(404);
    }
  });
});
