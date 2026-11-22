// Job logic for Phases 1–2, independent of the runtime. `client` is an UpstoxClient,
// `store` implements Store (SupabaseStore in production, a fake in tests).
import { buildDayReport, type Candle, type DayReport, groupByDate } from "./candles.ts";
import { computeLevels, type ExpiryCache, type Levels, maxOiStrikes, type OiLevels, selectExpiries } from "./levels.ts";
import { addDays, daysBetween, diffDays, istParts, isTradingDay, isValidDate, nextTradingDay, prevTradingDay } from "./time.ts";
import { NIFTY_INDEX_KEY, nseTradingHolidays, type UpstoxClient, UpstoxError } from "./upstox.ts";

export const HOLIDAY_CACHE_DAYS = 7;
export const HISTORICAL_CHUNK_DAYS = 28; // Upstox: ≤ 1 month per 1–15 minute request
export const MAX_BACKFILL_DAYS = 15;     // per call — keeps each run inside the Edge Function CPU budget

export type LevelsDoc = Levels & { based_on: string };
export type Level = "info" | "warn" | "error";

export interface Store {
  getHolidays(): Promise<{ year: number; dates: string[]; updated_at: string } | null>;
  saveHolidays(year: number, dates: string[], source: string): Promise<void>;
  saveIntraday(date: string, key: "15m" | "1m", candles: Candle[], source: string): Promise<void>;
  saveDaily(date: string, candle: Candle, source: string): Promise<void>;
  getDaily(date: string): Promise<Candle | null>;
  saveCheck(date: string, report: DayReport & { levels_for?: string }): Promise<void>;
  getLevels(date: string): Promise<LevelsDoc | null>;
  saveLevels(date: string, levels: LevelsDoc): Promise<void>;
  saveOi(date: string, oi: OiLevels & { oi_expiry: string }): Promise<void>;
  saveInstruments(cache: ExpiryCache): Promise<void>;
  markTokenInvalid(reason: string): Promise<void>;
  log(job: string, level: Level, message: string, data?: Record<string, unknown>): Promise<void>;
}

type Client = Pick<UpstoxClient, "accessToken" | "profile" | "historicalCandles" | "intradayCandles" | "optionContracts" | "optionChain" | "marketHolidays">;

// --------------------------------------------------------------------------- holidays
export async function resolveHolidays(client: Client, store: Store, today: string, now = new Date()): Promise<Set<string>> {
  const cached = await store.getHolidays();
  const year = Number(today.slice(0, 4));
  const fresh = cached && cached.year === year && cached.updated_at &&
    now.getTime() - new Date(cached.updated_at).getTime() < HOLIDAY_CACHE_DAYS * 86_400_000;
  if (fresh) return new Set(cached!.dates);
  try {
    const dates = nseTradingHolidays(await client.marketHolidays());
    await store.saveHolidays(year, dates, "upstox");
    return new Set([...(cached?.dates ?? []), ...dates]);
  } catch (e) {
    if (!(e instanceof UpstoxError)) throw e;
    await store.log("holidays", "warn", `Holiday refresh failed, using cache (${cached?.dates.length ?? 0} dates): ${e.message}`);
    return new Set(cached?.dates ?? []);
  }
}

// --------------------------------------------------------------------------- fetching
export interface DayData { "1m": Candle[]; "15m": Candle[]; daily: Candle | null; source: string }

/** Past days via the historical endpoint (≤28-day chunks); `today` via the intraday endpoint. */
export async function fetchRange(client: Client, start: string, end: string, today: string): Promise<Record<string, DayData>> {
  const out: Record<string, DayData> = {};
  const slot = (d: string, source: string) => (out[d] ??= { "1m": [], "15m": [], daily: null, source });
  const yesterday = addDays(today, -1);
  const histEnd = end < yesterday ? end : yesterday;
  let cs = start;
  while (cs <= histEnd) {
    const ceCand = addDays(cs, HISTORICAL_CHUNK_DAYS - 1);
    const ce = ceCand < histEnd ? ceCand : histEnd;
    for (const [key, interval] of [["1m", 1], ["15m", 15]] as const) {
      const rows = await client.historicalCandles(NIFTY_INDEX_KEY, "minutes", interval, cs, ce);
      for (const [d, cs2] of Object.entries(groupByDate(rows))) slot(d, "historical")[key] = cs2;
    }
    for (const [d, rows] of Object.entries(groupByDate(await client.historicalCandles(NIFTY_INDEX_KEY, "days", 1, cs, ce)))) {
      slot(d, "historical").daily = rows[rows.length - 1];
    }
    cs = addDays(ce, 1);
  }
  if (start <= today && today <= end) {
    for (const [key, interval] of [["1m", 1], ["15m", 15]] as const) {
      slot(today, "intraday")[key] = groupByDate(await client.intradayCandles(NIFTY_INDEX_KEY, "minutes", interval))[today] ?? [];
    }
    const d = groupByDate(await client.intradayCandles(NIFTY_INDEX_KEY, "days", 1))[today] ?? [];
    slot(today, "intraday").daily = d.length ? d[d.length - 1] : null;
  }
  return out;
}

export async function saveLevelsFromDaily(store: Store, day: string, daily: Candle, holidays: Set<string>, band: number) {
  const target = nextTradingDay(day, holidays);
  const lv: LevelsDoc = { ...computeLevels(daily, band), based_on: day };
  await store.saveLevels(target, lv);
  return { target, lv };
}

export type RangeReport = DayReport & { levels_for?: string; levels?: LevelsDoc };

/** Fetch, save and validate every day in the range; compute next-day levels from each daily candle. */
export async function storeRange(
  client: Client, store: Store, start: string, end: string, today: string, holidays: Set<string>, band = 20,
): Promise<RangeReport[]> {
  const fetched = await fetchRange(client, start, end, today);
  const reports: RangeReport[] = [];
  for (const day of daysBetween(start, end)) {
    let data = fetched[day];
    const hasData = Boolean(data && (data["1m"].length || data["15m"].length || data.daily));
    if (!hasData && !isTradingDay(day, holidays)) continue; // weekend/holiday: nothing expected
    data ??= { "1m": [], "15m": [], daily: null, source: "none" };
    // Never overwrite stored data with an empty response.
    if (data["15m"].length) await store.saveIntraday(day, "15m", data["15m"], data.source);
    if (data["1m"].length) await store.saveIntraday(day, "1m", data["1m"], data.source);
    if (data.daily) await store.saveDaily(day, data.daily, data.source);
    const report: RangeReport = buildDayReport(day, data["1m"], data["15m"], data.daily);
    if (data.daily) {
      const { target, lv } = await saveLevelsFromDaily(store, day, data.daily, holidays, band);
      report.levels_for = target;
      report.levels = lv;
    }
    if (!isTradingDay(day, holidays)) {
      report.issues.push({ severity: "info", code: "non_trading_day", msg: "data found on a day marked as holiday/weekend (special session?)" });
    }
    const { levels: _omit, ...toSave } = report;
    await store.saveCheck(day, toSave);
    reports.push(report);
  }
  return reports;
}

// --------------------------------------------------------------------------- scheduled jobs
/** 15:45 `daily_levels`: store today's candles, validate, compute next trading day's levels. */
export async function runEod(client: Client, store: Store, today: string, holidays: Set<string>, band = 20): Promise<RangeReport> {
  const [report] = await storeRange(client, store, today, today, today, holidays, band);
  await store.log("daily_levels", report.status === "error" ? "error" : "info", `Stored candles for ${today}: ${report.status}`, { counts: report.counts });
  if (report.levels) {
    const { P, BC, TC, R1, S1, PDH, PDL, PDC } = report.levels;
    await store.log("daily_levels", "info", `Levels for ${report.levels_for} computed from ${today}`, { P, BC, TC, R1, S1, PDH, PDL, PDC });
  } else {
    await store.log("daily_levels", "error", `No daily candle for ${today}; next-day levels NOT computed`);
  }
  return report;
}

export type PremarketResult = LevelsDoc & OiLevels & { oi_expiry: string; instruments: ExpiryCache };

/**
 * 09:20 `premarket_check` (after the token check passes):
 * 1. today's levels exist (recompute from the previous trading day if 15:45 was missed);
 * 2. contract cache: expiries, trade expiry, lot size;
 * 3. option chain (current expiry) -> max call-OI / put-OI strikes, merged into today's levels.
 */
export async function runPremarket(client: Client, store: Store, today: string, holidays: Set<string>, band = 20): Promise<PremarketResult> {
  let lv = await store.getLevels(today);
  if (!lv || lv.P == null) {
    const prev = prevTradingDay(today, holidays);
    let daily = await store.getDaily(prev);
    if (!daily) {
      const rows = await client.historicalCandles(NIFTY_INDEX_KEY, "days", 1, prev, prev);
      daily = rows.length ? rows[rows.length - 1] : null;
      if (!daily) throw new UpstoxError(`No daily candle for ${prev}; cannot compute levels for ${today}`);
      await store.saveDaily(prev, daily, "historical");
    }
    lv = (await saveLevelsFromDaily(store, prev, daily, holidays, band)).lv;
    await store.log("premarket_check", "warn", `Levels for ${today} were missing; recomputed from ${prev}`);
  }
  const cache = selectExpiries(await client.optionContracts(NIFTY_INDEX_KEY), today, holidays);
  await store.saveInstruments(cache);
  const oi = { ...maxOiStrikes(await client.optionChain(NIFTY_INDEX_KEY, cache.current_expiry)), oi_expiry: cache.current_expiry };
  await store.saveOi(today, oi);
  await store.log("premarket_check", "info", `OI levels for ${today}: call ${oi.maxCallOI} / put ${oi.maxPutOI}`,
    { expiry: cache.current_expiry, lot_size: cache.lot_size, trade_expiry: cache.trade_expiry });
  return { ...lv, ...oi, instruments: cache };
}

export async function checkToken(client: Client, store: Store): Promise<[boolean, string]> {
  if (!client.accessToken) return [false, "no valid token stored"];
  try {
    const p = await client.profile();
    return [true, p.user_name || "ok"];
  } catch (e) {
    if (!(e instanceof UpstoxError)) throw e;
    await store.markTokenInvalid(e.message);
    return [false, e.message];
  }
}

// --------------------------------------------------------------------------- messages
const n = (x: number) => x.toLocaleString("en-IN", { maximumFractionDigits: 2 });

export function formatReport(r: DayReport): string {
  const c = r.counts;
  const icon = { ok: "✅", warn: "⚠️", error: "❌" }[r.status];
  const lines = [
    `${icon} NIFTY candles ${r.date}: ${r.status.toUpperCase()}`,
    `15m ${c["15m"]}/${c["15m_expected"]} · 1m ${c["1m"]}/${c["1m_expected"]} · daily ${c.daily}/1`,
  ];
  if (r.daily) lines.push(`Day O ${r.daily.o} H ${r.daily.h} L ${r.daily.l} C ${r.daily.c}`);
  for (const i of r.issues) if (i.severity !== "info") lines.push(`- ${i.msg}`);
  return lines.join("\n");
}

export function formatLevels(day: string, lv: LevelsDoc & Partial<PremarketResult>): string {
  const nt = lv.no_trade;
  const lines = [
    `📐 NIFTY levels for ${day} (from ${lv.based_on})`,
    `R2 ${n(lv.R2)} · R1 ${n(lv.R1)}`,
    `CPR ${n(lv.BC)} – ${n(lv.TC)} (P ${n(lv.P)}, width ${n(lv.cpr_width)})`,
    `S1 ${n(lv.S1)} · S2 ${n(lv.S2)}`,
    `PDH ${n(lv.PDH)} · PDL ${n(lv.PDL)} · PDC ${n(lv.PDC)}`,
    `No-trade: inside CPR, or ${n(nt.pdc_low)} – ${n(nt.pdc_high)} (PDC ±${n(nt.pdc_band)})`,
  ];
  if (lv.maxCallOI != null) lines.push(`Max call OI ${n(lv.maxCallOI)} (resistance) · max put OI ${n(lv.maxPutOI!)} (support)`);
  if (lv.instruments) {
    const i = lv.instruments;
    lines.push(`Trade expiry ${i.trade_expiry}${i.rolled_to_next ? " (rolled: expiry day/day before)" : ""} · lot size ${i.lot_size}`);
  }
  return lines.join("\n");
}

/** Validate a backfill request. Today is included only after 15:31 IST. */
export function backfillWindow(from: string, to: string, now: Date): [string, string] {
  if (!isValidDate(from) || !isValidDate(to)) throw new RangeError("Dates must be YYYY-MM-DD.");
  const { date: today, minutes } = istParts(now);
  const cap = minutes < 15 * 60 + 31 ? addDays(today, -1) : today;
  const end = to < cap ? to : cap;
  if (end < from) throw new RangeError("Range is empty (today is only available after 15:31 IST).");
  if (diffDays(from, end) + 1 > MAX_BACKFILL_DAYS) throw new RangeError(`Range too long: max ${MAX_BACKFILL_DAYS} days per request.`);
  return [from, end];
}
