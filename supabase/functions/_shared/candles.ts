// Candle grouping, 1m->15m roll-up and data-quality checks (pure).
// "A day's candles are stored correctly" == report status 'ok'.
import { candleDate, candleSlot, MARKET_OPEN_MIN, sessionSlots } from "./time.ts";

export interface Candle { t: string; o: number; h: number; l: number; c: number; v?: number; oi?: number; n?: number }
export interface Issue { severity: "error" | "warn" | "info"; code: string; msg: string }
export interface DayReport {
  date: string;
  status: "ok" | "warn" | "error";
  counts: { "15m": number; "15m_expected": number; "1m": number; "1m_expected": number; daily: number };
  daily: Candle | null;
  issues: Issue[];
}

export const TOLERANCE = 0.06; // index prices move in 0.05 steps
const MAX_LISTED = 10;
const pad = (n: number) => String(n).padStart(2, "0");

export function groupByDate(candles: Candle[]): Record<string, Candle[]> {
  const out: Record<string, Candle[]> = {};
  for (const c of candles) (out[candleDate(c.t)] ??= []).push(c);
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.t.localeCompare(b.t));
  return out;
}

export function aggregate(c1m: Candle[], intervalMin: number): Candle[] {
  const buckets = new Map<string, Candle[]>();
  for (const c of [...c1m].sort((a, b) => a.t.localeCompare(b.t))) {
    const day = candleDate(c.t);
    const [hh, mm] = candleSlot(c.t).split(":").map(Number);
    const start = MARKET_OPEN_MIN + Math.floor((hh * 60 + mm - MARKET_OPEN_MIN) / intervalMin) * intervalMin;
    const key = `${day}T${pad(Math.floor(start / 60))}:${pad(start % 60)}:00+05:30`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(c);
  }
  return [...buckets.keys()].sort().map((t) => {
    const g = buckets.get(t)!;
    return {
      t, o: g[0].o, h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)),
      c: g[g.length - 1].c, v: g.reduce((s, x) => s + (x.v ?? 0), 0), n: g.length,
    };
  });
}

const issue = (severity: Issue["severity"], code: string, msg: string): Issue => ({ severity, code, msg });
const fmtList = (items: string[]) =>
  items.slice(0, MAX_LISTED).join(", ") + (items.length > MAX_LISTED ? ` … (+${items.length - MAX_LISTED} more)` : "");

export const checkOhlc = (c: Candle) =>
  c.l > 0 && c.l <= Math.min(c.o, c.c) && c.h >= Math.max(c.o, c.c) && c.h >= c.l;

export function validateIntraday(candles: Candle[], intervalMin: number, label: string) {
  const expected = sessionSlots(intervalMin);
  const issues: Issue[] = [];
  if (!candles.length) {
    issues.push(issue("error", `${label}_no_data`, `${label}: no candles`));
    return { count: 0, expected: expected.length, issues };
  }
  const seen = new Map<string, number>();
  const badOhlc: string[] = [];
  for (const c of candles) {
    const s = candleSlot(c.t);
    seen.set(s, (seen.get(s) ?? 0) + 1);
    if (!checkOhlc(c)) badOhlc.push(s);
  }
  const expSet = new Set(expected);
  const dupes = [...seen].filter(([, n]) => n > 1).map(([s]) => s).sort();
  const unexpected = [...seen.keys()].filter((s) => !expSet.has(s)).sort();
  const missing = expected.filter((s) => !seen.has(s));
  if (dupes.length) issues.push(issue("error", `${label}_duplicate`, `${label}: duplicate candles at ${fmtList(dupes)}`));
  if (unexpected.length) issues.push(issue("error", `${label}_off_session`, `${label}: candles outside session grid at ${fmtList(unexpected)}`));
  if (missing.length) issues.push(issue("error", `${label}_missing`, `${label}: ${missing.length} missing candles: ${fmtList(missing)}`));
  if (badOhlc.length) issues.push(issue("error", `${label}_bad_ohlc`, `${label}: impossible OHLC at ${fmtList(badOhlc)}`));
  return { count: candles.length, expected: expected.length, issues };
}

export function crossCheck(c1m: Candle[], c15m: Candle[], daily: Candle | null, tol = TOLERANCE): Issue[] {
  const issues: Issue[] = [];
  if (c1m.length && c15m.length) {
    const agg = new Map(aggregate(c1m, 15).map((a) => [candleSlot(a.t), a]));
    const mismatched: string[] = [];
    for (const c of c15m) {
      const a = agg.get(candleSlot(c.t));
      if (!a) continue;
      if ((["o", "h", "l", "c"] as const).some((k) => Math.abs(a[k] - c[k]) > tol)) {
        mismatched.push(`${candleSlot(c.t)} (15m ${c.o}/${c.h}/${c.l}/${c.c} vs 1m ${a.o}/${a.h}/${a.l}/${a.c})`);
      }
    }
    if (mismatched.length) {
      issues.push(issue("warn", "agg_mismatch", `1m→15m roll-up differs from 15m feed in ${mismatched.length} candle(s): ${fmtList(mismatched)}`));
    }
  }
  if (!daily) {
    issues.push(issue("error", "daily_no_data", "daily: no daily candle"));
  } else if (c15m.length) {
    const hi = Math.max(...c15m.map((c) => c.h)), lo = Math.min(...c15m.map((c) => c.l));
    if (Math.abs(hi - daily.h) > tol) issues.push(issue("warn", "daily_high_mismatch", `daily high ${daily.h} vs 15m max high ${hi}`));
    if (Math.abs(lo - daily.l) > tol) issues.push(issue("warn", "daily_low_mismatch", `daily low ${daily.l} vs 15m min low ${lo}`));
    if (Math.abs(c15m[0].o - daily.o) > tol) issues.push(issue("warn", "daily_open_mismatch", `daily open ${daily.o} vs first 15m open ${c15m[0].o}`));
    const diff = Math.round((daily.c - c15m[c15m.length - 1].c) * 100) / 100;
    if (Math.abs(diff) > tol) {
      // Expected: NSE's official index close is not the last traded tick.
      issues.push(issue("info", "official_close", `official close ${daily.c} vs last 15m close ${c15m[c15m.length - 1].c} (diff ${diff}); PDC uses the official close`));
    }
  }
  if (daily && !checkOhlc(daily)) issues.push(issue("error", "daily_bad_ohlc", "daily: impossible OHLC"));
  return issues;
}

export function buildDayReport(date: string, c1m: Candle[], c15m: Candle[], daily: Candle | null): DayReport {
  const v1 = validateIntraday(c1m, 1, "1m");
  const v15 = validateIntraday(c15m, 15, "15m");
  const issues = [...v15.issues, ...v1.issues, ...crossCheck(c1m, c15m, daily)];
  const sev = new Set(issues.map((i) => i.severity));
  return {
    date,
    status: sev.has("error") ? "error" : sev.has("warn") ? "warn" : "ok",
    counts: { "15m": v15.count, "15m_expected": v15.expected, "1m": v1.count, "1m_expected": v1.expected, daily: daily ? 1 : 0 },
    daily,
    issues,
  };
}
