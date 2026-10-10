import { requestCache } from "@/lib/http/context";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { toNumber } from "@/lib/money";

/**
 * Statistiques de la plateforme, toutes organisations confondues. Réservé au
 * super administrateur : ces fonctions ne filtrent volontairement PAS par
 * `organisationId`, l'appelant doit donc avoir passé `requireSuperAdmin()`.
 *
 * Règles de calcul :
 * - seules les ventes terminées (COMPLETED) comptent dans le chiffre d'affaires ;
 * - chaque organisation a sa propre devise : les montants ne sont jamais
 *   additionnés d'une devise à l'autre, le chiffre d'affaires est toujours
 *   calculé pour UNE devise ; les nombres de ventes, eux, sont globaux ;
 * - les périodes sont découpées en jours UTC (les dates sont stockées en UTC).
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Sans activité depuis ce nombre de jours, une boutique est dite « inactive ». */
export const INACTIVITY_DAYS = 30;
/** Délai laissé à une nouvelle boutique avant de signaler qu'elle n'a rien vendu. */
const NO_SALE_GRACE_DAYS = 7;

export const PLATFORM_RANGES = ["today", "7d", "30d", "90d"] as const;
export type PlatformRange = (typeof PLATFORM_RANGES)[number];

export const RANGE_LABELS: Record<PlatformRange, string> = {
  today: "Aujourd'hui",
  "7d": "7 derniers jours",
  "30d": "30 derniers jours",
  "90d": "90 derniers jours",
};

export function parseRange(value: unknown): PlatformRange {
  return PLATFORM_RANGES.includes(value as PlatformRange) ? (value as PlatformRange) : "30d";
}

/**
 * Date passée à une requête SQL brute. Les colonnes sont des `timestamp`
 * sans fuseau contenant de l'UTC : on envoie donc un texte UTC converti en
 * `timestamp`, ce qui évite toute conversion selon le fuseau de la session.
 */
export function sqlTimestamp(date: Date) {
  return Prisma.sql`${date.toISOString().replace("T", " ").replace("Z", "")}::timestamp`;
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Variation en % ; null quand il n'y a rien à comparer. */
function percentChange(current: number, previous: number): number | null {
  return previous > 0 ? ((current - previous) / previous) * 100 : null;
}

/**
 * Bornes de la période affichée et de la période de comparaison : même durée
 * écoulée juste avant (ex : les 30 jours précédents, arrêtés à la même heure),
 * pour ne pas comparer une période entamée à une période complète.
 */
function resolvePeriod(range: PlatformRange, now: Date) {
  const today = startOfUtcDay(now);
  const days = range === "today" ? 1 : Number.parseInt(range, 10);
  const start = new Date(today.getTime() - (days - 1) * DAY_MS);
  const previousStart = new Date(start.getTime() - days * DAY_MS);
  const previousEnd = new Date(previousStart.getTime() + (now.getTime() - start.getTime()));
  return { start, previousStart, previousEnd, days, bucket: range === "today" ? ("hour" as const) : ("day" as const) };
}

/** Dernière activité d'une organisation `o` : dernière vente ou dernière requête d'un de ses membres. */
export const ORGANIZATION_LAST_ACTIVITY_SQL = Prisma.sql`GREATEST(
  (SELECT MAX(v."creeLe") FROM "Vente" v WHERE v."organisationId" = o."id"),
  (SELECT MAX(u."derniereActiviteLe") FROM "Membre" m JOIN "Utilisateur" u ON u."id" = m."utilisateurId" WHERE m."organisationId" = o."id")
)`;

export type OrganizationStatus = "active" | "inactive" | "suspended";

export function organizationStatus(actif: boolean, lastActivity: Date | null, now = new Date()): OrganizationStatus {
  if (!actif) return "suspended";
  if (lastActivity && now.getTime() - lastActivity.getTime() <= INACTIVITY_DAYS * DAY_MS) return "active";
  return "inactive";
}

// ---------------------------------------------------------------------------
// Devises et chiffre d'affaires
// ---------------------------------------------------------------------------

type RevenueRow = {
  currency: string;
  organizations: number;
  allTime: number;
  allTimeCount: number;
  today: number;
  todayCount: number;
  month: number;
  previousMonth: number;
  period: number;
  periodCount: number;
  previousPeriod: number;
  previousPeriodCount: number;
};

/** Une ligne par devise utilisée sur la plateforme, la plus répandue en premier. */
async function getRevenueByCurrency(range: PlatformRange, now: Date) {
  const period = resolvePeriod(range, now);
  const today = startOfUtcDay(now);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const previousMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  // Même durée écoulée sur le mois précédent, sans déborder sur le mois courant.
  const previousMonthEnd = new Date(
    Math.min(previousMonthStart.getTime() + (now.getTime() - monthStart.getTime()), monthStart.getTime()),
  );

  return prisma.$queryRaw<RevenueRow[]>`
    SELECT
      o."devise" AS "currency",
      (COUNT(DISTINCT o."id"))::int AS "organizations",
      COALESCE(SUM(v."total"), 0)::float8 AS "allTime",
      (COUNT(v."id"))::int AS "allTimeCount",
      COALESCE(SUM(v."total") FILTER (WHERE v."creeLe" >= ${sqlTimestamp(today)}), 0)::float8 AS "today",
      (COUNT(v."id") FILTER (WHERE v."creeLe" >= ${sqlTimestamp(today)}))::int AS "todayCount",
      COALESCE(SUM(v."total") FILTER (WHERE v."creeLe" >= ${sqlTimestamp(monthStart)}), 0)::float8 AS "month",
      COALESCE(SUM(v."total") FILTER (
        WHERE v."creeLe" >= ${sqlTimestamp(previousMonthStart)} AND v."creeLe" < ${sqlTimestamp(previousMonthEnd)}
      ), 0)::float8 AS "previousMonth",
      COALESCE(SUM(v."total") FILTER (WHERE v."creeLe" >= ${sqlTimestamp(period.start)}), 0)::float8 AS "period",
      (COUNT(v."id") FILTER (WHERE v."creeLe" >= ${sqlTimestamp(period.start)}))::int AS "periodCount",
      COALESCE(SUM(v."total") FILTER (
        WHERE v."creeLe" >= ${sqlTimestamp(period.previousStart)} AND v."creeLe" < ${sqlTimestamp(period.previousEnd)}
      ), 0)::float8 AS "previousPeriod",
      (COUNT(v."id") FILTER (
        WHERE v."creeLe" >= ${sqlTimestamp(period.previousStart)} AND v."creeLe" < ${sqlTimestamp(period.previousEnd)}
      ))::int AS "previousPeriodCount"
    FROM "Organisation" o
    LEFT JOIN "Vente" v ON v."organisationId" = o."id" AND v."statut" = 'COMPLETED'
    GROUP BY o."devise"
    ORDER BY "organizations" DESC, "allTime" DESC, o."devise" ASC
  `;
}

// ---------------------------------------------------------------------------
// Séries temporelles
// ---------------------------------------------------------------------------

export type SeriesPoint = { day: string; value: number; count: number };

/** CA (dans la devise choisie) et nombre de ventes (toutes devises) par jour, ou par heure pour « aujourd'hui ». */
async function getSalesSeries(range: PlatformRange, currency: string, now: Date): Promise<SeriesPoint[]> {
  const period = resolvePeriod(range, now);
  const rows = await prisma.$queryRaw<{ bucket: string; revenue: number; count: number }[]>`
    SELECT
      to_char(date_trunc(${Prisma.raw(`'${period.bucket}'`)}, v."creeLe"), 'YYYY-MM-DD"T"HH24:MI:SS') AS "bucket",
      COALESCE(SUM(v."total") FILTER (WHERE o."devise" = ${currency}), 0)::float8 AS "revenue",
      (COUNT(*))::int AS "count"
    FROM "Vente" v
    JOIN "Organisation" o ON o."id" = v."organisationId"
    WHERE v."statut" = 'COMPLETED' AND v."creeLe" >= ${sqlTimestamp(period.start)}
    GROUP BY 1
  `;
  const byBucket = new Map(rows.map((row) => [new Date(`${row.bucket}Z`).getTime(), row]));

  const step = period.bucket === "hour" ? HOUR_MS : DAY_MS;
  const length = period.bucket === "hour" ? 24 : period.days;
  return Array.from({ length }, (_, index) => {
    const date = new Date(period.start.getTime() + index * step);
    const row = byBucket.get(date.getTime());
    const day =
      period.bucket === "hour"
        ? `${String(date.getUTCHours()).padStart(2, "0")} h`
        : date.toLocaleDateString(
            "fr-FR",
            period.days <= 7
              ? { weekday: "short", day: "numeric", timeZone: "UTC" }
              : { day: "numeric", month: "short", timeZone: "UTC" },
          );
    return { day, value: row?.revenue ?? 0, count: row?.count ?? 0 };
  });
}

// ---------------------------------------------------------------------------
// Alertes (points nécessitant l'attention du super administrateur)
// ---------------------------------------------------------------------------

export type PlatformAlert = {
  key: "inactive" | "noSales" | "suspended" | "onboarding";
  tone: "warning" | "danger" | "neutral";
  count: number;
  title: string;
  description: string;
  href: string;
};

/** Mis en cache pour la durée d'une requête. */
export const getPlatformAlerts = requestCache(async (): Promise<PlatformAlert[]> => {
  const now = new Date();
  const inactiveSince = new Date(now.getTime() - INACTIVITY_DAYS * DAY_MS);
  const graceLimit = new Date(now.getTime() - NO_SALE_GRACE_DAYS * DAY_MS);
  const onboardingLimit = new Date(now.getTime() - DAY_MS);

  const [[organizations], pendingOnboarding] = await Promise.all([
    prisma.$queryRaw<{ inactive: number; noSales: number; suspended: number }[]>`
      SELECT
        (COUNT(*) FILTER (
          WHERE x."actif" AND x."sales" > 0 AND (x."lastActivity" IS NULL OR x."lastActivity" < ${sqlTimestamp(inactiveSince)})
        ))::int AS "inactive",
        (COUNT(*) FILTER (WHERE x."actif" AND x."sales" = 0 AND x."creeLe" < ${sqlTimestamp(graceLimit)}))::int AS "noSales",
        (COUNT(*) FILTER (WHERE NOT x."actif"))::int AS "suspended"
      FROM (
        SELECT
          o."actif",
          o."creeLe",
          (SELECT COUNT(*) FROM "Vente" v WHERE v."organisationId" = o."id") AS "sales",
          ${ORGANIZATION_LAST_ACTIVITY_SQL} AS "lastActivity"
        FROM "Organisation" o
      ) x
    `,
    prisma.utilisateur.count({
      where: { superAdmin: false, membre: null, creeLe: { lt: onboardingLimit } },
    }),
  ]);

  const plural = (count: number, one: string, many: string) => (count > 1 ? many : one);
  const alerts: PlatformAlert[] = [
    {
      key: "inactive",
      tone: "warning",
      count: organizations.inactive,
      title: `${organizations.inactive} ${plural(organizations.inactive, "boutique inactive", "boutiques inactives")}`,
      description: `Aucune activité depuis plus de ${INACTIVITY_DAYS} jours.`,
      href: "/admin/boutiques?status=inactive",
    },
    {
      key: "noSales",
      tone: "warning",
      count: organizations.noSales,
      title: `${organizations.noSales} ${plural(organizations.noSales, "boutique n'a", "boutiques n'ont")} jamais vendu`,
      description: `Inscrites depuis plus de ${NO_SALE_GRACE_DAYS} jours, sans aucune vente enregistrée.`,
      href: "/admin/boutiques?status=nosales",
    },
    {
      key: "onboarding",
      tone: "neutral",
      count: pendingOnboarding,
      title: `${pendingOnboarding} ${plural(pendingOnboarding, "inscription inachevée", "inscriptions inachevées")}`,
      description: "Comptes créés depuis plus de 24 h sans boutique configurée.",
      href: "/admin/utilisateurs?status=onboarding",
    },
    {
      key: "suspended",
      tone: "danger",
      count: organizations.suspended,
      title: `${organizations.suspended} ${plural(organizations.suspended, "boutique suspendue", "boutiques suspendues")}`,
      description: "Accès coupé par l'administration de la plateforme.",
      href: "/admin/boutiques?status=suspended",
    },
  ];
  return alerts.filter((alert) => alert.count > 0);
});

// ---------------------------------------------------------------------------
// Vue d'ensemble (page d'accueil du super administrateur)
// ---------------------------------------------------------------------------

export type PlatformOverview = Awaited<ReturnType<typeof getPlatformOverview>>;

/**
 * Tous les chiffres de la page d'accueil en un seul appel : six requêtes
 * agrégées exécutées en parallèle, quel que soit le nombre de cartes.
 */
export async function getPlatformOverview(options: { range?: PlatformRange; currency?: string } = {}) {
  const range = options.range ?? "30d";
  const now = new Date();
  const period = resolvePeriod(range, now);
  const inactiveSince = new Date(now.getTime() - INACTIVITY_DAYS * DAY_MS);

  const [revenueRows, [organizations], [users], products, stores, topOrganizations, topProducts] = await Promise.all([
    getRevenueByCurrency(range, now),
    prisma.$queryRaw<
      { total: number; suspended: number; active: number; inactive: number; created: number; previousCreated: number }[]
    >`
      SELECT
        (COUNT(*))::int AS "total",
        (COUNT(*) FILTER (WHERE NOT x."actif"))::int AS "suspended",
        (COUNT(*) FILTER (WHERE x."actif" AND x."lastActivity" >= ${sqlTimestamp(inactiveSince)}))::int AS "active",
        (COUNT(*) FILTER (
          WHERE x."actif" AND (x."lastActivity" IS NULL OR x."lastActivity" < ${sqlTimestamp(inactiveSince)})
        ))::int AS "inactive",
        (COUNT(*) FILTER (WHERE x."creeLe" >= ${sqlTimestamp(period.start)}))::int AS "created",
        (COUNT(*) FILTER (
          WHERE x."creeLe" >= ${sqlTimestamp(period.previousStart)} AND x."creeLe" < ${sqlTimestamp(period.previousEnd)}
        ))::int AS "previousCreated"
      FROM (
        SELECT o."actif", o."creeLe", ${ORGANIZATION_LAST_ACTIVITY_SQL} AS "lastActivity" FROM "Organisation" o
      ) x
    `,
    prisma.$queryRaw<{ total: number; active: number; created: number; disabled: number }[]>`
      SELECT
        (COUNT(*))::int AS "total",
        (COUNT(*) FILTER (WHERE u."actif" AND u."derniereActiviteLe" >= ${sqlTimestamp(inactiveSince)}))::int AS "active",
        (COUNT(*) FILTER (WHERE u."creeLe" >= ${sqlTimestamp(period.start)}))::int AS "created",
        (COUNT(*) FILTER (WHERE NOT u."actif"))::int AS "disabled"
      FROM "Utilisateur" u
      WHERE NOT u."superAdmin"
    `,
    prisma.produit.count({ where: { actif: true } }),
    prisma.boutique.count(),
    prisma.$queryRaw<{ id: number; name: string; currency: string; revenue: number; sales: number }[]>`
      SELECT o."id", o."nom" AS "name", o."devise" AS "currency",
        COALESCE(SUM(v."total"), 0)::float8 AS "revenue", (COUNT(*))::int AS "sales"
      FROM "Vente" v
      JOIN "Organisation" o ON o."id" = v."organisationId"
      WHERE v."statut" = 'COMPLETED' AND v."creeLe" >= ${sqlTimestamp(period.start)}
      GROUP BY o."id"
      ORDER BY "sales" DESC, "revenue" DESC
      LIMIT 5
    `,
    prisma.$queryRaw<
      { id: number; name: string; unit: string; organization: string; currency: string; quantity: number; amount: number }[]
    >`
      SELECT p."id", p."nom" AS "name", p."unite" AS "unit", o."nom" AS "organization", o."devise" AS "currency",
        (SUM(l."quantite"))::int AS "quantity", COALESCE(SUM(l."sousTotal"), 0)::float8 AS "amount"
      FROM "LigneVente" l
      JOIN "Vente" v ON v."id" = l."venteId"
      JOIN "Produit" p ON p."id" = l."produitId"
      JOIN "Organisation" o ON o."id" = v."organisationId"
      WHERE v."statut" = 'COMPLETED' AND v."creeLe" >= ${sqlTimestamp(period.start)}
      GROUP BY p."id", o."id"
      ORDER BY "quantity" DESC
      LIMIT 5
    `,
  ]);

  const currencies = revenueRows.map((row) => row.currency);
  const currency = options.currency && currencies.includes(options.currency) ? options.currency : (currencies[0] ?? "XOF");
  const revenue = revenueRows.find((row) => row.currency === currency);
  const sum = (key: "allTimeCount" | "todayCount" | "periodCount" | "previousPeriodCount") =>
    revenueRows.reduce((total, row) => total + row[key], 0);

  const series = await getSalesSeries(range, currency, now);

  return {
    range,
    period: { start: period.start, end: now },
    /** Devise des montants affichés, et devises disponibles (une par devise d'organisation). */
    currency,
    currencies,
    organizations,
    users,
    products,
    stores,
    revenue: {
      allTime: revenue?.allTime ?? 0,
      today: revenue?.today ?? 0,
      month: revenue?.month ?? 0,
      monthChange: percentChange(revenue?.month ?? 0, revenue?.previousMonth ?? 0),
      period: revenue?.period ?? 0,
      periodChange: percentChange(revenue?.period ?? 0, revenue?.previousPeriod ?? 0),
      /** Nombre d'organisations qui facturent dans cette devise. */
      organizations: revenue?.organizations ?? 0,
    },
    /** Nombres de ventes terminées, toutes devises confondues. */
    sales: {
      allTime: sum("allTimeCount"),
      today: sum("todayCount"),
      period: sum("periodCount"),
      periodChange: percentChange(sum("periodCount"), sum("previousPeriodCount")),
    },
    series,
    topOrganizations,
    topProducts,
  };
}

// ---------------------------------------------------------------------------
// Statistiques détaillées
// ---------------------------------------------------------------------------

const SIGNUP_WEEKS = 12;

export type PlatformAnalytics = Awaited<ReturnType<typeof getPlatformAnalytics>>;

export async function getPlatformAnalytics(options: { range?: PlatformRange; currency?: string } = {}) {
  const range = options.range ?? "30d";
  const now = new Date();
  const period = resolvePeriod(range, now);

  // Lundi (UTC) de la semaine courante, puis 11 semaines en arrière.
  const today = startOfUtcDay(now);
  const monday = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY_MS);
  const signupStart = new Date(monday.getTime() - (SIGNUP_WEEKS - 1) * 7 * DAY_MS);

  const revenueRows = await getRevenueByCurrency(range, now);
  const currencies = revenueRows.map((row) => row.currency);
  const currency = options.currency && currencies.includes(options.currency) ? options.currency : (currencies[0] ?? "XOF");
  const revenue = revenueRows.find((row) => row.currency === currency);

  const [series, paymentMethods, ranking, [cancellations], organizationSignups, userSignups] = await Promise.all([
    getSalesSeries(range, currency, now),
    prisma.$queryRaw<{ method: string; count: number; revenue: number }[]>`
      SELECT v."modePaiement"::text AS "method", (COUNT(*))::int AS "count",
        COALESCE(SUM(v."total") FILTER (WHERE o."devise" = ${currency}), 0)::float8 AS "revenue"
      FROM "Vente" v
      JOIN "Organisation" o ON o."id" = v."organisationId"
      WHERE v."statut" = 'COMPLETED' AND v."creeLe" >= ${sqlTimestamp(period.start)}
      GROUP BY 1
      ORDER BY "count" DESC
    `,
    prisma.$queryRaw<
      { id: number; name: string; currency: string; actif: boolean; revenue: number; sales: number; lastActivity: Date | null }[]
    >`
      SELECT o."id", o."nom" AS "name", o."devise" AS "currency", o."actif",
        COALESCE(SUM(v."total"), 0)::float8 AS "revenue", (COUNT(*))::int AS "sales",
        ${ORGANIZATION_LAST_ACTIVITY_SQL} AS "lastActivity"
      FROM "Vente" v
      JOIN "Organisation" o ON o."id" = v."organisationId"
      WHERE v."statut" = 'COMPLETED' AND v."creeLe" >= ${sqlTimestamp(period.start)}
      GROUP BY o."id"
      ORDER BY "sales" DESC, "revenue" DESC
      LIMIT 10
    `,
    prisma.$queryRaw<{ cancelled: number; total: number }[]>`
      SELECT (COUNT(*) FILTER (WHERE v."statut" = 'CANCELLED'))::int AS "cancelled", (COUNT(*))::int AS "total"
      FROM "Vente" v
      WHERE v."creeLe" >= ${sqlTimestamp(period.start)}
    `,
    prisma.$queryRaw<{ week: string; count: number }[]>`
      SELECT to_char(date_trunc('week', o."creeLe"), 'YYYY-MM-DD') AS "week", (COUNT(*))::int AS "count"
      FROM "Organisation" o WHERE o."creeLe" >= ${sqlTimestamp(signupStart)} GROUP BY 1
    `,
    prisma.$queryRaw<{ week: string; count: number }[]>`
      SELECT to_char(date_trunc('week', u."creeLe"), 'YYYY-MM-DD') AS "week", (COUNT(*))::int AS "count"
      FROM "Utilisateur" u WHERE NOT u."superAdmin" AND u."creeLe" >= ${sqlTimestamp(signupStart)} GROUP BY 1
    `,
  ]);

  const organizationsByWeek = new Map(organizationSignups.map((row) => [row.week, row.count]));
  const usersByWeek = new Map(userSignups.map((row) => [row.week, row.count]));
  const signups = Array.from({ length: SIGNUP_WEEKS }, (_, index) => {
    const date = new Date(signupStart.getTime() + index * 7 * DAY_MS);
    const key = date.toISOString().slice(0, 10);
    return {
      week: date.toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" }),
      organizations: organizationsByWeek.get(key) ?? 0,
      users: usersByWeek.get(key) ?? 0,
    };
  });

  const periodCount = revenueRows.reduce((total, row) => total + row.periodCount, 0);
  const previousPeriodCount = revenueRows.reduce((total, row) => total + row.previousPeriodCount, 0);
  const currencyPeriodCount = revenue?.periodCount ?? 0;

  return {
    range,
    period: { start: period.start, end: now },
    currency,
    currencies,
    revenue: {
      period: revenue?.period ?? 0,
      periodChange: percentChange(revenue?.period ?? 0, revenue?.previousPeriod ?? 0),
      /** Panier moyen des ventes facturées dans la devise affichée. */
      averageBasket: currencyPeriodCount > 0 ? (revenue?.period ?? 0) / currencyPeriodCount : 0,
    },
    sales: {
      period: periodCount,
      periodChange: percentChange(periodCount, previousPeriodCount),
      cancelled: cancellations.cancelled,
      /** Part des ventes de la période qui ont été annulées, en % ; null sans vente. */
      cancellationRate: cancellations.total > 0 ? (cancellations.cancelled / cancellations.total) * 100 : null,
    },
    series,
    paymentMethods,
    ranking: ranking.map((row) => ({
      ...row,
      averageBasket: row.sales > 0 ? row.revenue / row.sales : 0,
      status: organizationStatus(row.actif, row.lastActivity, now),
    })),
    signups,
  };
}

// ---------------------------------------------------------------------------
// Activité récente
// ---------------------------------------------------------------------------

export const ACTIVITY_KINDS = ["organization", "user", "product", "sale", "admin"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = {
  organization: "Boutiques créées",
  user: "Inscriptions",
  product: "Produits ajoutés",
  sale: "Ventes",
  admin: "Actions d'administration",
};

export type ActivityEvent = {
  /** Identifiant stable, unique dans le flux. */
  id: string;
  kind: ActivityKind;
  icon: string;
  tone: "brand" | "success" | "danger" | "warning" | "neutral";
  title: string;
  subtitle: string;
  date: Date;
  organization: { id: number; name: string } | null;
  amount?: { value: number; currency: string; cancelled: boolean };
};

/** Actions du journal d'audit affichées dans le flux, avec leur libellé. */
const AUDIT_EVENTS: Record<string, { title: string; icon: string; tone: ActivityEvent["tone"] }> = {
  "organization.suspended": { title: "Boutique suspendue", icon: "ban", tone: "danger" },
  "organization.reactivated": { title: "Boutique réactivée", icon: "checkCircle", tone: "success" },
  "user.deactivated": { title: "Compte utilisateur désactivé", icon: "ban", tone: "danger" },
  "user.reactivated": { title: "Compte utilisateur réactivé", icon: "checkCircle", tone: "success" },
  "member.removed": { title: "Membre retiré d'une boutique", icon: "user", tone: "warning" },
};

/** Personne visée par l'action, quand le journal l'a notée (« Awa Ba · »). */
function auditTarget(metadata: unknown) {
  const target = (metadata as { cible?: unknown } | null)?.cible;
  return typeof target === "string" ? `${target} · ` : "";
}

const saleNumber = (id: number) => `#${String(id).padStart(5, "0")}`;
const fullName = (user: { prenom: string; nom: string } | null) => (user ? `${user.prenom} ${user.nom}` : "Compte supprimé");

/**
 * Flux d'événements réels de la plateforme, du plus récent au plus ancien,
 * reconstitué à partir des tables existantes (pas de table d'événements
 * dédiée). Pagination par curseur : passer `before` = date du dernier
 * événement reçu pour obtenir la page suivante.
 */
export async function getPlatformActivity(
  options: { limit?: number; before?: Date; kind?: ActivityKind; organizationId?: number } = {},
) {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const { before, kind, organizationId } = options;
  const wants = (candidate: ActivityKind) => !kind || kind === candidate;
  const dateFilter = before ? { lt: before } : undefined;
  const organisation = { select: { id: true, nom: true, devise: true } };

  // Chaque source renvoie au plus `limit` lignes : après fusion, les `limit`
  // premières sont forcément les bonnes.
  const [organizations, users, products, sales, cancelledSales, audits] = await Promise.all([
    wants("organization")
      ? prisma.organisation.findMany({
          where: { creeLe: dateFilter, ...(organizationId ? { id: organizationId } : {}) },
          orderBy: { creeLe: "desc" },
          take: limit,
          select: { id: true, nom: true, creeLe: true },
        })
      : [],
    wants("user")
      ? prisma.utilisateur.findMany({
          where: {
            superAdmin: false,
            creeLe: dateFilter,
            ...(organizationId ? { membre: { organisationId: organizationId } } : {}),
          },
          orderBy: { creeLe: "desc" },
          take: limit,
          select: { id: true, prenom: true, nom: true, creeLe: true, membre: { select: { organisation } } },
        })
      : [],
    wants("product")
      ? prisma.produit.findMany({
          where: { creeLe: dateFilter, ...(organizationId ? { organisationId: organizationId } : {}) },
          orderBy: { creeLe: "desc" },
          take: limit,
          select: { id: true, nom: true, creeLe: true, organisation },
        })
      : [],
    wants("sale")
      ? prisma.vente.findMany({
          where: { creeLe: dateFilter, ...(organizationId ? { organisationId: organizationId } : {}) },
          orderBy: { creeLe: "desc" },
          take: limit,
          select: {
            id: true,
            total: true,
            statut: true,
            creeLe: true,
            organisation,
            boutique: { select: { nom: true } },
            vendeur: { select: { prenom: true, nom: true } },
          },
        })
      : [],
    wants("sale")
      ? prisma.vente.findMany({
          where: {
            annuleLe: before ? { lt: before } : { not: null },
            ...(organizationId ? { organisationId: organizationId } : {}),
          },
          orderBy: { annuleLe: "desc" },
          take: limit,
          select: { id: true, total: true, annuleLe: true, organisation, boutique: { select: { nom: true } } },
        })
      : [],
    wants("admin")
      ? prisma.journalAudit.findMany({
          where: {
            action: { in: Object.keys(AUDIT_EVENTS) },
            creeLe: dateFilter,
            ...(organizationId ? { organisationId: organizationId } : {}),
          },
          orderBy: { creeLe: "desc" },
          take: limit,
          select: {
            id: true,
            action: true,
            metadonnees: true,
            creeLe: true,
            organisation,
            utilisateur: { select: { prenom: true, nom: true } },
          },
        })
      : [],
  ]);

  const events: ActivityEvent[] = [
    ...organizations.map((item) => ({
      id: `organization-${item.id}`,
      kind: "organization" as const,
      icon: "store",
      tone: "brand" as const,
      title: "Nouvelle boutique créée",
      subtitle: item.nom,
      date: item.creeLe,
      organization: { id: item.id, name: item.nom },
    })),
    ...users.map((item) => ({
      id: `user-${item.id}`,
      kind: "user" as const,
      icon: "user",
      tone: "neutral" as const,
      title: "Nouvel utilisateur inscrit",
      subtitle: `${fullName(item)} · ${item.membre?.organisation.nom ?? "sans boutique"}`,
      date: item.creeLe,
      organization: item.membre ? { id: item.membre.organisation.id, name: item.membre.organisation.nom } : null,
    })),
    ...products.map((item) => ({
      id: `product-${item.id}`,
      kind: "product" as const,
      icon: "box",
      tone: "neutral" as const,
      title: "Produit ajouté",
      subtitle: `${item.nom} · ${item.organisation.nom}`,
      date: item.creeLe,
      organization: { id: item.organisation.id, name: item.organisation.nom },
    })),
    ...sales.map((item) => ({
      id: `sale-${item.id}`,
      kind: "sale" as const,
      icon: "receipt",
      tone: "success" as const,
      title: `Vente ${saleNumber(item.id)} enregistrée`,
      subtitle: `${item.organisation.nom} · ${item.boutique.nom} · ${fullName(item.vendeur)}`,
      date: item.creeLe,
      organization: { id: item.organisation.id, name: item.organisation.nom },
      amount: { value: toNumber(item.total), currency: item.organisation.devise, cancelled: item.statut === "CANCELLED" },
    })),
    ...cancelledSales.map((item) => ({
      id: `sale-cancelled-${item.id}`,
      kind: "sale" as const,
      icon: "xCircle",
      tone: "danger" as const,
      title: `Vente ${saleNumber(item.id)} annulée`,
      subtitle: `${item.organisation.nom} · ${item.boutique.nom}`,
      // `annuleLe` est filtré non nul par la requête.
      date: item.annuleLe as Date,
      organization: { id: item.organisation.id, name: item.organisation.nom },
      amount: { value: toNumber(item.total), currency: item.organisation.devise, cancelled: true },
    })),
    ...audits.map((item) => ({
      id: `audit-${item.id}`,
      kind: "admin" as const,
      icon: AUDIT_EVENTS[item.action].icon,
      tone: AUDIT_EVENTS[item.action].tone,
      title: AUDIT_EVENTS[item.action].title,
      subtitle: `${auditTarget(item.metadonnees)}${item.organisation.nom} · par ${fullName(item.utilisateur)}`,
      date: item.creeLe,
      organization: { id: item.organisation.id, name: item.organisation.nom },
    })),
  ]
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(0, limit);

  return {
    events,
    /** Curseur de la page suivante ; null quand le flux est épuisé. */
    nextBefore: events.length === limit ? events[events.length - 1].date : null,
  };
}

/** Lit `kind`, `before`, `limit` et `organizationId` depuis une URL (page ou route API). */
export function parseActivityQuery(searchParams: URLSearchParams) {
  const kind = searchParams.get("kind");
  const before = new Date(searchParams.get("before") ?? "");
  const organizationId = Number(searchParams.get("organizationId"));
  return {
    limit: Number(searchParams.get("limit")) || 20,
    kind: ACTIVITY_KINDS.includes(kind as ActivityKind) ? (kind as ActivityKind) : undefined,
    before: Number.isNaN(before.getTime()) ? undefined : before,
    organizationId: Number.isSafeInteger(organizationId) && organizationId > 0 ? organizationId : undefined,
  };
}
