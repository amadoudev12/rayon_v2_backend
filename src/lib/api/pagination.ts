const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export type Pagination = { page: number; limit: number };

/** Parses `page`/`limit` query params defensively, clamping to sane bounds. */
export function getPagination(searchParams: URLSearchParams, defaultLimit = DEFAULT_PAGE_SIZE): Pagination {
  const page = Number(searchParams.get("page") ?? "1");
  const limit = Number(searchParams.get("limit") ?? String(defaultLimit));

  return {
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    limit: Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_PAGE_SIZE) : defaultLimit,
  };
}

export function paginationMeta(pagination: Pagination, total: number) {
  return {
    page: pagination.page,
    limit: pagination.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
  };
}

/** Parses `sort`/`order`, restricting `sort` to a known allow-list. */
export function getSort<const F extends readonly string[]>(
  searchParams: URLSearchParams,
  allowedFields: F,
  fallback: F[number],
): { sort: F[number]; order: "asc" | "desc" } {
  const sortParam = searchParams.get("sort");
  const orderParam = searchParams.get("order");

  return {
    sort: (allowedFields as readonly string[]).includes(sortParam ?? "") ? (sortParam as F[number]) : fallback,
    order: orderParam === "asc" ? "asc" : "desc",
  };
}

/** Parses a positive integer route param (e.g. `[id]`), or returns null. */
export function parseIntId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
