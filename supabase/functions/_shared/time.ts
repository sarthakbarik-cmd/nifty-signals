// IST time helpers, trading-day checks and session-slot maths. Pure functions.
// India has no DST, so IST is always UTC+05:30. Dates are 'YYYY-MM-DD' strings.

export const IST_OFFSET_MS = 330 * 60 * 1000;
export const MARKET_OPEN_MIN = 9 * 60 + 15; // 09:15
export const MARKET_CLOSE_MIN = 15 * 60 + 30; // 15:30 (last 1-min candle 15:29, last 15-min 15:15)

const pad = (n: number) => String(n).padStart(2, "0");

/** IST wall-clock parts of an instant. */
export function istParts(d: Date): { date: string; minutes: number; hhmm: string } {
  const t = new Date(d.getTime() + IST_OFFSET_MS);
  const date = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  const minutes = t.getUTCHours() * 60 + t.getUTCMinutes();
  return { date, minutes, hhmm: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}` };
}

export const todayIst = (now: Date = new Date()) => istParts(now).date;

/** Instant for an IST wall-clock date + time. */
export function istInstant(date: string, hh = 0, mm = 0): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - IST_OFFSET_MS);
}

export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 0 = Monday … 6 = Sunday (Python weekday()). */
export function weekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

export function diffDays(a: string, b: string): number {
  return Math.round((istInstant(b).getTime() - istInstant(a).getTime()) / 86_400_000);
}

export function daysBetween(start: string, end: string): string[] {
  const n = diffDays(start, end);
  return n < 0 ? [] : Array.from({ length: n + 1 }, (_, i) => addDays(start, i));
}

export function isTradingDay(date: string, holidays: Set<string>): boolean {
  return weekday(date) < 5 && !holidays.has(date);
}

export function nextTradingDay(date: string, holidays: Set<string>): string {
  let n = addDays(date, 1);
  while (!isTradingDay(n, holidays)) n = addDays(n, 1);
  return n;
}

export function prevTradingDay(date: string, holidays: Set<string>): string {
  let p = addDays(date, -1);
  while (!isTradingDay(p, holidays)) p = addDays(p, -1);
  return p;
}

/** Upstox tokens expire at 03:30 IST the next morning: next 03:30 IST strictly after issue. */
export function upstoxTokenExpiry(issued: Date): Date {
  const { date } = istParts(issued);
  let exp = istInstant(date, 3, 30);
  if (issued.getTime() >= exp.getTime()) exp = istInstant(addDays(date, 1), 3, 30);
  return exp;
}

/** Expected candle start times: 15-min -> 09:15…15:15 (25); 1-min -> 09:15…15:29 (375). */
export function sessionSlots(intervalMin: number): string[] {
  const out: string[] = [];
  for (let m = MARKET_OPEN_MIN; m < MARKET_CLOSE_MIN; m += intervalMin) out.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
  return out;
}

/** '2026-11-20T09:15:00+05:30' -> '09:15' (IST). */
export const candleSlot = (ts: string) => istParts(new Date(ts)).hhmm;
/** '2026-11-20T09:15:00+05:30' -> '2026-11-20' (IST). */
export const candleDate = (ts: string) => istParts(new Date(ts)).date;
