import { ApiError } from "@/lib/api/errors";
import { addDateKeyDays, dateKeyAt, startOfDateKey, weekdayOfDateKey } from "@/lib/timezone";

export const PERIOD_KEYS = ["today", "yesterday", "week", "month", "custom"] as const;
export type PeriodKey = (typeof PERIOD_KEYS)[number];

/** Période de statistiques : `start` inclus, `end` exclu, dans le fuseau de l'organisation. */
export type Period = {
  key: PeriodKey;
  start: Date;
  end: Date;
  /** Premier et dernier jour inclus, au format « AAAA-MM-JJ ». */
  from: string;
  to: string;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Durée maximale d'une période personnalisée (un an et un jour, années bissextiles comprises). */
export const MAX_CUSTOM_PERIOD_DAYS = 366;

/** « AAAA-MM-JJ » d'une date, dans le fuseau du serveur. */
export function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseDateKey(value: string): string | null {
  if (!DATE_PATTERN.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const actual = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  return actual === value ? value : null;
}

function build(key: PeriodKey, from: string, toExclusive: string, timeZone: string): Period {
  const lastDay = addDateKeyDays(toExclusive, -1);
  return {
    key,
    start: startOfDateKey(from, timeZone),
    end: startOfDateKey(toExclusive, timeZone),
    from,
    to: lastDay,
  };
}

/**
 * Lit la période demandée dans l'URL : `?periode=today|yesterday|week|month`
 * ou `?periode=custom&du=AAAA-MM-JJ&au=AAAA-MM-JJ` (un seul jour si `au` est
 * absent). Par défaut : aujourd'hui. La semaine commence le lundi.
 */
export function parsePeriod(params: URLSearchParams, now: Date = new Date(), timeZone = "UTC"): Period {
  const key = (params.get("periode") ?? "today") as PeriodKey;
  const today = dateKeyAt(now, timeZone);

  switch (key) {
    case "yesterday":
      return build(key, addDateKeyDays(today, -1), today, timeZone);
    case "week": {
      const daysSinceMonday = (weekdayOfDateKey(today) + 6) % 7;
      const monday = addDateKeyDays(today, -daysSinceMonday);
      return build(key, monday, addDateKeyDays(monday, 7), timeZone);
    }
    case "month": {
      const monthStart = `${today.slice(0, 7)}-01`;
      const [year, month] = today.slice(0, 7).split("-").map(Number);
      const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
      return build(key, monthStart, nextMonth, timeZone);
    }
    case "custom": {
      const from = parseDateKey(params.get("du") ?? "");
      const to = params.get("au") ? parseDateKey(params.get("au")!) : from;
      if (!from || !to) throw new ApiError(400, "Dates de la période invalides.");
      if (to < from) throw new ApiError(400, "La date de fin doit être postérieure à la date de début.");
      if (addDateKeyDays(from, MAX_CUSTOM_PERIOD_DAYS) <= to) {
        throw new ApiError(400, `Une période personnalisée est limitée à ${MAX_CUSTOM_PERIOD_DAYS} jours.`);
      }
      return build(key, from, addDateKeyDays(to, 1), timeZone);
    }
    default:
      return build("today", today, addDateKeyDays(today, 1), timeZone);
  }
}
