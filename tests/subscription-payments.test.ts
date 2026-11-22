/**
 * Paiements d'abonnement (cahier §9, §10, §11, §16 ; mission §3, §7, §9) :
 * transaction créée par le serveur, en attente, échouée, confirmée,
 * montant incorrect, double traitement, activation interrompue puis
 * rapprochée, reçus, notifications, webhooks (signature, répétition, statut
 * réel), isolation et accès.
 *
 * Aucun prestataire réel : un faux prestataire signé (HMAC) est enregistré
 * pour ces tests uniquement ; il ne préjuge en rien du format de SasPay.
 */
import { createHmac } from "node:crypto";
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
import { reconcilePayments } from "@/services/billing/payments";
import { InvalidNotificationError, registerProvider, unregisterProvider, type ProviderStatus, type SubscriptionPaymentProvider } from "@/services/billing/provider";
import { dueReminder, runExpiryNotifications } from "@/services/notifications";
import { acceptedDocuments, createMember, createShop, resetDatabase } from "./helpers/factories";

const app = createApp();
const DAY = 86_400_000;

beforeEach(async () => {
  await resetDatabase();
  sessionMock.current = null;
  process.env.SUBSCRIPTIONS_ENFORCED = "true";
});
afterEach(() => {
  delete process.env.SUBSCRIPTIONS_ENFORCED;
  delete process.env.SUBSCRIPTION_PAYMENT_PROVIDER;
  unregisterProvider("test-pay");
});

function signIn(userId: number, organizationId: number | null = null, role: Role | null = null) {
  sessionMock.current = {
    expires: new Date(Date.now() + 3600_000).toISOString(),
    user: { id: userId, name: "Test", tenant: organizationId && role ? { organizationId, role, storeId: null, organizationName: "Org" } : null },
  };
}

type Shop = Awaited<ReturnType<typeof createShop>>;
const asOwner = (shop: Shop) => signIn(shop.owner.utilisateur.id, shop.organisation.id, Role.OWNER);

async function subscribe(shop: Shop, plan: string, daysLeft: number) {
  const now = Date.now();
  return prisma.abonnement.create({
    data: {
      organisationId: shop.organisation.id,
      plan,
      statut: SubscriptionStatus.ACTIVE,
      periodeDebut: new Date(now + Math.min(daysLeft, 0) * DAY - 30 * DAY),
      periodeFin: new Date(now + daysLeft * DAY),
    },
  });
}

async function superAdmin() {
  return prisma.utilisateur.create({ data: { prenom: "Super", nom: "Admin", email: `root${Date.now()}@plateforme.test`, motDePasseHash: "x", superAdmin: true, ...acceptedDocuments() } });
}

const startPayment = (body: Record<string, unknown>) => request(app).post("/api/subscription/payments").send(body);
const confirm = (paymentId: number, body: Record<string, unknown>) => request(app).post(`/api/admin/subscription-payments/${paymentId}/confirm`).send(body);
const mobileMoney = (amount: number, reference = "WAVE-TX-0001") => ({ montantRecu: amount, moyenPaiement: "WAVE", referenceExterne: reference });

describe("transaction créée par le serveur (paiement manuel Mobile Money)", () => {
  it("le serveur calcule le montant ; la transaction en attente ne modifie pas l'abonnement ; pas de doublon", async () => {
    const shop = await createShop();
    const before = await subscribe(shop, "BUSINESS", 10);
    asOwner(shop);

    const created = await startPayment({ type: "PERIOD", plan: "BUSINESS", months: 3, montant: 10, amount: 10 });
    expect(created.status).toBe(201);
    const payment = created.body.data.payment;
    expect(payment).toMatchObject({ statut: "PENDING", montant: 30_000, devise: "XOF", fournisseur: "MANUEL", forfait: "BUSINESS", dureeMois: 3 });
    expect(payment.referenceInterne).toMatch(/^RAY-[A-Z2-9]{10}$/);
    expect(created.body.data.instructions).toContain(payment.referenceInterne);
    expect(created.body.data.instructions).toContain("30 000 FCFA");

    // Même demande : même transaction.
    const again = await startPayment({ type: "PERIOD", plan: "BUSINESS", months: 3 });
    expect(again.status).toBe(200);
    expect(again.body.data.payment.id).toBe(payment.id);
    // Paiement en attente : abonnement inchangé.
    expect(await prisma.abonnement.findUniqueOrThrow({ where: { id: before.id } })).toMatchObject({ periodeFin: before.periodeFin, plan: "BUSINESS" });

    // Autre achat : l'ancienne demande non payée est remplacée.
    const other = await startPayment({ type: "PERIOD", plan: "BUSINESS", months: 12 });
    expect(other.status).toBe(201);
    expect(await prisma.paiementAbonnement.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ statut: "CANCELLED" });
  });

  it("le paiement reste possible en lecture seule, et pour une organisation encore sans abonnement", async () => {
    const expired = await createShop("Expirée");
    await subscribe(expired, "STARTER", -30);
    asOwner(expired);
    expect((await request(app).post("/api/sales").set("Idempotency-Key", "test-key-readonly-1").send({})).status).toBe(402);
    expect((await startPayment({ type: "PERIOD", plan: "STARTER", months: 1 })).status).toBe(201);

    const unmanaged = await createShop("Sans abonnement");
    asOwner(unmanaged);
    const created = await startPayment({ type: "PERIOD", plan: "PREMIUM", months: 1 });
    expect(created.status).toBe(201);
    expect(created.body.data.payment.montant).toBe(15_000);
  });

  it("seul le propriétaire paie ; données invalides refusées", async () => {
    const shop = await createShop();
    const admin = await createMember(shop.organisation.id, Role.ADMIN);
    signIn(admin.utilisateur.id, shop.organisation.id, Role.ADMIN);
    expect((await startPayment({ type: "PERIOD", plan: "BUSINESS", months: 1 })).status).toBe(403);
    asOwner(shop);
    expect((await startPayment({ type: "PERIOD", plan: "BUSINESS", months: 2 })).status).toBe(400);
    expect((await startPayment({ type: "PERIOD", plan: "GOLD", months: 1 })).status).toBe(400);
  });
});

describe("confirmation, activation, reçu et notification", () => {
  it("paiement confirmé : abonnement prolongé, reçu complet, propriétaire notifié — une seule fois", async () => {
    const shop = await createShop("Chez Awa");
    const before = await subscribe(shop, "BUSINESS", 10);
    asOwner(shop);
    const payment = (await startPayment({ type: "PERIOD", plan: "BUSINESS", months: 1 })).body.data.payment;

    const admin = await superAdmin();
    signIn(admin.id);
    const first = await confirm(payment.id, mobileMoney(10_000));
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ status: "SUCCEEDED", replay: false });

    const after = await prisma.abonnement.findUniqueOrThrow({ where: { id: before.id } });
    // Renouvellement anticipé : un mois ajouté à l'ancienne échéance.
    const expected = new Date(before.periodeFin);
    expected.setUTCMonth(expected.getUTCMonth() + 1);
    expect(after.periodeFin.getUTCDate()).toBe(Math.min(before.periodeFin.getUTCDate(), expected.getUTCDate()));
    expect(after.periodeFin > before.periodeFin).toBe(true);

    // Rejeu : aucun second traitement.
    const replay = await confirm(payment.id, mobileMoney(10_000));
    expect(replay.body.data).toMatchObject({ status: "SUCCEEDED", replay: true });
    expect((await prisma.abonnement.findUniqueOrThrow({ where: { id: before.id } })).periodeFin).toEqual(after.periodeFin);
    expect(await prisma.recuAbonnement.count()).toBe(1);
    expect(await prisma.historiqueAbonnement.count({ where: { action: "RENEWED" } })).toBe(1);

    asOwner(shop);
    const receipts = (await request(app).get("/api/subscription/receipts")).body.data;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      nomOrganisation: "Chez Awa",
      referenceTransaction: payment.referenceInterne,
      referenceExterne: "WAVE-TX-0001",
      forfait: "BUSINESS",
      forfaitNom: "Business",
      typeAchat: "RENEWAL",
      dureeMois: 1,
      montant: 10_000,
      devise: "XOF",
      moyenPaiement: "WAVE",
    });
    expect(receipts[0].numero).toMatch(/^REC-\d{4}-\d{6}$/);
    expect(new Date(receipts[0].periodeDebut)).toEqual(before.periodeFin);
    expect(new Date(receipts[0].periodeFin)).toEqual(after.periodeFin);
    expect((await request(app).get(`/api/subscription/receipts/${receipts[0].id}`)).status).toBe(200);

    const status = await request(app).get(`/api/subscription/payments/${payment.id}`);
    expect(status.body.data).toMatchObject({ statut: "SUCCEEDED", montantRecu: 10_000, recu: { numero: receipts[0].numero } });

    const notifications = (await request(app).get("/api/notifications")).body.data;
    expect(notifications.unread).toBe(1);
    expect(notifications.items[0]).toMatchObject({ type: "PAYMENT_CONFIRMED", lien: "/abonnement" });
    expect(notifications.items[0].message).toContain(receipts[0].numero);
  });

  it("deux confirmations simultanées ne prolongent qu'une fois", async () => {
    const shop = await createShop();
    const before = await subscribe(shop, "STARTER", 5);
    asOwner(shop);
    const payment = (await startPayment({ type: "PERIOD", plan: "STARTER", months: 1 })).body.data.payment;
    const admin = await superAdmin();
    signIn(admin.id);
    const results = await Promise.all([confirm(payment.id, mobileMoney(7_500)), confirm(payment.id, mobileMoney(7_500)), confirm(payment.id, mobileMoney(7_500))]);
    expect(results.every((response) => response.status === 200)).toBe(true);
    expect(results.filter((response) => response.body.data.replay === false)).toHaveLength(1);
    expect(await prisma.recuAbonnement.count()).toBe(1);
    expect(await prisma.historiqueAbonnement.count({ where: { action: "RENEWED" } })).toBe(1);
    const after = await prisma.abonnement.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.periodeFin.getTime() - before.periodeFin.getTime()).toBeLessThanOrEqual(31 * DAY);
  });

  it("montant incorrect : mis en vérification, abonnement inchangé ; puis confirmé après correction", async () => {
    const shop = await createShop();
    const before = await subscribe(shop, "BUSINESS", -20); // expiré : lecture seule
    asOwner(shop);
    const payment = (await startPayment({ type: "PERIOD", plan: "BUSINESS", months: 1 })).body.data.payment;
    const admin = await superAdmin();
    signIn(admin.id);

    const short = await confirm(payment.id, mobileMoney(5_000));
    expect(short.body.data).toMatchObject({ status: "UNDER_REVIEW", code: "AMOUNT_MISMATCH" });
    expect(await prisma.abonnement.findUniqueOrThrow({ where: { id: before.id } })).toMatchObject({ periodeFin: before.periodeFin });
    expect(await prisma.recuAbonnement.count()).toBe(0);
    expect(await prisma.paiementAbonnement.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ statut: "UNDER_REVIEW" });
    // La vérification n'est pas rejouée automatiquement.
    expect(await reconcilePayments()).toMatchObject({ activated: 0 });

    const fixed = await confirm(payment.id, mobileMoney(10_000, "WAVE-TX-0002"));
    expect(fixed.body.data).toMatchObject({ status: "SUCCEEDED" });
    // Après la grâce : la période commence à la confirmation.
    const after = await prisma.abonnement.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.periodeDebut.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("paiement échoué : aucun effet sur l'abonnement ; une transaction close ne peut pas être confirmée", async () => {
    const shop = await createShop();
    const before = await subscribe(shop, "BUSINESS", 3);
    asOwner(shop);
    const payment = (await startPayment({ type: "PERIOD", plan: "BUSINESS", months: 1 })).body.data.payment;
    const admin = await superAdmin();
    signIn(admin.id);
    const rejected = await request(app).post(`/api/admin/subscription-payments/${payment.id}/reject`).send({ motif: "Aucun versement reçu" });
    expect(rejected.body.data).toMatchObject({ statut: "FAILED" });
    expect((await confirm(payment.id, mobileMoney(10_000))).status).toBe(409);
    expect(await prisma.abonnement.findUniqueOrThrow({ where: { id: before.id } })).toMatchObject({ periodeFin: before.periodeFin });
    expect(await prisma.recuAbonnement.count()).toBe(0);
  });

  it("paiement confirmé mais activation interrompue : le rapprochement active une seule fois", async () => {
    const shop = await createShop();
    const before = await subscribe(shop, "STARTER", 2);
    asOwner(shop);
    const payment = (await startPayment({ type: "PERIOD", plan: "STARTER", months: 3 })).body.data.payment;
    // Arrêt entre la confirmation (argent reçu, enregistré) et l'activation.
    await prisma.paiementAbonnement.update({ where: { id: payment.id }, data: { montantRecu: 22_500, paiementRecuLe: new Date(), moyenPaiement: "ORANGE_MONEY" } });
    expect(await prisma.abonnement.findUniqueOrThrow({ where: { id: before.id } })).toMatchObject({ periodeFin: before.periodeFin });

    expect(await reconcilePayments()).toMatchObject({ activated: 1 });
    expect(await reconcilePayments()).toMatchObject({ activated: 0 });
    expect(await prisma.recuAbonnement.count()).toBe(1);
    expect(await prisma.paiementAbonnement.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ statut: "SUCCEEDED" });
    expect((await prisma.abonnement.findUniqueOrThrow({ where: { id: before.id } })).periodeFin > before.periodeFin).toBe(true);
  });

  it("pendant l'essai : la souscription prend effet immédiatement ; le changement de forfait est notifié", async () => {
    const shop = await createShop();
    const now = Date.now();
    await prisma.abonnement.create({
      data: { organisationId: shop.organisation.id, plan: "PREMIUM", statut: "TRIAL", essaiDebutLe: new Date(now - 3 * DAY), essaiFinLe: new Date(now + 11 * DAY), periodeDebut: new Date(now - 3 * DAY), periodeFin: new Date(now + 11 * DAY) },
    });
    asOwner(shop);
    const payment = (await startPayment({ type: "PERIOD", plan: "STARTER", months: 1 })).body.data.payment;
    signIn((await superAdmin()).id);
    expect((await confirm(payment.id, mobileMoney(7_500))).body.data.status).toBe("SUCCEEDED");
    const after = await prisma.abonnement.findFirstOrThrow({ where: { organisationId: shop.organisation.id } });
    expect(after).toMatchObject({ plan: "STARTER", statut: "ACTIVE" });
    expect(after.periodeDebut.getTime()).toBeGreaterThan(now - 60_000);
    expect(await prisma.notification.count({ where: { type: "PLAN_CHANGED" } })).toBe(1);
  });

  it("une transaction non payée est abandonnée après 7 jours", async () => {
    const shop = await createShop();
    asOwner(shop);
    const payment = (await startPayment({ type: "PERIOD", plan: "STARTER", months: 1 })).body.data.payment;
    await prisma.paiementAbonnement.update({ where: { id: payment.id }, data: { creeLe: new Date(Date.now() - 8 * DAY) } });
    expect(await reconcilePayments()).toMatchObject({ expired: 1 });
    expect(await prisma.paiementAbonnement.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ statut: "CANCELLED" });
  });
});

// ---------------------------------------------------------------------------
// Webhooks : faux prestataire signé, pour tests uniquement
// ---------------------------------------------------------------------------

const SECRET = "secret-de-test-uniquement";
const providerState = { statuses: new Map<string, { status: ProviderStatus; amount: number }>(), checkouts: 0 };

const fakeProvider: SubscriptionPaymentProvider = {
  id: "test-pay",
  async createCheckout(input) {
    providerState.checkouts += 1;
    return { providerReference: `TP-${input.internalReference}`, redirectUrl: `https://paiement.test/${input.internalReference}` };
  },
  async verifyNotification(rawBody, headers) {
    const signature = createHmac("sha256", SECRET).update(rawBody).digest("hex");
    if (headers["x-test-signature"] !== signature) throw new InvalidNotificationError("signature");
    const body = JSON.parse(rawBody.toString("utf8")) as { id: string; reference: string; status: ProviderStatus; amount: number };
    return { eventId: body.id, internalReference: body.reference, providerReference: `TP-${body.reference}`, status: body.status, amount: body.amount, currency: "XOF", method: "WAVE" };
  },
  async fetchTransaction(reference) {
    const known = providerState.statuses.get(reference);
    return known ? { providerReference: `TP-${reference}`, status: known.status, amount: known.amount, currency: "XOF", method: "WAVE" } : null;
  },
};

function webhook(body: object, secret = SECRET) {
  const raw = JSON.stringify(body);
  return request(app)
    .post("/api/webhooks/payments/test-pay")
    .set("Content-Type", "application/json")
    .set("X-Test-Signature", createHmac("sha256", secret).update(raw).digest("hex"))
    .send(raw);
}

describe("webhooks d'un prestataire (contrat générique)", () => {
  async function onlinePayment(plan = "BUSINESS", months = 1) {
    registerProvider(fakeProvider);
    process.env.SUBSCRIPTION_PAYMENT_PROVIDER = "test-pay";
    providerState.statuses.clear();
    const shop = await createShop();
    const subscription = await subscribe(shop, plan, 4);
    asOwner(shop);
    const created = await startPayment({ type: "PERIOD", plan, months });
    expect(created.status).toBe(201);
    return { shop, subscription, payment: created.body.data.payment, redirectUrl: created.body.data.redirectUrl };
  }

  it("webhook falsifié : rejeté (401), tracé, sans effet", async () => {
    const { subscription, payment, redirectUrl } = await onlinePayment();
    expect(redirectUrl).toBe(`https://paiement.test/${payment.referenceInterne}`);
    providerState.statuses.set(payment.referenceInterne, { status: "SUCCEEDED", amount: 10_000 });

    const forged = await webhook({ id: "evt-1", reference: payment.referenceInterne, status: "SUCCEEDED", amount: 10_000 }, "mauvais-secret");
    expect(forged.status).toBe(401);
    expect(forged.body.message).toBe("Notification refusée.");
    expect(await prisma.evenementPaiement.count({ where: { statutTraitement: "REJECTED" } })).toBe(1);
    expect(await prisma.abonnement.findUniqueOrThrow({ where: { id: subscription.id } })).toMatchObject({ periodeFin: subscription.periodeFin });
    expect(await prisma.recuAbonnement.count()).toBe(0);
  });

  it("webhook valide puis répété : une seule activation, un seul reçu", async () => {
    const { subscription, payment } = await onlinePayment();
    providerState.statuses.set(payment.referenceInterne, { status: "SUCCEEDED", amount: 10_000 });
    const event = { id: "evt-42", reference: payment.referenceInterne, status: "SUCCEEDED", amount: 10_000 };

    const first = await webhook(event);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ received: true, status: "PROCESSED" });
    const repeated = await webhook(event);
    expect(repeated.body.status).toBe("DUPLICATE");
    // Autre notification du même paiement : idempotent aussi.
    expect((await webhook({ ...event, id: "evt-43" })).status).toBe(200);

    expect(await prisma.recuAbonnement.count()).toBe(1);
    expect(await prisma.historiqueAbonnement.count({ where: { action: "RENEWED" } })).toBe(1);
    const after = await prisma.abonnement.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(after.periodeFin > subscription.periodeFin).toBe(true);
    expect(await prisma.paiementAbonnement.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ statut: "SUCCEEDED", referenceExterne: `TP-${payment.referenceInterne}` });
  });

  it("la notification n'est pas une preuve : le statut réel du prestataire fait foi", async () => {
    const { subscription, payment } = await onlinePayment();
    providerState.statuses.set(payment.referenceInterne, { status: "PENDING", amount: 10_000 });
    const response = await webhook({ id: "evt-7", reference: payment.referenceInterne, status: "SUCCEEDED", amount: 10_000 });
    expect(response.status).toBe(200);
    expect(await prisma.paiementAbonnement.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ statut: "PENDING" });
    expect(await prisma.abonnement.findUniqueOrThrow({ where: { id: subscription.id } })).toMatchObject({ periodeFin: subscription.periodeFin });
  });

  it("paiement échoué chez le prestataire : transaction close, abonnement inchangé", async () => {
    const { subscription, payment } = await onlinePayment();
    providerState.statuses.set(payment.referenceInterne, { status: "FAILED", amount: 10_000 });
    await webhook({ id: "evt-8", reference: payment.referenceInterne, status: "FAILED", amount: 10_000 }).expect(200);
    expect(await prisma.paiementAbonnement.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ statut: "FAILED" });
    expect(await prisma.abonnement.findUniqueOrThrow({ where: { id: subscription.id } })).toMatchObject({ periodeFin: subscription.periodeFin });
  });

  it("montant incorrect notifié : mis en vérification, aucune activation", async () => {
    const { payment } = await onlinePayment();
    providerState.statuses.set(payment.referenceInterne, { status: "SUCCEEDED", amount: 100 });
    await webhook({ id: "evt-9", reference: payment.referenceInterne, status: "SUCCEEDED", amount: 100 }).expect(200);
    expect(await prisma.paiementAbonnement.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ statut: "UNDER_REVIEW" });
    expect(await prisma.recuAbonnement.count()).toBe(0);
  });

  it("notification manquante : le rapprochement interroge le prestataire et active", async () => {
    const { payment } = await onlinePayment();
    providerState.statuses.set(payment.referenceInterne, { status: "SUCCEEDED", amount: 10_000 });
    await prisma.paiementAbonnement.update({ where: { id: payment.id }, data: { creeLe: new Date(Date.now() - 20 * 60_000) } });
    expect(await reconcilePayments()).toMatchObject({ verified: 1, activated: 1 });
    expect(await prisma.recuAbonnement.count()).toBe(1);
  });

  it("prestataire configuré mais indisponible : paiement refusé proprement (503), sans détail interne", async () => {
    process.env.SUBSCRIPTION_PAYMENT_PROVIDER = "inconnu";
    const shop = await createShop();
    asOwner(shop);
    const response = await startPayment({ type: "PERIOD", plan: "STARTER", months: 1 });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("PAYMENT_PROVIDER_UNAVAILABLE");
  });
});

describe("notifications d'échéance", () => {
  it("paliers 7, 3, 1 jours, jour de l'expiration et 8e jour (lecture seule)", () => {
    const end = new Date("2026-12-10T00:00:00Z");
    const paid = { statut: SubscriptionStatus.ACTIVE, essaiFinLe: null, periodeFin: end };
    const at = (iso: string) => dueReminder(paid, new Date(iso));
    expect(at("2026-12-01T00:00:00Z")).toBeNull(); // 9 jours avant
    expect(at("2026-12-03T00:00:00Z")?.kind).toBe("J-7");
    expect(at("2026-12-07T00:00:00Z")?.kind).toBe("J-3");
    expect(at("2026-12-09T08:00:00Z")?.kind).toBe("J-1");
    expect(at("2026-12-10T08:00:00Z")?.kind).toBe("EXPIRED");
    expect(at("2026-12-16T23:00:00Z")?.kind).toBe("EXPIRED"); // toujours dans la grâce
    expect(at("2026-12-17T00:00:00Z")?.kind).toBe("READ_ONLY"); // 8e jour
    const trial = dueReminder({ statut: SubscriptionStatus.TRIAL, essaiFinLe: end, periodeFin: end }, new Date("2026-12-10T01:00:00Z"));
    expect(trial).toMatchObject({ kind: "READ_ONLY", title: "Période d'essai terminée : lecture seule" });
  });

  it("chaque rappel n'est créé qu'une fois, pour le propriétaire uniquement", async () => {
    const shop = await createShop();
    const seller = await createMember(shop.organisation.id, Role.SELLER);
    await subscribe(shop, "BUSINESS", 6.5);
    expect(await runExpiryNotifications()).toEqual({ created: 1 });
    expect(await runExpiryNotifications()).toEqual({ created: 0 });

    signIn(seller.utilisateur.id, shop.organisation.id, Role.SELLER);
    expect((await request(app).get("/api/notifications")).body.data).toEqual({ items: [], unread: 0 });
    asOwner(shop);
    const list = (await request(app).get("/api/notifications")).body.data;
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ type: "SUBSCRIPTION_REMINDER", lien: "/abonnement", luLe: null });
    await request(app).post(`/api/notifications/${list.items[0].id}/read`).expect(200);
    expect((await request(app).get("/api/notifications")).body.data.unread).toBe(0);
    // Le vendeur ne peut pas marquer la notification d'un autre.
    signIn(seller.utilisateur.id, shop.organisation.id, Role.SELLER);
    expect((await request(app).post(`/api/notifications/${list.items[0].id}/read`)).status).toBe(404);
  });

  it("aucun rappel tant que les abonnements ne sont pas appliqués", async () => {
    delete process.env.SUBSCRIPTIONS_ENFORCED;
    const shop = await createShop();
    await subscribe(shop, "BUSINESS", 2);
    expect(await runExpiryNotifications()).toEqual({ created: 0 });
  });
});

describe("isolation et séparation des accès", () => {
  it("une organisation ne voit ni les transactions ni les reçus d'une autre", async () => {
    const a = await createShop("A");
    const b = await createShop("B");
    await subscribe(b, "STARTER", 5);
    asOwner(b);
    const payment = (await startPayment({ type: "PERIOD", plan: "STARTER", months: 1 })).body.data.payment;
    signIn((await superAdmin()).id);
    await confirm(payment.id, mobileMoney(7_500)).expect(200);
    const receipt = await prisma.recuAbonnement.findFirstOrThrow();

    asOwner(a);
    expect((await request(app).get(`/api/subscription/payments/${payment.id}`)).status).toBe(404);
    expect((await request(app).get(`/api/subscription/receipts/${receipt.id}`)).status).toBe(404);
    expect((await request(app).post(`/api/subscription/payments/${payment.id}/cancel`)).status).toBe(404);
    expect((await request(app).get("/api/subscription/payments")).body.data).toEqual([]);
    expect((await request(app).get("/api/notifications")).body.data.items).toEqual([]);
  });

  it("les actions de paiement de l'administration centrale sont interdites aux organisations", async () => {
    const shop = await createShop();
    asOwner(shop);
    const payment = (await startPayment({ type: "PERIOD", plan: "STARTER", months: 1 })).body.data.payment;
    expect((await request(app).get("/api/admin/subscription-payments")).status).toBe(403);
    expect((await confirm(payment.id, mobileMoney(7_500))).status).toBe(403);
    expect((await request(app).post("/api/admin/subscription-payments/reconcile")).status).toBe(403);
    expect(await prisma.paiementAbonnement.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ statut: "PENDING" });

    signIn((await superAdmin()).id);
    const list = await request(app).get("/api/admin/subscription-payments?status=PENDING");
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ referenceInterne: payment.referenceInterne, organisation: { id: shop.organisation.id } });
  });
});

describe("données des interfaces (page Abonnement, cadre de l'application, mobile)", () => {
  it("page Abonnement : le propriétaire voit transaction en attente, instructions, paiements et reçus ; un vendeur voit l'état seulement", async () => {
    process.env.SUBSCRIPTION_MANUAL_PAYMENT_INSTRUCTIONS = "Envoyez le montant au numéro Wave de Rayon.";
    try {
      const shop = await createShop("Chez Fatou");
      await subscribe(shop, "STARTER", 3);
      const seller = await createMember(shop.organisation.id, Role.SELLER);
      asOwner(shop);
      const payment = (await startPayment({ type: "PERIOD", plan: "STARTER", months: 3 })).body.data.payment;

      const page = (await request(app).get("/api/pages/abonnement")).body.data;
      expect(page).toMatchObject({ organizationName: "Chez Fatou", canManage: true, paymentMode: "MANUAL", access: { state: "ACTIVE", plan: "STARTER" } });
      expect(page.pendingInstructions).toContain("Envoyez le montant au numéro Wave de Rayon.");
      expect(page.pendingInstructions).toContain(payment.referenceInterne);
      expect(page.payments).toHaveLength(1);
      expect(page.catalog.plans.map((plan: { code: string }) => plan.code)).toEqual(["STARTER", "BUSINESS", "PREMIUM"]);
      expect(page.usage.stores).toMatchObject({ used: 1, limit: 1, atLimit: true });

      signIn(seller.utilisateur.id, shop.organisation.id, Role.SELLER);
      const sellerPage = (await request(app).get("/api/pages/abonnement")).body.data;
      expect(sellerPage).toMatchObject({ canManage: false, payments: [], receipts: [], history: [], pendingInstructions: null });
    } finally {
      delete process.env.SUBSCRIPTION_MANUAL_PAYMENT_INSTRUCTIONS;
    }
  });

  it("page Abonnement accessible en lecture seule", async () => {
    const shop = await createShop();
    await subscribe(shop, "BUSINESS", -30);
    asOwner(shop);
    const response = await request(app).get("/api/pages/abonnement");
    expect(response.status).toBe(200);
    expect(response.body.data.access).toMatchObject({ state: "READ_ONLY", reason: "EXPIRED" });
  });

  it("cadre web et /api/me : forfait, fonctionnalités non incluses et notifications non lues", async () => {
    const shop = await createShop();
    await subscribe(shop, "STARTER", 6.5);
    await runExpiryNotifications();
    asOwner(shop);

    const shell = (await request(app).get("/api/pages/shell")).body.data;
    expect(shell.unreadNotifications).toBe(1);
    expect(shell.canManageSubscription).toBe(true);
    expect(shell.entitlements).toMatchObject({ restricted: true, plan: "STARTER" });
    const locked = shell.entitlements.locked.map((item: { key: string }) => item.key);
    expect(locked).toEqual(expect.arrayContaining(["purchases", "suppliers", "quotes", "losses", "advanced_stock", "csv_export"]));
    expect(locked).not.toContain("stock_transfers"); // non développée : jamais présentée

    const me = (await request(app).get("/api/me")).body.data;
    expect(me).toMatchObject({ unreadNotifications: 1, entitlements: { plan: "STARTER" }, subscription: { state: "ACTIVE", plan: "STARTER" } });

    // Contrôle désactivé : rien n'est signalé comme bloqué.
    delete process.env.SUBSCRIPTIONS_ENFORCED;
    expect((await request(app).get("/api/pages/shell")).body.data.entitlements).toEqual({ restricted: false, plan: null, locked: [] });
  });
});
