import type { Request, Response } from "express";
import { z } from "zod";
import { SubscriptionPaymentStatus } from "@/generated/prisma/enums";
import { getPagination, paginationMeta } from "@/lib/api/pagination";
import { jsonData, jsonPage, routeId, searchParams } from "@/lib/api/response";
import {
  ADMIN_STATE_FILTERS,
  assignPlan,
  extendSubscription,
  getAdminPayment,
  getPaymentAnomalies,
  getSubscriptionDashboard,
  grantTrial,
  listAdminAudit,
  listAdminPayments,
  listAdminReceipts,
  listSubscriptions,
  reactivateSubscription,
  suspendSubscription,
} from "@/services/billing/admin";
import { DURATIONS_MONTHS, PLAN_CODES } from "@/services/billing/plans";

/**
 * Administration centrale des abonnements (`/api/admin/**`, super
 * administrateur uniquement) et données des pages correspondantes.
 */

const reason = z.string({ message: "Motif obligatoire." }).trim().min(5, "Motif obligatoire (5 caractères au moins).").max(500);

const assignSchema = z.object({
  plan: z.enum(PLAN_CODES),
  /** Durée accordée ; absente : changement de forfait de la période payée en cours. */
  months: z.coerce.number().int().refine((value) => (DURATIONS_MONTHS as readonly number[]).includes(value), "Durée invalide.").optional().nullable(),
  motif: reason,
});
const extendSchema = z.object({ jusquAu: z.coerce.date(), motif: reason });
const reasonSchema = z.object({ motif: reason });

export async function postAssignPlan(req: Request, res: Response) {
  const parsed = assignSchema.parse(req.body);
  const subscription = await assignPlan(req.admin.userId, routeId(req), {
    plan: parsed.plan,
    months: (parsed.months ?? null) as (typeof DURATIONS_MONTHS)[number] | null,
    reason: parsed.motif,
  });
  return jsonData(res, subscription);
}

export async function postExtendSubscription(req: Request, res: Response) {
  const parsed = extendSchema.parse(req.body);
  return jsonData(res, await extendSubscription(req.admin.userId, routeId(req), { until: parsed.jusquAu, reason: parsed.motif }));
}

export async function postSuspendSubscription(req: Request, res: Response) {
  const parsed = reasonSchema.parse(req.body);
  return jsonData(res, await suspendSubscription(req.admin.userId, routeId(req), { reason: parsed.motif }));
}

export async function postReactivateSubscription(req: Request, res: Response) {
  const parsed = reasonSchema.parse(req.body);
  return jsonData(res, await reactivateSubscription(req.admin.userId, routeId(req), { reason: parsed.motif }));
}

export async function postGrantTrial(req: Request, res: Response) {
  const parsed = reasonSchema.parse(req.body);
  return jsonData(res, await grantTrial(req.admin.userId, routeId(req), { reason: parsed.motif }), { status: 201 });
}

// ---------------------------------------------------------------------------
// Filtres
// ---------------------------------------------------------------------------

const subscriptionQuery = z.object({
  search: z.string().trim().max(100).optional(),
  state: z.enum(ADMIN_STATE_FILTERS).optional(),
  plan: z.enum(PLAN_CODES).optional(),
});

function parseSubscriptionQuery(params: URLSearchParams) {
  const parsed = subscriptionQuery.safeParse({
    search: params.get("search") || undefined,
    state: params.get("state") || undefined,
    plan: params.get("plan") || undefined,
  });
  return { ...(parsed.success ? parsed.data : {}), pagination: getPagination(params, 25) };
}

const paymentQuery = z.object({
  status: z.enum(SubscriptionPaymentStatus).optional(),
  organizationId: z.coerce.number().int().positive().optional(),
  plan: z.enum(PLAN_CODES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  search: z.string().trim().max(100).optional(),
});

function parsePaymentQuery(params: URLSearchParams) {
  const parsed = paymentQuery.safeParse({
    status: params.get("status") || undefined,
    organizationId: params.get("organizationId") || undefined,
    plan: params.get("plan") || undefined,
    from: params.get("from") || undefined,
    to: params.get("to") || undefined,
    search: params.get("search") || undefined,
  });
  const filters = parsed.success ? parsed.data : {};
  // `to` est une date incluse : on s'arrête au début du jour suivant.
  const to = filters.to ? new Date(filters.to.getTime() + 86_400_000) : undefined;
  return { ...filters, to, pagination: getPagination(params, 25) };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export async function getAdminSubscriptions(req: Request, res: Response) {
  const query = parseSubscriptionQuery(searchParams(req));
  const { items, total } = await listSubscriptions({ ...query, page: query.pagination.page, limit: query.pagination.limit });
  return jsonPage(res, items, paginationMeta(query.pagination, total));
}

export async function getAdminSubscriptionDashboard(_req: Request, res: Response) {
  return jsonData(res, await getSubscriptionDashboard());
}

export async function getAdminPayments(req: Request, res: Response) {
  const query = parsePaymentQuery(searchParams(req));
  const { items, total } = await listAdminPayments({ ...query, page: query.pagination.page, limit: query.pagination.limit });
  return jsonPage(res, items, paginationMeta(query.pagination, total));
}

export async function getAdminPaymentById(req: Request, res: Response) {
  return jsonData(res, await getAdminPayment(routeId(req)));
}

export async function getAdminPaymentAnomalies(_req: Request, res: Response) {
  return jsonData(res, await getPaymentAnomalies());
}

export async function getAdminReceipts(req: Request, res: Response) {
  const params = searchParams(req);
  const pagination = getPagination(params, 25);
  const organizationId = Number(params.get("organizationId")) || undefined;
  const { items, total } = await listAdminReceipts({ organizationId, page: pagination.page, limit: pagination.limit });
  return jsonPage(res, items, paginationMeta(pagination, total));
}

function parseAuditQuery(params: URLSearchParams) {
  return {
    organizationId: Number(params.get("organizationId")) || undefined,
    action: params.get("action")?.trim() || undefined,
    before: Number(params.get("before")) || undefined,
  };
}

export async function getAdminAudit(req: Request, res: Response) {
  return jsonData(res, await listAdminAudit({ ...parseAuditQuery(searchParams(req)), limit: 50 }));
}

// ---------------------------------------------------------------------------
// Pages du site (`/api/pages/admin/**`)
// ---------------------------------------------------------------------------

export async function getAdminSubscriptionsPage(req: Request, res: Response) {
  const query = parseSubscriptionQuery(searchParams(req));
  const [dashboard, list] = await Promise.all([
    getSubscriptionDashboard(),
    listSubscriptions({ ...query, page: query.pagination.page, limit: query.pagination.limit }),
  ]);
  return jsonData(res, {
    dashboard,
    items: list.items,
    total: list.total,
    filters: { search: query.search ?? "", state: query.state ?? "", plan: query.plan ?? "" },
    page: query.pagination.page,
    totalPages: paginationMeta(query.pagination, list.total).totalPages,
  });
}

export async function getAdminPaymentsPage(req: Request, res: Response) {
  const query = parsePaymentQuery(searchParams(req));
  const [list, anomalies] = await Promise.all([
    listAdminPayments({ ...query, page: query.pagination.page, limit: query.pagination.limit }),
    getPaymentAnomalies(),
  ]);
  const params = searchParams(req);
  return jsonData(res, {
    items: list.items,
    total: list.total,
    confirmedAmount: list.confirmedAmount,
    anomalies,
    filters: {
      status: query.status ?? "",
      plan: query.plan ?? "",
      search: query.search ?? "",
      from: params.get("from") ?? "",
      to: params.get("to") ?? "",
      organizationId: query.organizationId ?? null,
    },
    page: query.pagination.page,
    totalPages: paginationMeta(query.pagination, list.total).totalPages,
  });
}

export async function getAdminAuditPage(req: Request, res: Response) {
  const query = parseAuditQuery(searchParams(req));
  return jsonData(res, { ...(await listAdminAudit({ ...query, limit: 50 })), filters: { action: query.action ?? "", organizationId: query.organizationId ?? null } });
}
