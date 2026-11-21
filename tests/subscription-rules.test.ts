/**
 * Abonnements — règles pures (cahier des charges §3 à §8) : catalogue,
 * échéances, délai de grâce, renouvellements, prorata, changements de forfait.
 * Aucune base de données : chaque calcul reçoit `now` explicitement.
 */
import { describe, expect, it } from "vitest";
import { SubscriptionStatus } from "@/generated/prisma/enums";
import { publicCatalog, periodPrice, planHasFeature, resolvePlan, PLAN_CODES, DURATIONS_MONTHS } from "@/services/billing/plans";
import {
  addMonths,
  applyQuote,
  DAY_MS,
  effectivePlanCode,
  graceEnd,
  phaseOf,
  quotePurchase,
  remainingDays,
  scheduleDowngrade,
  trialValues,
  upgradeProrata,
  type SubscriptionRecord,
} from "@/services/billing/rules";
import { accessFromSubscription } from "@/services/subscription";

const d = (iso: string) => new Date(iso);
const paid = (plan: string, periodeFin: string, extra: Partial<SubscriptionRecord> = {}): SubscriptionRecord => ({
  plan,
  statut: SubscriptionStatus.ACTIVE,
  essaiFinLe: null,
  periodeDebut: d("2026-01-01T10:00:00Z"),
  periodeFin: d(periodeFin),
  ...extra,
});

describe("catalogue des forfaits", () => {
  it("tarification complète du cahier §3.3 : prix mensuel × mois, sans remise", () => {
    const expected = {
      STARTER: [7_500, 22_500, 45_000, 90_000],
      BUSINESS: [10_000, 30_000, 60_000, 120_000],
      PREMIUM: [15_000, 45_000, 90_000, 180_000],
    };
    for (const code of PLAN_CODES) {
      expect(DURATIONS_MONTHS.map((months) => periodPrice(code, months))).toEqual(expected[code]);
    }
    expect(publicCatalog().currency).toBe("XOF");
  });

  it("quotas : boutiques 1 / 2 / 10, utilisateurs (propriétaire inclus) 2 / 5 / 10", () => {
    expect(PLAN_CODES.map((code) => resolvePlan(code).plan.limits)).toEqual([
      { stores: 1, users: 2 },
      { stores: 2, users: 5 },
      { stores: 10, users: 10 },
    ]);
  });

  it("chaque forfait inclut les fonctionnalités des forfaits inférieurs", () => {
    expect(planHasFeature("STARTER", "sales")).toBe(true);
    expect(planHasFeature("STARTER", "purchases")).toBe(false);
    expect(planHasFeature("BUSINESS", "purchases")).toBe(true);
    expect(planHasFeature("BUSINESS", "stock_transfers")).toBe(false);
    expect(planHasFeature("PREMIUM", "csv_export")).toBe(true);
  });

  it("les fonctionnalités PREMIUM non développées ne sont jamais présentées comme disponibles", () => {
    const premium = publicCatalog().plans.find((plan) => plan.code === "PREMIUM")!;
    const unavailable = premium.features.filter((feature) => !feature.available).map((feature) => feature.key);
    expect(unavailable).toEqual(
      expect.arrayContaining(["stock_transfers", "advanced_permissions", "advanced_reports", "activity_tracking", "organization_performance", "multi_store_dashboard"]),
    );
  });

  it("un code de forfait historique (antérieur au catalogue) est traité comme PREMIUM, signalé", () => {
    expect(resolvePlan("essentiel")).toMatchObject({ legacy: true, plan: { code: "PREMIUM" } });
    expect(resolvePlan("BUSINESS")).toMatchObject({ legacy: false, plan: { code: "BUSINESS" } });
  });
});

describe("dates : mois calendaires, essai, délai de grâce", () => {
  it("ajoute des mois calendaires en ramenant au dernier jour du mois (exemple du cahier §7.1)", () => {
    expect(addMonths(d("2026-11-30T09:00:00Z"), 3).toISOString()).toBe("2027-02-28T09:00:00.000Z");
    expect(addMonths(d("2027-11-30T09:00:00Z"), 3).toISOString()).toBe("2028-02-29T09:00:00.000Z"); // année bissextile
    expect(addMonths(d("2026-01-31T00:00:00Z"), 1).toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(addMonths(d("2026-03-15T12:30:00Z"), 12).toISOString()).toBe("2027-03-15T12:30:00.000Z");
    expect(addMonths(d("2026-12-10T00:00:00Z"), 1).toISOString()).toBe("2027-01-10T00:00:00.000Z");
  });

  it("essai : 14 jours calendaires, droits PREMIUM", () => {
    const now = d("2026-11-21T08:00:00Z");
    const trial = trialValues(now);
    expect(trial.essaiFinLe.getTime() - now.getTime()).toBe(14 * DAY_MS);
    expect(trial).toMatchObject({ plan: "PREMIUM", statut: "TRIAL", essaiDebutLe: now });
  });

  it("fin de l'essai : lecture seule immédiate, sans délai de grâce", () => {
    const trial = { ...trialValues(d("2026-11-01T00:00:00Z")), forfaitProgramme: null, forfaitProgrammeLe: null };
    expect(phaseOf(trial, d("2026-11-14T23:59:59Z"))).toBe("TRIAL");
    expect(phaseOf(trial, d("2026-11-15T00:00:00Z"))).toBe("TRIAL_ENDED");
    expect(accessFromSubscription(trial, d("2026-11-15T00:00:01Z"))).toMatchObject({ state: "READ_ONLY", canWrite: false, reason: "TRIAL_ENDED", graceEndsAt: null });
  });

  it("délai de grâce de 7 jours avec accès normal, puis lecture seule à partir du 8e jour", () => {
    const subscription = paid("BUSINESS", "2026-11-10T00:00:00Z");
    expect(graceEnd(subscription.periodeFin).toISOString()).toBe("2026-11-17T00:00:00.000Z");
    expect(phaseOf(subscription, d("2026-11-09T23:59:59Z"))).toBe("ACTIVE");
    expect(phaseOf(subscription, d("2026-11-10T00:00:00Z"))).toBe("GRACE"); // jour de l'expiration
    expect(phaseOf(subscription, d("2026-11-16T23:59:59Z"))).toBe("GRACE"); // 7e jour
    expect(phaseOf(subscription, d("2026-11-17T00:00:00Z"))).toBe("EXPIRED"); // 8e jour
    expect(accessFromSubscription(subscription, d("2026-11-16T12:00:00Z"))).toMatchObject({ state: "GRACE", canWrite: true });
    expect(accessFromSubscription(subscription, d("2026-11-17T00:00:00Z"))).toMatchObject({ state: "READ_ONLY", canWrite: false, reason: "EXPIRED" });
  });

  it("suspension administrative : lecture seule distincte de l'expiration", () => {
    const suspended = paid("PREMIUM", "2027-01-01T00:00:00Z", { statut: SubscriptionStatus.SUSPENDED });
    expect(accessFromSubscription(suspended, d("2026-11-21T00:00:00Z"))).toMatchObject({ state: "READ_ONLY", reason: "SUSPENDED" });
  });
});

describe("renouvellement (cahier §7)", () => {
  const request = { type: "PERIOD", plan: "BUSINESS", months: 3 } as const;

  it("avant l'échéance : prolonge depuis l'ancienne échéance, les jours payés ne sont pas perdus", () => {
    const subscription = paid("BUSINESS", "2026-11-30T00:00:00Z");
    const quote = quotePurchase(subscription, request, d("2026-11-20T10:00:00Z"));
    expect(quote).toMatchObject({ kind: "RENEWAL", amount: 30_000, currency: "XOF" });
    expect(quote.periodStart.toISOString()).toBe("2026-11-30T00:00:00.000Z");
    expect(quote.periodEnd.toISOString()).toBe("2027-02-28T00:00:00.000Z");
    const after = applyQuote(subscription, quote, d("2026-11-20T10:00:00Z"));
    expect(after).toMatchObject({ plan: "BUSINESS", statut: "ACTIVE", periodeDebut: subscription.periodeDebut });
    expect(after.periodeFin.toISOString()).toBe("2027-02-28T00:00:00.000Z");
  });

  it("pendant la grâce : repart de l'ancienne échéance (les jours de grâce ne sont pas ajoutés)", () => {
    const subscription = paid("BUSINESS", "2026-11-10T00:00:00Z");
    const quote = quotePurchase(subscription, request, d("2026-11-15T10:00:00Z"));
    expect(quote.kind).toBe("RENEWAL");
    expect(quote.periodStart.toISOString()).toBe("2026-11-10T00:00:00.000Z");
    expect(quote.periodEnd.toISOString()).toBe("2027-02-10T00:00:00.000Z");
  });

  it("après la grâce : la période commence à la confirmation du paiement", () => {
    const subscription = paid("BUSINESS", "2026-11-01T00:00:00Z");
    const confirmedAt = d("2026-11-21T14:00:00Z");
    const quote = quotePurchase(subscription, request, confirmedAt);
    expect(quote.periodStart).toEqual(confirmedAt);
    expect(quote.periodEnd.toISOString()).toBe("2027-02-21T14:00:00.000Z");
    expect(applyQuote(subscription, quote, confirmedAt).periodeDebut).toEqual(confirmedAt);
  });

  it("pendant l'essai : la souscription prend effet immédiatement et clôt l'essai", () => {
    const trial = { ...trialValues(d("2026-11-15T00:00:00Z")), forfaitProgramme: null, forfaitProgrammeLe: null };
    const now = d("2026-11-21T09:00:00Z");
    const quote = quotePurchase(trial, { type: "PERIOD", plan: "STARTER", months: 1 }, now);
    expect(quote).toMatchObject({ kind: "SUBSCRIPTION", amount: 7_500, periodStart: now });
    const after = applyQuote(trial, quote, now);
    expect(after).toMatchObject({ plan: "STARTER", statut: "ACTIVE", essaiFinLe: now, periodeDebut: now });
    expect(after.periodeFin.toISOString()).toBe("2026-12-21T09:00:00.000Z");
  });

  it("organisation sans abonnement : souscription à partir de maintenant", () => {
    const now = d("2026-11-21T09:00:00Z");
    expect(quotePurchase(null, { type: "PERIOD", plan: "PREMIUM", months: 12 }, now)).toMatchObject({ kind: "SUBSCRIPTION", amount: 180_000, periodStart: now });
  });

  it("abonnement suspendu par l'administration : aucun achat possible", () => {
    const suspended = paid("BUSINESS", "2027-01-01T00:00:00Z", { statut: SubscriptionStatus.SUSPENDED });
    expect(() => quotePurchase(suspended, request, d("2026-11-21T00:00:00Z"))).toThrow(expect.objectContaining({ code: "SUBSCRIPTION_SUSPENDED" }));
  });
});

describe("mise à niveau au prorata (formule validée : ⌈(Pn − Pa) × jours restants ÷ 30⌉)", () => {
  it("calcule le prorata, arrondi au franc supérieur", () => {
    expect(upgradeProrata(10_000, 15_000, 45)).toBe(7_500); // exemple documenté
    expect(upgradeProrata(7_500, 10_000, 10)).toBe(834); // 833,33 → 834
    expect(upgradeProrata(7_500, 15_000, 1)).toBe(250);
    expect(upgradeProrata(7_500, 15_000, 30)).toBe(7_500);
    expect(() => upgradeProrata(15_000, 10_000, 10)).toThrow();
    expect(() => upgradeProrata(10_000, 15_000, 0)).toThrow();
  });

  it("compte le jour entamé", () => {
    expect(remainingDays(d("2026-12-01T00:00:00Z"), d("2026-11-30T23:00:00Z"))).toBe(1);
    expect(remainingDays(d("2026-12-01T00:00:00Z"), d("2026-11-16T00:00:00Z"))).toBe(15);
    expect(remainingDays(d("2026-12-01T00:00:00Z"), d("2026-12-02T00:00:00Z"))).toBe(0);
  });

  it("applique immédiatement le nouveau forfait sans changer l'échéance", () => {
    const subscription = paid("BUSINESS", "2027-01-05T00:00:00Z");
    const now = d("2026-11-21T00:00:00Z"); // 45 jours restants
    const quote = quotePurchase(subscription, { type: "UPGRADE", plan: "PREMIUM" }, now);
    expect(quote).toMatchObject({ kind: "UPGRADE", amount: 7_500, remainingDays: 45, previousPlan: "BUSINESS" });
    const after = applyQuote(subscription, quote, now);
    expect(after).toMatchObject({ plan: "PREMIUM", periodeFin: subscription.periodeFin, periodeDebut: subscription.periodeDebut });
  });

  it("refuse une mise à niveau vers un forfait égal ou inférieur, pendant l'essai, la grâce ou avec une rétrogradation programmée", () => {
    const now = d("2026-11-21T00:00:00Z");
    const upgrade = { type: "UPGRADE", plan: "BUSINESS" } as const;
    expect(() => quotePurchase(paid("PREMIUM", "2027-01-01T00:00:00Z"), upgrade, now)).toThrow(expect.objectContaining({ code: "UPGRADE_NOT_HIGHER" }));
    expect(() => quotePurchase({ ...trialValues(now), forfaitProgramme: null }, upgrade, now)).toThrow(expect.objectContaining({ code: "UPGRADE_NOT_APPLICABLE" }));
    expect(() => quotePurchase(paid("STARTER", "2026-11-18T00:00:00Z"), upgrade, now)).toThrow(expect.objectContaining({ code: "UPGRADE_NOT_APPLICABLE" }));
    const pending = paid("BUSINESS", "2027-01-01T00:00:00Z", { forfaitProgramme: "STARTER", forfaitProgrammeLe: d("2027-01-01T00:00:00Z") });
    expect(() => quotePurchase(pending, { type: "UPGRADE", plan: "PREMIUM" }, now)).toThrow(expect.objectContaining({ code: "DOWNGRADE_PENDING" }));
  });

  it("un renouvellement anticipé vers un forfait supérieur exige d'abord la mise à niveau", () => {
    expect(() => quotePurchase(paid("STARTER", "2027-01-01T00:00:00Z"), { type: "PERIOD", plan: "PREMIUM", months: 1 }, d("2026-11-21T00:00:00Z"))).toThrow(
      expect.objectContaining({ code: "UPGRADE_REQUIRED" }),
    );
  });
});

describe("rétrogradation programmée à l'échéance", () => {
  it("est programmée à l'échéance, sans effet avant, appliquée dès l'échéance", () => {
    const subscription = paid("PREMIUM", "2026-12-15T00:00:00Z");
    const schedule = scheduleDowngrade(subscription, "STARTER", d("2026-11-21T00:00:00Z"));
    expect(schedule).toEqual({ forfaitProgramme: "STARTER", forfaitProgrammeLe: subscription.periodeFin });
    const scheduled = { ...subscription, ...schedule };
    expect(effectivePlanCode(scheduled, d("2026-12-14T23:59:59Z"))).toBe("PREMIUM");
    expect(effectivePlanCode(scheduled, d("2026-12-15T00:00:00Z"))).toBe("STARTER");
    expect(accessFromSubscription(scheduled, d("2026-12-01T00:00:00Z"))).toMatchObject({ plan: "PREMIUM", scheduledPlan: "STARTER" });
  });

  it("refuse un forfait égal ou supérieur, et hors période payée", () => {
    expect(() => scheduleDowngrade(paid("BUSINESS", "2027-01-01T00:00:00Z"), "PREMIUM", d("2026-11-21T00:00:00Z"))).toThrow(expect.objectContaining({ code: "DOWNGRADE_NOT_LOWER" }));
    expect(() => scheduleDowngrade(paid("BUSINESS", "2026-11-01T00:00:00Z"), "STARTER", d("2026-11-21T00:00:00Z"))).toThrow(expect.objectContaining({ code: "DOWNGRADE_NOT_APPLICABLE" }));
    expect(() => scheduleDowngrade(null, "STARTER", d("2026-11-21T00:00:00Z"))).toThrow(expect.objectContaining({ code: "DOWNGRADE_NOT_APPLICABLE" }));
  });

  it("renouveler à l'avance un forfait inférieur programme la rétrogradation à l'échéance actuelle", () => {
    const subscription = paid("PREMIUM", "2026-12-15T00:00:00Z");
    const now = d("2026-11-21T00:00:00Z");
    const quote = quotePurchase(subscription, { type: "PERIOD", plan: "STARTER", months: 1 }, now);
    expect(quote).toMatchObject({ kind: "RENEWAL", amount: 7_500, scheduledPlan: "STARTER", scheduledAt: subscription.periodeFin });
    const after = applyQuote(subscription, quote, now);
    expect(after).toMatchObject({ plan: "PREMIUM", forfaitProgramme: "STARTER", forfaitProgrammeLe: subscription.periodeFin });
    expect(after.periodeFin.toISOString()).toBe("2027-01-15T00:00:00.000Z");
    // Une fois une rétrogradation programmée, seul ce forfait peut être renouvelé.
    expect(() => quotePurchase({ ...subscription, ...after }, { type: "PERIOD", plan: "PREMIUM", months: 1 }, now)).toThrow(expect.objectContaining({ code: "DOWNGRADE_PENDING" }));
  });
});
