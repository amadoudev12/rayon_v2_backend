import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { Role, SaleStatus } from "@/generated/prisma/enums";
import { Errors } from "@/lib/api/errors";
import { recordAuditLog } from "@/lib/api/audit";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { identifierTakenMessage, identifierWhere, parseIdentifier } from "@/lib/auth/identifier";
import { containsText } from "@/lib/search";
import { slugify } from "@/lib/slug";
import { toNumber } from "@/lib/money";
import { getPagination, getSort, type Pagination } from "@/lib/api/pagination";
import type { AdminCreateOrganizationData, AdminProfileData } from "@/lib/validations/admin";
import {
  INACTIVITY_DAYS,
  ORGANIZATION_LAST_ACTIVITY_SQL,
  getPlatformActivity,
  organizationStatus,
  sqlTimestamp,
} from "./platform";

/**
 * Gestion des boutiques (organisations) et des comptes par le super
 * administrateur. Comme `platform.ts`, rien ici ne filtre par organisation :
 * l'appelant doit avoir passé `requireSuperAdmin()`.
 */

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Liste des boutiques
// ---------------------------------------------------------------------------

export const ORGANIZATION_STATUS_FILTERS = ["active", "inactive", "suspended", "nosales"] as const;
export type OrganizationStatusFilter = (typeof ORGANIZATION_STATUS_FILTERS)[number];

export const ORGANIZATION_SORT_FIELDS = ["nom", "creeLe", "products", "sales", "revenue", "lastActivity"] as const;
export type OrganizationSort = (typeof ORGANIZATION_SORT_FIELDS)[number];

/** Colonnes SQL triables : liste fermée, jamais construite à partir d'une saisie. */
const ORGANIZATION_SORT_SQL: Record<OrganizationSort, string> = {
  nom: 'LOWER(o."nom")',
  creeLe: 'o."creeLe"',
  products: '"products"',
  sales: 's."sales"',
  revenue: 's."revenue"',
  lastActivity: 'a."lastActivity"',
};

type OrganizationRow = {
  id: number;
  nom: string;
  devise: string;
  actif: boolean;
  creeLe: Date;
  ownerFirstName: string | null;
  ownerLastName: string | null;
  ownerEmail: string | null;
  ownerPhone: string | null;
  stores: number;
  members: number;
  products: number;
  sales: number;
  revenue: number;
  lastActivity: Date | null;
};

export type OrganizationListItem = Awaited<ReturnType<typeof listOrganizations>>["items"][number];

export async function listOrganizations(options: {
  search?: string;
  status?: OrganizationStatusFilter;
  sort?: OrganizationSort;
  order?: "asc" | "desc";
  pagination: Pagination;
}) {
  const now = new Date();
  const inactiveSince = sqlTimestamp(new Date(now.getTime() - INACTIVITY_DAYS * DAY_MS));
  const conditions: Prisma.Sql[] = [Prisma.sql`TRUE`];

  if (options.search) {
    // `%` et `_` saisis par l'utilisateur sont pris littéralement.
    const pattern = `%${options.search.replace(/[\\%_]/g, "\\$&")}%`;
    conditions.push(Prisma.sql`(
      o."nom" ILIKE ${pattern}
      OR owner."email" ILIKE ${pattern}
      OR owner."telephone" ILIKE ${pattern}
      OR (owner."prenom" || ' ' || owner."nom") ILIKE ${pattern}
    )`);
  }
  if (options.status === "suspended") conditions.push(Prisma.sql`NOT o."actif"`);
  if (options.status === "active") conditions.push(Prisma.sql`o."actif" AND a."lastActivity" >= ${inactiveSince}`);
  if (options.status === "inactive") {
    conditions.push(Prisma.sql`o."actif" AND (a."lastActivity" IS NULL OR a."lastActivity" < ${inactiveSince})`);
  }
  if (options.status === "nosales") conditions.push(Prisma.sql`s."sales" = 0`);

  const from = Prisma.sql`
    FROM "Organisation" o
    LEFT JOIN LATERAL (
      SELECT u."id", u."prenom", u."nom", u."email", u."telephone"
      FROM "Membre" m JOIN "Utilisateur" u ON u."id" = m."utilisateurId"
      WHERE m."organisationId" = o."id" AND m."role" = 'OWNER'
      ORDER BY m."id" LIMIT 1
    ) owner ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        (COUNT(*) FILTER (WHERE v."statut" = 'COMPLETED'))::int AS "sales",
        COALESCE(SUM(v."total") FILTER (WHERE v."statut" = 'COMPLETED'), 0)::float8 AS "revenue"
      FROM "Vente" v WHERE v."organisationId" = o."id"
    ) s ON TRUE
    LEFT JOIN LATERAL (SELECT ${ORGANIZATION_LAST_ACTIVITY_SQL} AS "lastActivity") a ON TRUE
    WHERE ${Prisma.join(conditions, " AND ")}
  `;

  const sort = ORGANIZATION_SORT_SQL[options.sort ?? "creeLe"];
  const order = options.order === "asc" ? "ASC" : "DESC";
  const { page, limit } = options.pagination;

  const [rows, [{ total }]] = await Promise.all([
    prisma.$queryRaw<OrganizationRow[]>`
      SELECT
        o."id", o."nom", o."devise", o."actif", o."creeLe",
        owner."prenom" AS "ownerFirstName", owner."nom" AS "ownerLastName", owner."email" AS "ownerEmail", owner."telephone" AS "ownerPhone",
        (SELECT COUNT(*) FROM "Boutique" b WHERE b."organisationId" = o."id")::int AS "stores",
        (SELECT COUNT(*) FROM "Membre" m WHERE m."organisationId" = o."id")::int AS "members",
        (SELECT COUNT(*) FROM "Produit" p WHERE p."organisationId" = o."id")::int AS "products",
        s."sales", s."revenue", a."lastActivity"
      ${from}
      ORDER BY ${Prisma.raw(sort)} ${Prisma.raw(order)} NULLS LAST, o."id" DESC
      LIMIT ${limit} OFFSET ${(page - 1) * limit}
    `,
    prisma.$queryRaw<{ total: number }[]>`SELECT (COUNT(*))::int AS "total" ${from}`,
  ]);

  return {
    total,
    items: rows.map((row) => ({
      id: row.id,
      nom: row.nom,
      devise: row.devise,
      actif: row.actif,
      creeLe: row.creeLe,
      owner:
        row.ownerEmail || row.ownerPhone
          ? {
              prenom: row.ownerFirstName ?? "",
              nom: row.ownerLastName ?? "",
              email: row.ownerEmail,
              telephone: row.ownerPhone,
            }
          : null,
      stores: row.stores,
      members: row.members,
      products: row.products,
      sales: row.sales,
      revenue: row.revenue,
      lastActivity: row.lastActivity,
      status: organizationStatus(row.actif, row.lastActivity, now),
    })),
  };
}

// ---------------------------------------------------------------------------
// Détail d'une boutique
// ---------------------------------------------------------------------------

const TREND_DAYS = 30;

export type OrganizationDetails = NonNullable<Awaited<ReturnType<typeof getOrganizationDetails>>>;

/** Vue de supervision d'une organisation (lecture seule) ; null si elle n'existe pas. */
export async function getOrganizationDetails(organizationId: number) {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const trendStart = new Date(today.getTime() - (TREND_DAYS - 1) * DAY_MS);
  const completed = { organisationId: organizationId, statut: SaleStatus.COMPLETED };

  const organization = await prisma.organisation.findUnique({
    where: { id: organizationId },
    select: {
      id: true,
      nom: true,
      slug: true,
      devise: true,
      actif: true,
      creeLe: true,
      boutiques: {
        orderBy: [{ parDefaut: "desc" }, { nom: "asc" }],
        select: {
          id: true,
          nom: true,
          adresse: true,
          telephone: true,
          parDefaut: true,
          _count: { select: { ventes: true, membres: true } },
        },
      },
      membres: {
        orderBy: { creeLe: "asc" },
        select: {
          id: true,
          role: true,
          boutique: { select: { nom: true } },
          utilisateur: {
            select: {
              id: true,
              prenom: true,
              nom: true,
              email: true,
              telephone: true,
              actif: true,
              derniereActiviteLe: true,
              creeLe: true,
            },
          },
        },
      },
      _count: { select: { produits: true, clients: true, fournisseurs: true, achats: true } },
    },
  });
  if (!organization) return null;

  const [allTime, month, cancelledCount, activeProducts, [activity], trendRows, recentSales, topProductRows, recentProducts, feed] =
    await Promise.all([
      prisma.vente.aggregate({ where: completed, _sum: { total: true }, _count: true }),
      prisma.vente.aggregate({ where: { ...completed, creeLe: { gte: monthStart } }, _sum: { total: true }, _count: true }),
      prisma.vente.count({ where: { organisationId: organizationId, statut: SaleStatus.CANCELLED } }),
      prisma.produit.count({ where: { organisationId: organizationId, actif: true } }),
      prisma.$queryRaw<{ lastActivity: Date | null }[]>`
        SELECT ${ORGANIZATION_LAST_ACTIVITY_SQL} AS "lastActivity" FROM "Organisation" o WHERE o."id" = ${organizationId}
      `,
      prisma.$queryRaw<{ bucket: string; revenue: number; count: number }[]>`
        SELECT to_char(date_trunc('day', v."creeLe"), 'YYYY-MM-DD') AS "bucket",
          COALESCE(SUM(v."total"), 0)::float8 AS "revenue", (COUNT(*))::int AS "count"
        FROM "Vente" v
        WHERE v."organisationId" = ${organizationId} AND v."statut" = 'COMPLETED' AND v."creeLe" >= ${sqlTimestamp(trendStart)}
        GROUP BY 1
      `,
      prisma.vente.findMany({
        where: { organisationId: organizationId },
        orderBy: { creeLe: "desc" },
        take: 8,
        select: {
          id: true,
          total: true,
          statut: true,
          creeLe: true,
          boutique: { select: { nom: true } },
          vendeur: { select: { prenom: true, nom: true } },
          client: { select: { nom: true } },
        },
      }),
      prisma.ligneVente.groupBy({
        by: ["produitId"],
        where: { vente: completed },
        _sum: { quantite: true, sousTotal: true },
        orderBy: { _sum: { quantite: "desc" } },
        take: 5,
      }),
      prisma.produit.findMany({
        where: { organisationId: organizationId },
        orderBy: { creeLe: "desc" },
        take: 6,
        select: { id: true, nom: true, prixVente: true, actif: true, creeLe: true, categorie: { select: { nom: true } } },
      }),
      getPlatformActivity({ organizationId, limit: 8 }),
    ]);

  const topProductNames = await prisma.produit.findMany({
    where: { id: { in: topProductRows.map((row) => row.produitId) } },
    select: { id: true, nom: true, unite: true },
  });
  const namesById = new Map(topProductNames.map((product) => [product.id, product]));

  const trendByDay = new Map(trendRows.map((row) => [row.bucket, row]));
  const trend = Array.from({ length: TREND_DAYS }, (_, index) => {
    const date = new Date(trendStart.getTime() + index * DAY_MS);
    const row = trendByDay.get(date.toISOString().slice(0, 10));
    return {
      day: date.toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" }),
      value: row?.revenue ?? 0,
      count: row?.count ?? 0,
    };
  });

  const revenue = toNumber(allTime._sum.total ?? 0);
  const owner = organization.membres.find((member) => member.role === Role.OWNER) ?? null;

  return {
    id: organization.id,
    nom: organization.nom,
    slug: organization.slug,
    devise: organization.devise,
    actif: organization.actif,
    creeLe: organization.creeLe,
    lastActivity: activity?.lastActivity ?? null,
    status: organizationStatus(organization.actif, activity?.lastActivity ?? null, now),
    owner: owner?.utilisateur ?? null,
    stores: organization.boutiques.map((store) => ({
      id: store.id,
      nom: store.nom,
      adresse: store.adresse,
      telephone: store.telephone,
      parDefaut: store.parDefaut,
      sales: store._count.ventes,
      members: store._count.membres,
    })),
    members: organization.membres.map((member) => ({
      id: member.id,
      role: member.role,
      storeName: member.boutique?.nom ?? null,
      user: member.utilisateur,
    })),
    counts: {
      products: organization._count.produits,
      activeProducts,
      customers: organization._count.clients,
      suppliers: organization._count.fournisseurs,
      purchases: organization._count.achats,
      sales: allTime._count,
      cancelledSales: cancelledCount,
    },
    revenue: {
      allTime: revenue,
      month: toNumber(month._sum.total ?? 0),
      monthSales: month._count,
      averageBasket: allTime._count > 0 ? revenue / allTime._count : 0,
    },
    trend,
    recentSales: recentSales.map((sale) => ({
      id: sale.id,
      total: toNumber(sale.total),
      cancelled: sale.statut === SaleStatus.CANCELLED,
      creeLe: sale.creeLe,
      storeName: sale.boutique.nom,
      seller: `${sale.vendeur.prenom} ${sale.vendeur.nom}`,
      customer: sale.client?.nom ?? null,
    })),
    topProducts: topProductRows.map((row) => ({
      id: row.produitId,
      nom: namesById.get(row.produitId)?.nom ?? "Produit supprimé",
      unite: namesById.get(row.produitId)?.unite ?? "",
      quantity: row._sum.quantite ?? 0,
      amount: toNumber(row._sum.sousTotal ?? 0),
    })),
    recentProducts: recentProducts.map((product) => ({
      id: product.id,
      nom: product.nom,
      prixVente: toNumber(product.prixVente),
      actif: product.actif,
      creeLe: product.creeLe,
      categorie: product.categorie?.nom ?? null,
    })),
    activity: feed.events,
  };
}

// ---------------------------------------------------------------------------
// Création, suspension et réactivation d'une boutique
// ---------------------------------------------------------------------------

/**
 * Crée une organisation, son premier point de vente et le compte de son
 * propriétaire en une seule transaction. Aucun message n'est envoyé : le super
 * administrateur communique lui-même le mot de passe temporaire.
 */
export async function createOrganizationWithOwner(adminId: number, input: AdminCreateOrganizationData) {
  const identifier = parseIdentifier(input.identifiant);
  if (!identifier) throw Errors.conflict("Identifiant de connexion invalide.");
  const existing = await prisma.utilisateur.findUnique({ where: identifierWhere(identifier), select: { id: true } });
  if (existing) throw Errors.conflict(identifierTakenMessage(identifier));

  const motDePasseHash = await hashPassword(input.motDePasse);

  const organization = await prisma.$transaction(async (tx) => {
    const owner = await tx.utilisateur.create({
      data: { prenom: input.prenom, nom: input.nom, ...identifierWhere(identifier), motDePasseHash },
    });
    const created = await tx.organisation.create({
      data: { nom: input.nomOrganisation, slug: slugify(input.nomOrganisation), devise: input.devise },
    });
    await tx.boutique.create({ data: { organisationId: created.id, nom: input.nomBoutique, parDefaut: true } });
    await tx.membre.create({ data: { utilisateurId: owner.id, organisationId: created.id, role: Role.OWNER } });
    return created;
  });

  await recordAuditLog({
    organisationId: organization.id,
    utilisateurId: adminId,
    action: "organization.created",
    entite: "Organization",
    entiteId: organization.id,
    metadonnees: { source: "super-admin" },
  });

  return { id: organization.id, nom: organization.nom, devise: organization.devise };
}

/**
 * Suspend ou réactive une organisation. La suspension est effective dès la
 * requête suivante de ses membres (l'état est relu en base, voir
 * lib/auth/session) ; aucune donnée métier n'est modifiée ni supprimée.
 */
export async function setOrganizationActive(adminId: number, organizationId: number, actif: boolean) {
  const organization = await prisma.organisation.findUnique({
    where: { id: organizationId },
    select: { id: true, nom: true, actif: true },
  });
  if (!organization) throw Errors.notFound("Boutique introuvable");
  if (organization.actif === actif) return organization;

  const updated = await prisma.organisation.update({
    where: { id: organizationId },
    data: { actif },
    select: { id: true, nom: true, actif: true },
  });

  await recordAuditLog({
    organisationId: organizationId,
    utilisateurId: adminId,
    action: actif ? "organization.reactivated" : "organization.suspended",
    entite: "Organization",
    entiteId: organizationId,
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Utilisateurs
// ---------------------------------------------------------------------------

export const USER_STATUS_FILTERS = ["active", "disabled", "onboarding"] as const;
export type UserStatusFilter = (typeof USER_STATUS_FILTERS)[number];

/** Filtre par rôle : un rôle d'organisation, ou le rôle global de la plateforme. */
export const USER_ROLE_FILTERS = [...Object.values(Role), "SUPER_ADMIN"] as const;
export type UserRoleFilter = (typeof USER_ROLE_FILTERS)[number];

export const USER_SORT_FIELDS = ["creeLe", "derniereActiviteLe", "nom"] as const;
export type UserSort = (typeof USER_SORT_FIELDS)[number];

export type UserListItem = Awaited<ReturnType<typeof listUsers>>["items"][number];

export async function listUsers(options: {
  search?: string;
  role?: UserRoleFilter;
  status?: UserStatusFilter;
  sort?: UserSort;
  order?: "asc" | "desc";
  pagination: Pagination;
}) {
  const filters: Prisma.UtilisateurWhereInput[] = [];

  if (options.search) {
    const text = containsText(options.search);
    filters.push({
      OR: [
        { prenom: text },
        { nom: text },
        { email: text },
        { telephone: text },
        { membre: { organisation: { nom: text } } },
      ],
    });
  }
  if (options.role === "SUPER_ADMIN") filters.push({ superAdmin: true });
  else if (options.role) filters.push({ superAdmin: false, membre: { role: options.role } });

  if (options.status === "active") filters.push({ actif: true });
  if (options.status === "disabled") filters.push({ actif: false });
  if (options.status === "onboarding") filters.push({ superAdmin: false, membre: null });

  const where: Prisma.UtilisateurWhereInput = { AND: filters };
  const order = options.order === "asc" ? "asc" : "desc";
  const orderBy: Prisma.UtilisateurOrderByWithRelationInput[] =
    options.sort === "nom"
      ? [{ nom: order }, { prenom: order }]
      : options.sort === "derniereActiviteLe"
        ? [{ derniereActiviteLe: { sort: order, nulls: "last" } }, { id: "desc" }]
        : [{ creeLe: order }, { id: "desc" }];

  const { page, limit } = options.pagination;
  const [users, total] = await Promise.all([
    prisma.utilisateur.findMany({
      where,
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
      // Jamais `motDePasseHash` : la sélection est explicite.
      select: {
        id: true,
        prenom: true,
        nom: true,
        email: true,
        telephone: true,
        superAdmin: true,
        actif: true,
        creeLe: true,
        derniereActiviteLe: true,
        membre: {
          select: {
            role: true,
            organisation: { select: { id: true, nom: true, actif: true } },
            boutique: { select: { nom: true } },
          },
        },
      },
    }),
    prisma.utilisateur.count({ where }),
  ]);

  return {
    total,
    items: users.map((user) => ({
      id: user.id,
      prenom: user.prenom,
      nom: user.nom,
      email: user.email,
      telephone: user.telephone,
      superAdmin: user.superAdmin,
      actif: user.actif,
      creeLe: user.creeLe,
      derniereActiviteLe: user.derniereActiviteLe,
      role: user.membre?.role ?? null,
      organization: user.membre?.organisation ?? null,
      storeName: user.membre?.boutique?.nom ?? null,
    })),
  };
}

/**
 * Désactive ou réactive un compte. Un compte désactivé ne peut plus se
 * connecter et ses sessions ouvertes sont refusées dès la requête suivante.
 * Les comptes super administrateur ne se gèrent pas ici (ni soi-même, ni un
 * autre) : on ne peut pas se couper l'accès à la plateforme par erreur.
 */
export async function setUserActive(adminId: number, userId: number, actif: boolean) {
  const user = await prisma.utilisateur.findUnique({
    where: { id: userId },
    select: { id: true, prenom: true, nom: true, actif: true, superAdmin: true, membre: { select: { organisationId: true } } },
  });
  if (!user) throw Errors.notFound("Utilisateur introuvable");
  if (user.superAdmin) throw Errors.conflict("Un compte super administrateur ne peut pas être désactivé ici.");
  if (user.actif === actif) return { id: user.id, actif: user.actif };

  const updated = await prisma.utilisateur.update({
    where: { id: userId },
    data: { actif },
    select: { id: true, actif: true },
  });

  // Le journal d'audit est rattaché à une organisation : un compte sans
  // boutique (inscription inachevée) n'y laisse donc pas de trace.
  if (user.membre) {
    await recordAuditLog({
      organisationId: user.membre.organisationId,
      utilisateurId: adminId,
      action: actif ? "user.reactivated" : "user.deactivated",
      entite: "Utilisateur",
      entiteId: user.id,
      metadonnees: { cible: `${user.prenom} ${user.nom}` },
    });
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Profil du super administrateur
// ---------------------------------------------------------------------------

export async function updateSuperAdminProfile(adminId: number, input: AdminProfileData) {
  const data: Prisma.UtilisateurUpdateInput = { prenom: input.prenom, nom: input.nom };

  if (input.nouveauMotDePasse) {
    const account = await prisma.utilisateur.findUniqueOrThrow({
      where: { id: adminId },
      select: { motDePasseHash: true },
    });
    const valid = await verifyPassword(input.motDePasseActuel ?? "", account.motDePasseHash);
    if (!valid) throw Errors.conflict("Le mot de passe actuel est incorrect.");
    data.motDePasseHash = await hashPassword(input.nouveauMotDePasse);
  }

  return prisma.utilisateur.update({
    where: { id: adminId },
    data,
    select: { id: true, prenom: true, nom: true, email: true, telephone: true },
  });
}

// ---------------------------------------------------------------------------
// Lecture des filtres (partagée par les pages et les routes API)
// ---------------------------------------------------------------------------

function oneOf<const T extends readonly string[]>(value: string | null, allowed: T): T[number] | undefined {
  return (allowed as readonly string[]).includes(value ?? "") ? (value as T[number]) : undefined;
}

export function parseOrganizationQuery(searchParams: URLSearchParams) {
  return {
    search: searchParams.get("search")?.trim() || undefined,
    status: oneOf(searchParams.get("status"), ORGANIZATION_STATUS_FILTERS),
    ...getSort(searchParams, ORGANIZATION_SORT_FIELDS, "creeLe"),
    pagination: getPagination(searchParams, 10),
  };
}

export function parseUserQuery(searchParams: URLSearchParams) {
  return {
    search: searchParams.get("search")?.trim() || undefined,
    role: oneOf(searchParams.get("role"), USER_ROLE_FILTERS),
    status: oneOf(searchParams.get("status"), USER_STATUS_FILTERS),
    ...getSort(searchParams, USER_SORT_FIELDS, "creeLe"),
    pagination: getPagination(searchParams, 15),
  };
}
