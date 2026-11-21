/**
 * Abonnements — intégration (base réelle, requêtes HTTP directes) : essai à la
 * création, quotas et fonctionnalités contrôlés côté serveur, lecture seule,
 * rétrogradation, application d'un paiement confirmé, isolation, accès.
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
import { createOrganizationForUser } from "@/services/onboarding";
import { createOrganizationWithOwner } from "@/services/platform-admin";
import { applyConfirmedPurchase, runSubscriptionMaintenance, upsertSubscription } from "@/services/subscription";
import { runTransaction } from "@/lib/transactions";
import { createMember, createProduit, createShop, resetDatabase, testKey } from "./helpers/factories";

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

/** Abonnement payé en cours (échéance dans `daysLeft` jours). */
async function subscribe(shop: Shop, plan: string, daysLeft = 20, extra: Record<string, unknown> = {}) {
  const now = Date.now();
  return prisma.abonnement.create({
    data: {
      organisationId: shop.organisation.id,
      plan,
      statut: SubscriptionStatus.ACTIVE,
      periodeDebut: new Date(now + Math.min(daysLeft, 0) * DAY - 30 * DAY),
      periodeFin: new Date(now + daysLeft * DAY),
      ...extra,
    },
  });
}

const asOwner = (shop: Shop) => signIn(shop.owner.utilisateur.id, shop.organisation.id, Role.OWNER);
const newStore = (nom: string) => request(app).post("/api/stores").send({ nom });
const newMember = (n: number) =>
  request(app).post("/api/members").send({ prenom: "Employé", nom: `Numéro${n}`, identifiant: `employe${n}-${Date.now()}@test.local`, motDePasse: "Secret123", role: "SELLER" });
const sale = (produitId: number) => request(app).post("/api/sales").set("Idempotency-Key", testKey()).send({ modePaiement: "CASH", lignes: [{ produitId, quantite: 1 }] });

describe("essai gratuit à la création de l'organisation", () => {
  it("une nouvelle organisation (inscription) reçoit 14 jours d'essai PREMIUM, tracés dans l'historique", async () => {
    const user = await prisma.utilisateur.create({ data: { prenom: "Awa", nom: "Diop", email: "awa@test.local", motDePasseHash: "x" } });
    const before = Date.now();
    const { organization } = await createOrganizationForUser(user.id, {
      nomOrganisation: "Chez Awa",
      nomBoutique: "Marché",
      telephoneBoutique: "+221771234567",
      devise: "XOF",
    });

    const subscription = await prisma.abonnement.findUniqueOrThrow({ where: { organisationId: organization.id } });
    expect(subscription).toMatchObject({ plan: "PREMIUM", statut: "TRIAL" });
    expect(subscription.essaiDebutLe!.getTime()).toBeGreaterThanOrEqual(before);
    expect(subscription.essaiFinLe!.getTime() - subscription.essaiDebutLe!.getTime()).toBe(14 * DAY);
    expect(await prisma.historiqueAbonnement.findMany({ where: { organisationId: organization.id } })).toMatchObject([
      { action: "TRIAL_STARTED", nouveauForfait: "PREMIUM", nouveauStatut: "TRIAL", effectueParId: user.id },
    ]);
    // Pays déduit de l'indicatif du téléphone de la boutique.
    expect((await prisma.organisation.findUniqueOrThrow({ where: { id: organization.id } })).pays).toBe("SN");
  });

  it("une organisation créée par l'administration reçoit aussi l'essai ; inviter des membres n'en crée pas d'autre", async () => {
    const admin = await prisma.utilisateur.create({ data: { prenom: "Super", nom: "Admin", email: "admin@plateforme.test", motDePasseHash: "x", superAdmin: true } });
    const created = await createOrganizationWithOwner(admin.id, {
      nomOrganisation: "Chez Moussa",
      nomBoutique: "Centre",
      prenom: "Moussa",
      nom: "Koné",
      identifiant: "moussa@test.local",
      motDePasse: "Secret123",
      devise: "XOF",
    });
    const owner = await prisma.membre.findFirstOrThrow({ where: { organisationId: created.id } });
    signIn(owner.utilisateurId, created.id, Role.OWNER);
    expect((await newMember(1)).status).toBe(201);
    expect((await newMember(2)).status).toBe(201);
    expect(await prisma.abonnement.count()).toBe(1);
    expect(await prisma.historiqueAbonnement.count({ where: { action: "TRIAL_STARTED" } })).toBe(1);
  });

  it("l'essai PREMIUM donne accès aux fonctionnalités PREMIUM et BUSINESS", async () => {
    const shop = await createShop();
    await prisma.abonnement.create({
      data: { organisationId: shop.organisation.id, plan: "PREMIUM", statut: "TRIAL", essaiDebutLe: new Date(), essaiFinLe: new Date(Date.now() + 14 * DAY), periodeDebut: new Date(), periodeFin: new Date(Date.now() + 14 * DAY) },
    });
    asOwner(shop);
    expect((await request(app).post("/api/suppliers").send({ nom: "Grossiste" })).status).toBe(201);
    expect((await request(app).get("/api/exports/sales?periode=month")).status).toBe(200);
    expect((await newStore("Deuxième")).status).toBe(201);
  });

  it("un essai consommé ne peut pas être relancé par l'administration", async () => {
    const shop = await createShop();
    const now = Date.now();
    await prisma.abonnement.create({
      data: { organisationId: shop.organisation.id, plan: "STARTER", statut: "ACTIVE", essaiDebutLe: new Date(now - 30 * DAY), essaiFinLe: new Date(now - 16 * DAY), periodeDebut: new Date(now - 16 * DAY), periodeFin: new Date(now + 14 * DAY) },
    });
    await expect(
      upsertSubscription(shop.organisation.id, { plan: "PREMIUM", statut: "TRIAL", periodeDebut: new Date(), periodeFin: new Date(now + 14 * DAY) }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("quotas contrôlés par le serveur (requêtes HTTP directes)", () => {
  it("STARTER : une seule boutique et 2 utilisateurs, propriétaire inclus", async () => {
    const shop = await createShop();
    await subscribe(shop, "STARTER");
    asOwner(shop);

    const store = await newStore("Deuxième boutique");
    expect(store.status).toBe(403);
    expect(store.body).toMatchObject({ code: "PLAN_QUOTA_REACHED", errors: { quota: "stores", limit: 1, used: 1 } });

    expect((await newMember(1)).status).toBe(201);
    const third = await newMember(2);
    expect(third.status).toBe(403);
    expect(third.body.errors).toMatchObject({ quota: "users", limit: 2, used: 2 });
    expect(await prisma.utilisateur.count({ where: { email: { startsWith: "employe2" } } })).toBe(0); // rien de créé à moitié
  });

  it("BUSINESS : deux boutiques au plus ; PREMIUM : dix au plus", async () => {
    const business = await createShop("Business");
    await subscribe(business, "BUSINESS");
    asOwner(business);
    expect((await newStore("B2")).status).toBe(201);
    expect((await newStore("B3")).status).toBe(403);

    const premium = await createShop("Premium");
    await subscribe(premium, "PREMIUM");
    asOwner(premium);
    for (let n = 2; n <= 10; n += 1) expect((await newStore(`P${n}`)).status).toBe(201);
    expect((await newStore("P11")).status).toBe(403);
    expect(await prisma.boutique.count({ where: { organisationId: premium.organisation.id } })).toBe(10);
  });

  it("des créations simultanées ne peuvent pas dépasser le quota", async () => {
    const shop = await createShop();
    await subscribe(shop, "BUSINESS");
    asOwner(shop);
    const results = await Promise.all(Array.from({ length: 5 }, (_, n) => newStore(`Concurrente ${n}`)));
    expect(results.filter((response) => response.status === 201)).toHaveLength(1);
    expect(await prisma.boutique.count({ where: { organisationId: shop.organisation.id } })).toBe(2);
  });

  it("les quotas sont propres à chaque organisation", async () => {
    const a = await createShop("A");
    const b = await createShop("B");
    await subscribe(a, "BUSINESS");
    await subscribe(b, "BUSINESS");
    await prisma.boutique.create({ data: { organisationId: b.organisation.id, nom: "B2" } });
    asOwner(a);
    expect((await newStore("A2")).status).toBe(201);
  });

  it("organisation existante sans abonnement : aucune limite (décision métier), même contrôle activé", async () => {
    const shop = await createShop();
    asOwner(shop);
    expect((await newStore("Deuxième")).status).toBe(201);
    expect((await newStore("Troisième")).status).toBe(201);
    expect((await request(app).post("/api/suppliers").send({ nom: "Grossiste" })).status).toBe(201);
  });

  it("contrôle désactivé : le comportement d'avant est inchangé", async () => {
    delete process.env.SUBSCRIPTIONS_ENFORCED;
    const shop = await createShop();
    await subscribe(shop, "STARTER");
    asOwner(shop);
    expect((await newStore("Deuxième")).status).toBe(201);
    expect((await request(app).post("/api/suppliers").send({ nom: "Grossiste" })).status).toBe(201);
  });
});

describe("fonctionnalités par forfait (requêtes HTTP directes)", () => {
  it("STARTER : achats, fournisseurs, devis, pertes, inventaires, exports et remises avancées refusés ; ventes autorisées", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 1_000 });
    await subscribe(shop, "STARTER");
    asOwner(shop);

    const refused = [
      await request(app).post("/api/purchases").set("Idempotency-Key", testKey()).send({}),
      await request(app).post("/api/suppliers").send({ nom: "Grossiste" }),
      await request(app).post("/api/quotes").send({}),
      await request(app).post("/api/losses").set("Idempotency-Key", testKey()).send({}),
      await request(app).post("/api/inventories").send({}),
      await request(app).put("/api/stock/threshold").send({}),
      await request(app).get("/api/stock/valuation"),
      await request(app).get("/api/exports/sales?periode=month"),
      await request(app).get("/api/pages/stock/rapports"),
      await request(app).put("/api/organization").send({ nom: "Boutique test", devise: "XOF", remiseMaxVendeurPct: 25 }),
    ];
    for (const response of refused) {
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("PLAN_FEATURE_REQUIRED");
    }
    expect(refused[0].body.errors).toEqual({ feature: "purchases", requiredPlan: "BUSINESS" });

    // Fonctions STARTER et consultation des données existantes : toujours possibles.
    expect((await sale(produit.id)).status).toBe(201);
    expect((await request(app).get("/api/purchases")).status).toBe(200);
    expect((await request(app).get("/api/suppliers")).status).toBe(200);
    expect((await request(app).put("/api/organization").send({ nom: "Nouveau nom", devise: "XOF" })).status).toBe(200);
  });

  it("STARTER : marges et coûts masqués dans le tableau de bord ; BUSINESS : visibles", async () => {
    const shop = await createShop();
    await subscribe(shop, "STARTER");
    asOwner(shop);
    const starter = await request(app).get("/api/dashboard");
    expect(starter.status).toBe(200);
    expect(starter.body.data.month.costOfSales).toBeNull();

    await prisma.abonnement.update({ where: { organisationId: shop.organisation.id }, data: { plan: "BUSINESS" } });
    const business = await request(app).get("/api/dashboard");
    expect(business.body.data.month.costOfSales).not.toBeNull();
  });

  it("BUSINESS : achats et fournisseurs autorisés", async () => {
    const shop = await createShop();
    await subscribe(shop, "BUSINESS");
    asOwner(shop);
    expect((await request(app).post("/api/suppliers").send({ nom: "Grossiste" })).status).toBe(201);
    expect((await request(app).get("/api/exports/stock")).status).toBe(200);
  });
});

describe("expiration, lecture seule et renouvellement possible", () => {
  it("7 jours de grâce avec accès normal, puis lecture seule au 8e jour ; abonnement et renouvellement restent accessibles", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 1_000 });
    const subscription = await subscribe(shop, "BUSINESS", -6.9); // échéance passée de 6,9 jours
    asOwner(shop);
    expect((await sale(produit.id)).status).toBe(201);

    await prisma.abonnement.update({ where: { id: subscription.id }, data: { periodeFin: new Date(Date.now() - 7 * DAY - 60_000) } });
    const blocked = await sale(produit.id);
    expect(blocked.status).toBe(402);
    expect(blocked.body).toMatchObject({ code: "SUBSCRIPTION_INACTIVE", errors: { reason: "EXPIRED" } });
    expect((await request(app).get("/api/sales")).status).toBe(200);

    const page = await request(app).get("/api/subscription");
    expect(page.status).toBe(200);
    expect(page.body.data).toMatchObject({ access: { state: "READ_ONLY", reason: "EXPIRED" }, canManage: true });
    const quote = await request(app).post("/api/subscription/quote").send({ type: "PERIOD", plan: "BUSINESS", months: 1, amount: 1 });
    expect(quote.status).toBe(200);
    expect(quote.body.data).toMatchObject({ kind: "RENEWAL", amount: 10_000 }); // montant du serveur, jamais du client
    // Changement de boutique affichée et sécurité du compte : toujours permis.
    expect((await request(app).post("/api/session/active-store").send({ storeId: shop.boutique.id })).status).not.toBe(402);
    expect((await request(app).post("/api/account/sessions/revoke-others")).status).not.toBe(402);
    // Aucune donnée supprimée.
    expect(await prisma.vente.count({ where: { organisationId: shop.organisation.id } })).toBe(1);
  });

  it("fin de l'essai : lecture seule immédiate avec un message dédié", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id);
    const past = Date.now() - 15 * DAY;
    await prisma.abonnement.create({
      data: { organisationId: shop.organisation.id, plan: "PREMIUM", statut: "TRIAL", essaiDebutLe: new Date(past), essaiFinLe: new Date(past + 14 * DAY), periodeDebut: new Date(past), periodeFin: new Date(past + 14 * DAY) },
    });
    asOwner(shop);
    const blocked = await sale(produit.id);
    expect(blocked.status).toBe(402);
    expect(blocked.body.errors.reason).toBe("TRIAL_ENDED");
  });

  it("un paiement confirmé réactive l'abonnement ; un montant insuffisant est refusé sans rien modifier", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id);
    await subscribe(shop, "BUSINESS", -30);
    asOwner(shop);
    expect((await sale(produit.id)).status).toBe(402);

    const request_ = { type: "PERIOD", plan: "BUSINESS", months: 3 } as const;
    await expect(
      runTransaction((tx) => applyConfirmedPurchase(tx, shop.organisation.id, request_, { confirmedAt: new Date(), amountPaid: 29_999, performedBy: null })),
    ).rejects.toMatchObject({ code: "AMOUNT_MISMATCH" });
    expect(await prisma.historiqueAbonnement.count()).toBe(0);

    const confirmedAt = new Date();
    const { quote, subscription } = await runTransaction((tx) =>
      applyConfirmedPurchase(tx, shop.organisation.id, request_, { confirmedAt, amountPaid: 30_000, performedBy: shop.owner.utilisateur.id }),
    );
    expect(quote.periodStart).toEqual(confirmedAt); // après la grâce : à la confirmation
    expect(subscription).toMatchObject({ statut: "ACTIVE", plan: "BUSINESS" });
    expect((await sale(produit.id)).status).toBe(201);
    expect(await prisma.historiqueAbonnement.findMany()).toMatchObject([{ action: "RENEWED", nouveauStatut: "ACTIVE" }]);
  });

  it("mise à niveau confirmée : forfait supérieur immédiat, échéance inchangée, quotas relevés", async () => {
    const shop = await createShop();
    const current = await subscribe(shop, "STARTER", 45);
    asOwner(shop);
    expect((await newStore("Deuxième")).status).toBe(403);

    const quote = await request(app).post("/api/subscription/quote").send({ type: "UPGRADE", plan: "BUSINESS" });
    expect(quote.body.data).toMatchObject({ kind: "UPGRADE", remainingDays: 45, amount: 3_750 });

    const { subscription } = await runTransaction((tx) =>
      applyConfirmedPurchase(tx, shop.organisation.id, { type: "UPGRADE", plan: "BUSINESS" }, { confirmedAt: new Date(), amountPaid: 3_750, performedBy: shop.owner.utilisateur.id }),
    );
    expect(subscription.plan).toBe("BUSINESS");
    expect(subscription.periodeFin).toEqual(current.periodeFin);
    expect((await newStore("Deuxième")).status).toBe(201);
  });
});

describe("rétrogradation programmée", () => {
  it("programmée à l'échéance, appliquée ensuite sans supprimer de données ; quotas appliqués au bon moment", async () => {
    const shop = await createShop();
    const subscription = await subscribe(shop, "PREMIUM", 10);
    await prisma.boutique.createMany({ data: [{ organisationId: shop.organisation.id, nom: "B2" }, { organisationId: shop.organisation.id, nom: "B3" }] });
    asOwner(shop);

    const scheduled = await request(app).post("/api/subscription/scheduled-change").send({ plan: "STARTER" });
    expect(scheduled.status).toBe(200);
    expect(scheduled.body.data.access).toMatchObject({ plan: "PREMIUM", scheduledPlan: "STARTER" });
    // Avant l'échéance : toujours PREMIUM.
    expect((await newStore("B4")).status).toBe(201);

    // L'échéance passe : la rétrogradation s'applique aussitôt aux droits, même avant la tâche planifiée.
    const due = new Date(Date.now() - 1_000);
    await prisma.abonnement.update({ where: { id: subscription.id }, data: { forfaitProgrammeLe: due, periodeFin: new Date(Date.now() + 30 * DAY) } });
    const refused = await newStore("B5");
    expect(refused.status).toBe(403);
    expect(refused.body.errors).toMatchObject({ quota: "stores", limit: 1, used: 4 });
    expect((await request(app).get("/api/stores")).body.data).toHaveLength(4); // boutiques conservées
    const usage = (await request(app).get("/api/subscription")).body.data.usage;
    expect(usage.stores).toMatchObject({ used: 4, limit: 1, overLimit: true });

    // La tâche planifiée inscrit le changement une seule fois.
    expect(await runSubscriptionMaintenance()).toEqual({ applied: 1 });
    expect(await runSubscriptionMaintenance()).toEqual({ applied: 0 });
    expect(await prisma.abonnement.findUniqueOrThrow({ where: { id: subscription.id } })).toMatchObject({ plan: "STARTER", forfaitProgramme: null });
    expect(await prisma.historiqueAbonnement.count({ where: { action: "PLAN_CHANGED" } })).toBe(1);
  });

  it("annulation d'une rétrogradation programmée", async () => {
    const shop = await createShop();
    await subscribe(shop, "BUSINESS", 10);
    asOwner(shop);
    await request(app).post("/api/subscription/scheduled-change").send({ plan: "STARTER" }).expect(200);
    const cancelled = await request(app).delete("/api/subscription/scheduled-change");
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.access.scheduledPlan).toBeNull();
    expect((await request(app).delete("/api/subscription/scheduled-change")).status).toBe(409);
    expect((await prisma.historiqueAbonnement.findMany({ orderBy: { id: "asc" } })).map((entry) => entry.action)).toEqual(["DOWNGRADE_SCHEDULED", "DOWNGRADE_CANCELLED"]);
  });
});

describe("accès et isolation", () => {
  it("seul le propriétaire gère l'abonnement ; tous les membres le consultent", async () => {
    const shop = await createShop();
    await subscribe(shop, "BUSINESS");
    const seller = await createMember(shop.organisation.id, Role.SELLER);
    const admin = await createMember(shop.organisation.id, Role.ADMIN);

    signIn(seller.utilisateur.id, shop.organisation.id, Role.SELLER);
    expect((await request(app).get("/api/subscription")).body.data).toMatchObject({ canManage: false, access: { plan: "BUSINESS" } });
    expect((await request(app).post("/api/subscription/quote").send({ type: "PERIOD", plan: "BUSINESS", months: 1 })).status).toBe(403);
    signIn(admin.utilisateur.id, shop.organisation.id, Role.ADMIN);
    expect((await request(app).post("/api/subscription/scheduled-change").send({ plan: "STARTER" })).status).toBe(403);
    expect((await request(app).get("/api/subscription/history")).status).toBe(403);
  });

  it("chaque organisation ne voit que son propre abonnement et son historique", async () => {
    const a = await createShop("A");
    const b = await createShop("B");
    await subscribe(a, "STARTER");
    await subscribe(b, "PREMIUM");
    await upsertSubscription(b.organisation.id, { plan: "PREMIUM", statut: "ACTIVE", periodeDebut: new Date(Date.now() - DAY), periodeFin: new Date(Date.now() + 40 * DAY) });
    asOwner(a);
    expect((await request(app).get("/api/subscription")).body.data.subscription.plan).toBe("STARTER");
    expect((await request(app).get("/api/subscription/history")).body.data).toEqual([]);
  });

  it("administration centrale : interdite aux organisations ; l'administrateur n'a pas d'espace abonnement client", async () => {
    const shop = await createShop();
    const superAdmin = await prisma.utilisateur.create({ data: { prenom: "Super", nom: "Admin", email: "root@plateforme.test", motDePasseHash: "x", superAdmin: true } });
    asOwner(shop);
    expect((await request(app).get(`/api/admin/organizations/${shop.organisation.id}/subscription`)).status).toBe(403);
    expect((await request(app).put(`/api/admin/organizations/${shop.organisation.id}/subscription`).send({})).status).toBe(403);

    signIn(superAdmin.id);
    expect((await request(app).get("/api/subscription")).status).toBe(403);
    const put = await request(app)
      .put(`/api/admin/organizations/${shop.organisation.id}/subscription`)
      .send({ plan: "BUSINESS", statut: "ACTIVE", periodeDebut: new Date(), periodeFin: new Date(Date.now() + 30 * DAY) });
    expect(put.status).toBe(400); // motif obligatoire pour toute intervention manuelle
    const withReason = await request(app)
      .put(`/api/admin/organizations/${shop.organisation.id}/subscription`)
      .send({ plan: "BUSINESS", statut: "ACTIVE", periodeDebut: new Date(), periodeFin: new Date(Date.now() + 30 * DAY), motif: "Contrat signé hors ligne" });
    expect(withReason.status).toBe(200);
    expect(await prisma.historiqueAbonnement.findFirst()).toMatchObject({ action: "ADMIN_UPDATED", effectueParId: superAdmin.id, nouveauForfait: "BUSINESS", motif: "Contrat signé hors ligne" });
    expect(await prisma.journalAdministration.findFirst()).toMatchObject({ action: "subscription.updated", adminId: superAdmin.id, motif: "Contrat signé hors ligne" });
  });
});
