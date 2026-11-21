/**
 * PlanService — catalogue des forfaits Rayon (cahier des charges §3 et §4).
 *
 * SEULE source des prix, des quotas et des fonctionnalités : aucune autre
 * partie du code (ni le frontend, ni le mobile) ne doit coder un prix ou une
 * limite. Les clients lisent le catalogue via `GET /api/subscription`.
 *
 * Choix : catalogue en code plutôt qu'en table. Les prix sont des constantes
 * commerciales validées (toute modification passe par une revue et les
 * tests), les droits sont vérifiés à chaque requête sans lecture
 * supplémentaire en base, et le montant réellement facturé est figé sur
 * chaque paiement : changer un prix ici ne réécrit jamais l'historique.
 */

export const PLAN_CODES = ["STARTER", "BUSINESS", "PREMIUM"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

/** Durées proposées, en mois. Prix = prix mensuel × mois, sans remise. */
export const DURATIONS_MONTHS = [1, 3, 6, 12] as const;
export type DurationMonths = (typeof DURATIONS_MONTHS)[number];

export const SUBSCRIPTION_CURRENCY = "XOF";
export const TRIAL_DAYS = 14;
/** Délai de grâce après l'échéance : accès normal, puis lecture seule à partir du 8e jour. */
export const GRACE_DAYS = 7;
/** Forfait dont l'essai donne les droits. */
export const TRIAL_PLAN: PlanCode = "PREMIUM";

/**
 * Fonctionnalités identifiées par des clés stables (entitlements).
 * `available: false` : pas encore développée — affichée « à venir », jamais
 * présentée comme un avantage disponible (cahier §4.3, mission §5).
 */
export const FEATURES = {
  // STARTER
  products: { label: "Gestion des produits", plan: "STARTER", available: true },
  categories: { label: "Gestion des catégories", plan: "STARTER", available: true },
  sales: { label: "Gestion des ventes", plan: "STARTER", available: true },
  held_sales: { label: "Ventes en attente", plan: "STARTER", available: true },
  credit_sales: { label: "Ventes à crédit", plan: "STARTER", available: true },
  payments: { label: "Paiements et versements", plan: "STARTER", available: true },
  customers: { label: "Gestion des clients", plan: "STARTER", available: true },
  expenses: { label: "Gestion des dépenses", plan: "STARTER", available: true },
  product_import: { label: "Import des produits depuis Excel", plan: "STARTER", available: true },
  basic_dashboard: { label: "Tableau de bord", plan: "STARTER", available: true },
  receipts: { label: "Consultation et partage des reçus", plan: "STARTER", available: true },
  mobile_app: { label: "Application mobile", plan: "STARTER", available: true },
  // BUSINESS
  purchases: { label: "Gestion des achats", plan: "BUSINESS", available: true },
  suppliers: { label: "Fournisseurs et dettes fournisseurs", plan: "BUSINESS", available: true },
  advanced_stock: { label: "Gestion avancée des stocks (inventaires, seuils, valorisation)", plan: "BUSINESS", available: true },
  losses: { label: "Pertes et invendus", plan: "BUSINESS", available: true },
  quotes: { label: "Devis", plan: "BUSINESS", available: true },
  net_profit: { label: "Calcul des bénéfices nets", plan: "BUSINESS", available: true },
  margin_analysis: { label: "Analyse des marges", plan: "BUSINESS", available: true },
  csv_export: { label: "Export des données (CSV)", plan: "BUSINESS", available: true },
  advanced_discounts: { label: "Paramétrage avancé des remises", plan: "BUSINESS", available: true },
  // PREMIUM
  multi_store_dashboard: { label: "Tableau de bord consolidé multi-boutiques", plan: "PREMIUM", available: false },
  stock_transfers: { label: "Transferts de stock entre boutiques", plan: "PREMIUM", available: false },
  advanced_reports: { label: "Rapports avancés", plan: "PREMIUM", available: false },
  advanced_permissions: { label: "Permissions avancées", plan: "PREMIUM", available: false },
  activity_tracking: { label: "Suivi détaillé des activités", plan: "PREMIUM", available: false },
  organization_performance: { label: "Analyse globale des performances", plan: "PREMIUM", available: false },
} as const satisfies Record<string, { label: string; plan: PlanCode; available: boolean }>;

export type FeatureKey = keyof typeof FEATURES;

export type QuotaKey = "stores" | "users";

export type PlanDefinition = {
  code: PlanCode;
  name: string;
  /** Rang pour comparer deux forfaits (mise à niveau / rétrogradation). */
  rank: number;
  monthlyPrice: number;
  limits: Record<QuotaKey, number>;
};

const PLANS: Record<PlanCode, PlanDefinition> = {
  STARTER: { code: "STARTER", name: "Starter", rank: 1, monthlyPrice: 7_500, limits: { stores: 1, users: 2 } },
  BUSINESS: { code: "BUSINESS", name: "Business", rank: 2, monthlyPrice: 10_000, limits: { stores: 2, users: 5 } },
  PREMIUM: { code: "PREMIUM", name: "Premium", rank: 3, monthlyPrice: 15_000, limits: { stores: 10, users: 10 } },
};

export const QUOTA_LABELS: Record<QuotaKey, string> = { stores: "boutiques", users: "utilisateurs (propriétaire inclus)" };

export function isPlanCode(value: unknown): value is PlanCode {
  return typeof value === "string" && (PLAN_CODES as readonly string[]).includes(value);
}

export function isDuration(value: unknown): value is DurationMonths {
  return typeof value === "number" && (DURATIONS_MONTHS as readonly number[]).includes(value);
}

export function getPlan(code: PlanCode): PlanDefinition {
  return PLANS[code];
}

/**
 * Forfait d'un code enregistré. Un code inconnu (abonnement saisi avant le
 * catalogue, ex : « essentiel ») est traité comme PREMIUM : aucun client
 * existant ne perd de droits à cause du catalogue. Signalé par `legacy`.
 */
export function resolvePlan(code: string | null | undefined): { plan: PlanDefinition; legacy: boolean } {
  return isPlanCode(code) ? { plan: PLANS[code], legacy: false } : { plan: PLANS.PREMIUM, legacy: true };
}

/** Montant d'une période : prix mensuel × nombre de mois, aucune remise. */
export function periodPrice(code: PlanCode, months: DurationMonths): number {
  return PLANS[code].monthlyPrice * months;
}

/** Un forfait inclut les fonctionnalités de son niveau et des niveaux inférieurs. */
export function planHasFeature(code: PlanCode, feature: FeatureKey): boolean {
  return PLANS[FEATURES[feature].plan].rank <= PLANS[code].rank;
}

/** Catalogue public (affichage des forfaits et de la comparaison). */
export function publicCatalog() {
  return {
    currency: SUBSCRIPTION_CURRENCY,
    trialDays: TRIAL_DAYS,
    graceDays: GRACE_DAYS,
    durations: [...DURATIONS_MONTHS],
    plans: PLAN_CODES.map((code) => {
      const plan = PLANS[code];
      return {
        code,
        name: plan.name,
        monthlyPrice: plan.monthlyPrice,
        prices: DURATIONS_MONTHS.map((months) => ({ months, amount: periodPrice(code, months) })),
        limits: plan.limits,
        features: (Object.keys(FEATURES) as FeatureKey[]).map((key) => ({
          key,
          label: FEATURES[key].label,
          included: planHasFeature(code, key),
          available: FEATURES[key].available,
        })),
      };
    }),
  };
}
