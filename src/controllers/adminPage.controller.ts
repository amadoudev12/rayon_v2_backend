import type { Request, Response } from "express";
import * as platformService from "@/services/platform";
import * as platformAdminService from "@/services/platform-admin";
import { prisma } from "@/lib/prisma";
import { paginationMeta, parseIntId } from "@/lib/api/pagination";
import { jsonData, searchParams } from "@/lib/api/response";
import { Errors } from "@/lib/api/errors";

/** Lectures de page du site web (`/api/pages/admin/**`) : espace super administrateur. */

const ACTIVITY_PAGE_SIZE = 25;

/** Page inconnue (identifiant invalide ou ressource absente) : le site affiche sa page 404. */
function pageNotFound(message: string) {
  return Errors.notFound(message);
}

/** Cadre de l'administration : compte connecté et points à surveiller (cloche). */
export async function getAdminShellPage(req: Request, res: Response) {
  const admin = req.admin;

  const [user, alerts] = await Promise.all([
    prisma.utilisateur.findUniqueOrThrow({
      where: { id: admin.userId },
      select: { prenom: true, nom: true, email: true, telephone: true },
    }),
    platformService.getPlatformAlerts(),
  ]);

  return jsonData(res, { user, alerts });
}

export async function getAdminHomePage(req: Request, res: Response) {
  const admin = req.admin;
  const params = searchParams(req);
  const range = platformService.parseRange(params.get("range"));

  const [user, overview, alerts, activity] = await Promise.all([
    prisma.utilisateur.findUniqueOrThrow({ where: { id: admin.userId }, select: { prenom: true } }),
    platformService.getPlatformOverview({ range, currency: params.get("currency") ?? undefined }),
    platformService.getPlatformAlerts(),
    platformService.getPlatformActivity({ limit: 8 }),
  ]);

  return jsonData(res, { user, range, overview, alerts, activity });
}

export async function getAdminOrganizationsPage(req: Request, res: Response) {
  const query = platformAdminService.parseOrganizationQuery(searchParams(req));

  const { items, total } = await platformAdminService.listOrganizations(query);

  return jsonData(res, {
    items,
    total,
    filtered: Boolean(query.search || query.status),
    page: query.pagination.page,
    totalPages: paginationMeta(query.pagination, total).totalPages,
  });
}

export async function getAdminOrganizationPage(req: Request, res: Response) {
  const organizationId = parseIntId(String(req.params.id));
  if (!organizationId) throw pageNotFound("Boutique introuvable");

  const organization = await platformAdminService.getOrganizationDetails(organizationId);
  if (!organization) throw pageNotFound("Boutique introuvable");

  return jsonData(res, organization);
}

export async function getAdminUsersPage(req: Request, res: Response) {
  const query = platformAdminService.parseUserQuery(searchParams(req));

  const { items, total } = await platformAdminService.listUsers(query);

  return jsonData(res, {
    items,
    total,
    filtered: Boolean(query.search || query.role || query.status),
    page: query.pagination.page,
    totalPages: paginationMeta(query.pagination, total).totalPages,
  });
}

export async function getAdminStatisticsPage(req: Request, res: Response) {
  const params = searchParams(req);
  const range = platformService.parseRange(params.get("range"));

  const analytics = await platformService.getPlatformAnalytics({ range, currency: params.get("currency") ?? undefined });

  return jsonData(res, { range, analytics });
}

export async function getAdminActivityPage(req: Request, res: Response) {
  const query = platformService.parseActivityQuery(searchParams(req));

  const [activity, organization] = await Promise.all([
    platformService.getPlatformActivity({ ...query, limit: ACTIVITY_PAGE_SIZE }),
    query.organizationId
      ? prisma.organisation.findUnique({ where: { id: query.organizationId }, select: { id: true, nom: true } })
      : null,
  ]);

  return jsonData(res, {
    activity,
    organization,
    kind: query.kind ?? null,
    organizationId: query.organizationId ?? null,
    before: query.before ?? null,
  });
}

export async function getAdminProfilePage(req: Request, res: Response) {
  const admin = req.admin;

  const [user, superAdmins] = await Promise.all([
    prisma.utilisateur.findUniqueOrThrow({
      where: { id: admin.userId },
      select: { prenom: true, nom: true, email: true, telephone: true, creeLe: true },
    }),
    prisma.utilisateur.findMany({
      where: { superAdmin: true },
      orderBy: { creeLe: "asc" },
      select: { id: true, prenom: true, nom: true, email: true, telephone: true, actif: true },
    }),
  ]);

  return jsonData(res, { user, superAdmins, currentUserId: admin.userId });
}
