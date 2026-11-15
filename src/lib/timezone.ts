type DateParts = { year: number; month: number; day: number };

function partsAt(date: Date, timeZone: string): DateParts & { hour: number; minute: number; second: number } {
  const values = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (key: string) => Number(values.find((part) => part.type === key)?.value);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute"), second: value("second") };
}

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function dateKeyAt(date: Date, timeZone: string): string {
  const { year, month, day } = partsAt(date, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function addDateKeyDays(key: string, days: number): string {
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/** Converts a local calendar day's midnight in an IANA zone to its UTC instant. */
export function startOfDateKey(key: string, timeZone: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  const targetUtc = Date.UTC(year, month - 1, day);
  let guess = targetUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const local = partsAt(new Date(guess), timeZone);
    const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    const next = targetUtc - (localAsUtc - guess);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

export function startOfZonedDay(date: Date, timeZone: string): Date {
  return startOfDateKey(dateKeyAt(date, timeZone), timeZone);
}

export function zonedMonthKey(date: Date, timeZone: string): string {
  return dateKeyAt(date, timeZone).slice(0, 7);
}

export function weekdayOfDateKey(key: string): number {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}
