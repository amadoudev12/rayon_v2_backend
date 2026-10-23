import { ApiError } from "@/lib/api/errors";

export const PERIOD_KEYS = ["today", "yesterday", "week", "month", "custom"] as const;
export type PeriodKey = (typeof PERIOD_KEYS)[number];

/** Période de statistiques : `start` inclus, `end` exclu, dans le fuseau du serveur. */
export type Period = {
  key: PeriodKey;
  start: Date;
  end: Date;
  /** Premier et dernier jour inclus, au format « AAAA-MM-JJ ». */
  from: string;
  to: string;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** « AAAA-MM-JJ » d'une date, dans le fuseau du serveur. */
export function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseDateKey(value: string): Date | null {
  if (!DATE_PATTERN.test(value)) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) || toDateKey(date) !== value ? null : date;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function build(key: PeriodKey, start: Date, end: Date): Period {
  return { key, start, end, from: toDateKey(start), to: toDateKey(addDays(end, -1)) };
}

/**
 * Lit la période demandée dans l'URL : `?periode=today|yesterday|week|month`
 * ou `?periode=custom&du=AAAA-MM-JJ&au=AAAA-MM-JJ` (un seul jour si `au` est
 * absent). Par défaut : aujourd'hui. La semaine commence le lundi.
 */
export function parsePeriod(params: URLSearchParams, now: Date = new Date()): Period {
  const key = (params.get("periode") ?? "today") as PeriodKey;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (key) {
    case "yesterday":
      return build(key, addDays(today, -1), today);
    case "week": {
      const daysSinceMonday = (today.getDay() + 6) % 7;
      const monday = addDays(today, -daysSinceMonday);
      return build(key, monday, addDays(monday, 7));
    }
    case "month":
      return build(key, new Date(today.getFullYear(), today.getMonth(), 1), new Date(today.getFullYear(), today.getMonth() + 1, 1));
    case "custom": {
      const from = parseDateKey(params.get("du") ?? "");
      const to = params.get("au") ? parseDateKey(params.get("au")!) : from;
      if (!from || !to) throw new ApiError(400, "Dates de la période invalides.");
      if (to < from) throw new ApiError(400, "La date de fin doit être postérieure à la date de début.");
      return build(key, from, addDays(to, 1));
    }
    default:
      return build("today", today, addDays(today, 1));
  }
}
