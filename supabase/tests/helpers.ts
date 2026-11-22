// Tiny test helpers + fixtures (no external deps, so tests run offline).
import { aggregate, type Candle, type DayReport } from "../functions/_shared/candles.ts";
import type { Level, LevelsDoc, Store } from "../functions/_shared/jobs.ts";
import type { ChainRow, ExpiryCache, OiLevels } from "../functions/_shared/levels.ts";
import { addDays, istInstant, weekday } from "../functions/_shared/time.ts";
import { UpstoxError } from "../functions/_shared/upstox.ts";

export function eq(actual: unknown, expected: unknown, msg = "") {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected: ${e}\n  actual:   ${a}`);
}
export function ok(cond: unknown, msg = "assertion failed") { if (!cond) throw new Error(msg); }
export async function rejects(fn: () => Promise<unknown>, cls: Function = Error) {
  try { await fn(); } catch (e) { if (e instanceof cls) return e; throw new Error(`wrong error: ${e}`); }
  throw new Error("expected rejection");
}
export function throws(fn: () => unknown, cls: Function = Error) {
  try { fn(); } catch (e) { if (e instanceof cls) return e; throw new Error(`wrong error: ${e}`); }
  throw new Error("expected throw");
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (day: string, minutesFromMidnight: number) =>
  `${day}T${pad(Math.floor(minutesFromMidnight / 60))}:${pad(minutesFromMidnight % 60)}:00+05:30`;
const q = (x: number) => Math.round(Math.round(x / 0.05) * 0.05 * 100) / 100;

/** Deterministic, realistic 375 one-minute candles (prices on the 0.05 grid). */
export function makeDay1m(day: string, start = 24400): Candle[] {
  const out: Candle[] = [];
  let price = start;
  for (let i = 0; i < 375; i++) {
    const step = (((i * 37) % 11) - 5) * 0.65;
    const o = q(price), c = q(price + step);
    out.push({ t: iso(day, 555 + i), o, h: q(Math.max(o, c) + 1.25 + (i % 3) * 0.5), l: q(Math.min(o, c) - 1.1 - (i % 4) * 0.35), c, v: 0, oi: 0 });
    price = c;
  }
  return out;
}

export function makeDay(day: string) {
  const c1 = makeDay1m(day);
  const c15 = aggregate(c1, 15).map(({ n: _n, ...c }) => ({ ...c, oi: 0 }));
  const daily: Candle = {
    t: `${day}T00:00:00+05:30`, o: c1[0].o, h: Math.max(...c1.map((c) => c.h)), l: Math.min(...c1.map((c) => c.l)),
    c: q(c1[c1.length - 1].c + 3.4), v: 0, oi: 0,
  };
  return { c1, c15, daily };
}

export class FakeStore implements Store {
  intraday = new Map<string, Candle[]>();
  daily = new Map<string, Candle>();
  checks = new Map<string, DayReport>();
  levels = new Map<string, Record<string, unknown>>();
  logs: [string, Level, string][] = [];
  instruments: ExpiryCache | null = null;
  invalid: string | null = null;
  constructor(public holidays: { year: number; dates: string[]; updated_at: string } | null = null) {}
  async getHolidays() { return this.holidays; }
  async saveHolidays(year: number, dates: string[], source: string) { this.holidays = { year, dates, updated_at: new Date().toISOString(), ...{ source } } as any; }
  async saveIntraday(d: string, k: "15m" | "1m", c: Candle[]) { this.intraday.set(`${d}|${k}`, c); }
  async saveDaily(d: string, c: Candle) { this.daily.set(d, c); }
  async getDaily(d: string) { return this.daily.get(d) ?? null; }
  async saveCheck(d: string, r: DayReport) { this.checks.set(d, r); }
  async getLevels(d: string) { const l = this.levels.get(d); return l && l.P != null ? (l as unknown as LevelsDoc) : null; }
  async saveLevels(d: string, lv: LevelsDoc) { this.levels.set(d, { ...this.levels.get(d), ...lv }); }
  async saveOi(d: string, oi: OiLevels & { oi_expiry: string }) { this.levels.set(d, { ...this.levels.get(d), ...oi }); }
  async saveInstruments(c: ExpiryCache) { this.instruments = c; }
  async markTokenInvalid(r: string) { this.invalid = r; }
  async log(job: string, level: Level, message: string) { this.logs.push([job, level, message]); }
}

/** Serves synthetic candles for every weekday that isn't a holiday. */
export class FakeClient {
  calls: unknown[][] = [];
  constructor(public today: string, public holidaySet = new Set<string>(), public accessToken: string | null = "tok") {}
  private *days(a: string, b: string) {
    for (let d = a; d <= b; d = addDays(d, 1)) if (weekday(d) < 5 && !this.holidaySet.has(d)) yield d;
  }
  private pick(d: string, unit: string, interval: number): Candle[] {
    const { c1, c15, daily } = makeDay(d);
    return unit === "days" ? [daily] : interval === 1 ? c1 : c15;
  }
  async historicalCandles(_k: string, unit: string, interval: number, a: string, b: string) {
    this.calls.push(["hist", unit, interval, a, b]);
    ok((istInstant(b).getTime() - istInstant(a).getTime()) / 86_400_000 < 31, "chunk exceeds Upstox 1-month limit");
    ok(b < this.today, "historical call must end before today");
    return [...this.days(a, b)].flatMap((d) => this.pick(d, unit, interval));
  }
  async intradayCandles(_k: string, unit: string, interval: number) {
    this.calls.push(["intraday", unit, interval]);
    return this.pick(this.today, unit, interval);
  }
  async marketHolidays() {
    return [...this.holidaySet].map((date) => ({ date, holiday_type: "TRADING_HOLIDAY", closed_exchanges: ["NSE"] }));
  }
  async profile() { return { user_name: "Owner" }; }
  async optionContracts() {
    this.calls.push(["contracts"]);
    return ["2026-11-24", "2026-12-01", "2026-12-29"].flatMap((expiry) => [{ expiry, lot_size: 75 }, { expiry, lot_size: 75 }]);
  }
  async optionChain(_k: string, expiry: string): Promise<ChainRow[]> {
    this.calls.push(["chain", expiry]);
    const oi: [number, number, number][] = [[24400, 10, 900], [24500, 300, 500], [24600, 800, 100], [24700, 650, 20]];
    return oi.map(([k, c, p]) => ({ strike_price: k, underlying_spot_price: 24555, call_options: { market_data: { oi: c } }, put_options: { market_data: { oi: p } } }));
  }
}

export const failing = (msg = "down") => async () => { throw new UpstoxError(msg); };
