import type { Request, Response } from "express";
import * as platformService from "@/services/platform";
import * as platformAdminService from "@/services/platform-admin";
import { adminCreateOrganizationSchema, adminProfileSchema, adminStatusSchema } from "@/lib/validations/admin";
import { paginationMeta } from "@/lib/api/pagination";
import { jsonData, jsonPage, routeId, searchParams } from "@/lib/api/response";
import { Errors } from "@/lib/api/errors";

/** Actions de la plateforme (`/api/admin/**`), réservées au super administrateur. */

/** Chiffres clés de la plateforme : une seule requête HTTP pour toutes les cartes. */
export async function getOverview(req: Request, res: Response) {
  const params = searchParams(req);

  const [overview, alerts] = await Promise.all([
    platformService.getPlatformOverview({
      range: platformService.parseRange(params.get("range")),
      currency: params.get("currency") ?? undefined,
    }),
    platformService.getPlatformAlerts(),
  ]);

  return jsonData(res, { ...overview, alerts });
}

export async function getAnalytics(req: Request, res: Response) {
  const params = searchParams(req);

  const analytics = await platformService.getPlatformAnalytics({
    range: platformService.parseRange(params.get("range")),
    currency: params.get("currency") ?? undefined,
  });

  return jsonData(res, analytics);
}

export async function getActivity(req: Request, res: Response) {
  const activity = await platformService.getPlatformActivity(platformService.parseActivityQuery(searchParams(req)));
  return jsonData(res, activity);
}

export async function getAllOrganizations(req: Request, res: Response) {
  const query = platformAdminService.parseOrganizationQuery(searchParams(req));

  const { items, total } = await platformAdminService.listOrganizations(query);
  return jsonPage(res, items, paginationMeta(query.pagination, total));
}

export async function createOrganization(req: Request, res: Response) {
  const admin = req.admin;
  const parsed = adminCreateOrganizationSchema.parse(req.body);

  const organization = await platformAdminService.createOrganizationWithOwner(admin.userId, parsed);
  return jsonData(res, organization, { status: 201 });
}

export async function getOrganizationById(req: Request, res: Response) {
  const organizationId = routeId(req);

  const organization = await platformAdminService.getOrganizationDetails(organizationId);
  if (!organization) throw Errors.notFound("Boutique introuvable");
  return jsonData(res, organization);
}

/** Suspend (`actif: false`) ou réactive (`actif: true`) une organisation. */
export async function updateOrganizationStatus(req: Request, res: Response) {
  const admin = req.admin;
  const organizationId = routeId(req);

  const { actif } = adminStatusSchema.parse(req.body);
  const organization = await platformAdminService.setOrganizationActive(admin.userId, organizationId, actif);
  return jsonData(res, organization);
}

export async function getAllUsers(req: Request, res: Response) {
  const query = platformAdminService.parseUserQuery(searchParams(req));

  const { items, total } = await platformAdminService.listUsers(query);
  return jsonPage(res, items, paginationMeta(query.pagination, total));
}

/** Désactive (`actif: false`) ou réactive (`actif: true`) un compte utilisateur. */
export async function updateUserStatus(req: Request, res: Response) {
  const admin = req.admin;
  const userId = routeId(req);

  const { actif } = adminStatusSchema.parse(req.body);
  const user = await platformAdminService.setUserActive(admin.userId, userId, actif);
  return jsonData(res, user);
}

export async function updateProfile(req: Request, res: Response) {
  const admin = req.admin;
  const parsed = adminProfileSchema.parse(req.body);

  const profile = await platformAdminService.updateSuperAdminProfile(admin.userId, parsed);
  return jsonData(res, profile);
}
