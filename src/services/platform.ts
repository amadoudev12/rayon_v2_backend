import { requestCache } from "@/lib/http/context";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";

/**
 * Supervision de la plateforme, toutes organisations confondues. Réservé au
 * super administrateur : ces fonctions ne filtrent volontairement PAS par
 * `organisationId`, l'appelant doit donc avoir passé `requireSuperAdmin()`.
 *
 * CONFIDENTIALITÉ DES COMMERÇANTS : le super administrateur gère les comptes,
 * il ne voit PAS l'activité commerciale des boutiques. Aucune fonction de ce
 * fichier ne renvoie de chiffre d'affaires, de nombre ou de montant de
 * ventes, de produits, de clients, d'achats ni de moyens de paiement. Seule
 * la date de dernière activité d'une boutique est exposée (« il y a 3 h »).
 */

const DAY_MS = 86_400_000;

/** Sans activité depuis ce nombre de jours, une boutique est dite « inactive ». */
export const INACTIVITY_DAYS = 30;
/** Délai laissé à une nouvelle boutique avant de la signaler comme jamais utilisée. */
const NEVER_USED_GRACE_DAYS = 7;

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

/** Début de la période affichée (jours UTC) et de la période précédente de même durée. */
function resolvePeriod(range: PlatformRange, now: Date) {
  const today = startOfUtcDay(now);
  const days = range === "today" ? 1 : Number.parseInt(range, 10);
  const start = new Date(today.getTime() - (days - 1) * DAY_MS);
  const previousStart = new Date(start.getTime() - days * DAY_MS);
  return { start, previousStart };
}

/**
 * Dernière activité d'une organisation `o` : dernière opération enregistrée
 * ou dernière requête d'un de ses membres. Seule la DATE est exposée.
 */
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
// Alertes (points nécessitant l'attention du super administrateur)
// ---------------------------------------------------------------------------

export type PlatformAlert = {
  key: "inactive" | "neverUsed" | "suspended" | "onboarding" | "paymentsToConfirm" | "paymentsToReview";
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
  const graceLimit = new Date(now.getTime() - NEVER_USED_GRACE_DAYS * DAY_MS);
  const onboardingLimit = new Date(now.getTime() - DAY_MS);

  const [[organizations], pendingOnboarding, paymentsToConfirm, paymentsToReview] = await Promise.all([
    prisma.$queryRaw<{ inactive: number; neverUsed: number; suspended: number }[]>`
      SELECT
        (COUNT(*) FILTER (WHERE x."actif" AND x."lastActivity" < ${sqlTimestamp(inactiveSince)}))::int AS "inactive",
        (COUNT(*) FILTER (WHERE x."actif" AND x."lastActivity" IS NULL AND x."creeLe" < ${sqlTimestamp(graceLimit)}))::int AS "neverUsed",
        (COUNT(*) FILTER (WHERE NOT x."actif"))::int AS "suspended"
      FROM (
        SELECT o."actif", o."creeLe", ${ORGANIZATION_LAST_ACTIVITY_SQL} AS "lastActivity" FROM "Organisation" o
      ) x
    `,
    prisma.utilisateur.count({
      where: { superAdmin: false, membre: null, creeLe: { lt: onboardingLimit } },
    }),
    // Abonnements : paiements hors ligne en attente de confirmation, et incohérences à traiter.
    prisma.paiementAbonnement.count({ where: { statut: "PENDING", paiementRecuLe: null } }),
    prisma.paiementAbonnement.count({ where: { OR: [{ statut: "UNDER_REVIEW" }, { statut: "PENDING", paiementRecuLe: { not: null } }] } }),
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
      key: "neverUsed",
      tone: "warning",
      count: organizations.neverUsed,
      title: `${organizations.neverUsed} ${plural(organizations.neverUsed, "boutique jamais utilisée", "boutiques jamais utilisées")}`,
      description: `Inscrites depuis plus de ${NEVER_USED_GRACE_DAYS} jours, sans aucune activité.`,
      href: "/admin/boutiques?status=never",
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
      key: "paymentsToReview",
      tone: "danger",
      count: paymentsToReview,
      title: `${paymentsToReview} ${plural(paymentsToReview, "paiement à vérifier", "paiements à vérifier")}`,
      description: "Argent reçu mais abonnement non activé automatiquement (montant, suspension…).",
      href: "/admin/paiements?status=UNDER_REVIEW",
    },
    {
      key: "paymentsToConfirm",
      tone: "warning",
      count: paymentsToConfirm,
      title: `${paymentsToConfirm} ${plural(paymentsToConfirm, "paiement en attente", "paiements en attente")}`,
      description: "Demandes de paiement d'abonnement à confirmer à réception de l'argent.",
      href: "/admin/paiements?status=PENDING",
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

const RECENT_ORGANIZATIONS = 8;

export type PlatformOverview = Awaited<ReturnType<typeof getPlatformOverview>>;

/** Comptes et activité de la plateforme : aucune donnée commerciale. */
export async function getPlatformOverview(options: { range?: PlatformRange } = {}) {
  const range = options.range ?? "30d";
  const now = new Date();
  const period = resolvePeriod(range, now);
  const inactiveSince = new Date(now.getTime() - INACTIVITY_DAYS * DAY_MS);

  const [[organizations], [users], stores, recentlyActive] = await Promise.all([
    prisma.$queryRaw<{ total: number; suspended: number; active: number; inactive: number; created: number; previousCreated: number }[]>`
      SELECT
        (COUNT(*))::int AS "total",
        (COUNT(*) FILTER (WHERE NOT x."actif"))::int AS "suspended",
        (COUNT(*) FILTER (WHERE x."actif" AND x."lastActivity" >= ${sqlTimestamp(inactiveSince)}))::int AS "active",
        (COUNT(*) FILTER (
          WHERE x."actif" AND (x."lastActivity" IS NULL OR x."lastActivity" < ${sqlTimestamp(inactiveSince)})
        ))::int AS "inactive",
        (COUNT(*) FILTER (WHERE x."creeLe" >= ${sqlTimestamp(period.start)}))::int AS "created",
        (COUNT(*) FILTER (
          WHERE x."creeLe" >= ${sqlTimestamp(period.previousStart)} AND x."creeLe" < ${sqlTimestamp(period.start)}
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
    prisma.boutique.count(),
    prisma.$queryRaw<{ id: number; name: string; actif: boolean; lastActivity: Date | null }[]>`
      SELECT o."id", o."nom" AS "name", o."actif", ${ORGANIZATION_LAST_ACTIVITY_SQL} AS "lastActivity"
      FROM "Organisation" o
      ORDER BY "lastActivity" DESC NULLS LAST, o."id" DESC
      LIMIT ${RECENT_ORGANIZATIONS}
    `,
  ]);

  return {
    range,
    period: { start: period.start, end: now },
    organizations,
    users,
    stores,
    /** Boutiques classées par dernière activité (date seulement). */
    recentlyActive: recentlyActive.map((row) => ({ ...row, status: organizationStatus(row.actif, row.lastActivity, now) })),
  };
}

// ---------------------------------------------------------------------------
// Statistiques d'usage
// ---------------------------------------------------------------------------

const SIGNUP_WEEKS = 12;

export type PlatformAnalytics = Awaited<ReturnType<typeof getPlatformAnalytics>>;

type ActivityBuckets = { today: number; week: number; month: number; older: number; never: number };

/** Inscriptions par semaine et ancienneté de la dernière activité : aucune donnée commerciale. */
export async function getPlatformAnalytics() {
  const now = new Date();
  const today = startOfUtcDay(now);
  // Lundi (UTC) de la semaine courante, puis 11 semaines en arrière.
  const monday = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY_MS);
  const signupStart = new Date(monday.getTime() - (SIGNUP_WEEKS - 1) * 7 * DAY_MS);
  const dayAgo = sqlTimestamp(new Date(now.getTime() - DAY_MS));
  const weekAgo = sqlTimestamp(new Date(now.getTime() - 7 * DAY_MS));
  const monthAgo = sqlTimestamp(new Date(now.getTime() - INACTIVITY_DAYS * DAY_MS));

  const buckets = (column: Prisma.Sql) => Prisma.sql`
    (COUNT(*) FILTER (WHERE ${column} >= ${dayAgo}))::int AS "today",
    (COUNT(*) FILTER (WHERE ${column} < ${dayAgo} AND ${column} >= ${weekAgo}))::int AS "week",
    (COUNT(*) FILTER (WHERE ${column} < ${weekAgo} AND ${column} >= ${monthAgo}))::int AS "month",
    (COUNT(*) FILTER (WHERE ${column} < ${monthAgo}))::int AS "older",
    (COUNT(*) FILTER (WHERE ${column} IS NULL))::int AS "never"`;

  const [[organizationActivity], [userActivity], organizationSignups, userSignups] = await Promise.all([
    prisma.$queryRaw<ActivityBuckets[]>`
      SELECT ${buckets(Prisma.sql`x."lastActivity"`)}
      FROM (SELECT ${ORGANIZATION_LAST_ACTIVITY_SQL} AS "lastActivity" FROM "Organisation" o WHERE o."actif") x
    `,
    prisma.$queryRaw<ActivityBuckets[]>`
      SELECT ${buckets(Prisma.sql`u."derniereActiviteLe"`)}
      FROM "Utilisateur" u WHERE NOT u."superAdmin" AND u."actif"
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

  return { signups, organizationActivity, userActivity };
}

// ---------------------------------------------------------------------------
// Activité récente
// ---------------------------------------------------------------------------

export const ACTIVITY_KINDS = ["organization", "user", "admin"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = {
  organization: "Boutiques créées",
  user: "Inscriptions",
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

const fullName = (user: { prenom: string; nom: string } | null) => (user ? `${user.prenom} ${user.nom}` : "Compte supprimé");

/**
 * Flux d'événements de la plateforme (créations de boutiques, inscriptions,
 * actions d'administration), du plus récent au plus ancien. Les ventes et les
 * produits des boutiques n'y figurent pas. Pagination par curseur : passer
 * `before` = date du dernier événement reçu pour obtenir la page suivante.
 */
export async function getPlatformActivity(
  options: { limit?: number; before?: Date; kind?: ActivityKind; organizationId?: number } = {},
) {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const { before, kind, organizationId } = options;
  const wants = (candidate: ActivityKind) => !kind || kind === candidate;
  const dateFilter = before ? { lt: before } : undefined;
  const organisation = { select: { id: true, nom: true } };

  // Chaque source renvoie au plus `limit` lignes : après fusion, les `limit`
  // premières sont forcément les bonnes.
  const [organizations, users, audits] = await Promise.all([
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
