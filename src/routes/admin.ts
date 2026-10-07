import { Router } from "express";
import { requireSuperAdmin } from "@/lib/auth/session";
import {
  getPlatformActivity,
  getPlatformAlerts,
  getPlatformAnalytics,
  getPlatformOverview,
  parseActivityQuery,
  parseRange,
} from "@/lib/services/platform";
import {
  createOrganizationWithOwner,
  getOrganizationDetails,
  listOrganizations,
  listUsers,
  parseOrganizationQuery,
  parseUserQuery,
  setOrganizationActive,
  setUserActive,
  updateSuperAdminProfile,
} from "@/lib/services/platform-admin";
import { adminCreateOrganizationSchema, adminProfileSchema, adminStatusSchema } from "@/lib/validations/admin";
import { paginationMeta } from "@/lib/api/pagination";
import { apiRoute, jsonData, jsonPage, routeId, searchParams } from "@/lib/api/response";
import { Errors } from "@/lib/api/errors";

/** Routes de la plateforme (`/api/admin/**`) : toutes réservées au super administrateur. */
export const adminRouter = Router();

/** Chiffres clés de la plateforme : une seule requête HTTP pour toutes les cartes. */
adminRouter.get(
  "/overview",
  apiRoute(async (req, res) => {
    await requireSuperAdmin();
    const params = searchParams(req);

    const [overview, alerts] = await Promise.all([
      getPlatformOverview({
        range: parseRange(params.get("range")),
        currency: params.get("currency") ?? undefined,
      }),
      getPlatformAlerts(),
    ]);

    return jsonData(res, { ...overview, alerts });
  }),
);

adminRouter.get(
  "/analytics",
  apiRoute(async (req, res) => {
    await requireSuperAdmin();
    const params = searchParams(req);

    const analytics = await getPlatformAnalytics({
      range: parseRange(params.get("range")),
      currency: params.get("currency") ?? undefined,
    });

    return jsonData(res, analytics);
  }),
);

adminRouter.get(
  "/activity",
  apiRoute(async (req, res) => {
    await requireSuperAdmin();
    const activity = await getPlatformActivity(parseActivityQuery(searchParams(req)));
    return jsonData(res, activity);
  }),
);

adminRouter.get(
  "/organizations",
  apiRoute(async (req, res) => {
    await requireSuperAdmin();
    const query = parseOrganizationQuery(searchParams(req));

    const { items, total } = await listOrganizations(query);
    return jsonPage(res, items, paginationMeta(query.pagination, total));
  }),
);

adminRouter.post(
  "/organizations",
  apiRoute(async (req, res) => {
    const admin = await requireSuperAdmin();
    const parsed = adminCreateOrganizationSchema.parse(req.body);

    const organization = await createOrganizationWithOwner(admin.userId, parsed);
    return jsonData(res, organization, { status: 201 });
  }),
);

adminRouter.get(
  "/organizations/:id",
  apiRoute(async (req, res) => {
    await requireSuperAdmin();
    const organizationId = routeId(req);

    const organization = await getOrganizationDetails(organizationId);
    if (!organization) throw Errors.notFound("Boutique introuvable");
    return jsonData(res, organization);
  }),
);

/** Suspend (`actif: false`) ou réactive (`actif: true`) une organisation. */
adminRouter.patch(
  "/organizations/:id",
  apiRoute(async (req, res) => {
    const admin = await requireSuperAdmin();
    const organizationId = routeId(req);

    const { actif } = adminStatusSchema.parse(req.body);
    const organization = await setOrganizationActive(admin.userId, organizationId, actif);
    return jsonData(res, organization);
  }),
);

adminRouter.get(
  "/users",
  apiRoute(async (req, res) => {
    await requireSuperAdmin();
    const query = parseUserQuery(searchParams(req));

    const { items, total } = await listUsers(query);
    return jsonPage(res, items, paginationMeta(query.pagination, total));
  }),
);

/** Désactive (`actif: false`) ou réactive (`actif: true`) un compte utilisateur. */
adminRouter.patch(
  "/users/:id",
  apiRoute(async (req, res) => {
    const admin = await requireSuperAdmin();
    const userId = routeId(req);

    const { actif } = adminStatusSchema.parse(req.body);
    const user = await setUserActive(admin.userId, userId, actif);
    return jsonData(res, user);
  }),
);

adminRouter.patch(
  "/profile",
  apiRoute(async (req, res) => {
    const admin = await requireSuperAdmin();
    const parsed = adminProfileSchema.parse(req.body);

    const profile = await updateSuperAdminProfile(admin.userId, parsed);
    return jsonData(res, profile);
  }),
);
