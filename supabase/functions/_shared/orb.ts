// Opening Range Breakout backtest (research only). Rules fixed before testing (25 Nov 2026):
// OR = 09:15–09:45 high/low; entry = close of the first 15-min candle (09:45–11:45 start) closing outside the OR;
// SL = OR middle; half at 2R, SL to entry, rest exits on a 15-min close back across EMA20 (or 15:15);
// time stop if not +1R within 45 min; 1 trade/day. H = every day, I = narrow-CPR days only.
// Result (Nov 2025 – Nov 2026): H −0.13R/trade over 196 trades, I −0.08R over 144 → not adopted.
import type { Candle } from "./candles.ts";
import { candleDate, candleSlot } from "./time.ts";

type Side = "CE" | "PE";
const r2 = (x: number) => Math.round(x * 100) / 100;
const toMin = (h: string) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function ema(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < n) return out;
  const k = 2 / (n + 1);
  let e = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = e;
  for (let i = n; i < values.length; i++) { e = values[i] * k + e * (1 - k); out[i] = e; }
  return out;
}

export function simulateOrb(side: Side, entry: number, mid: number, entryMin: string, oneMin: Candle[], day15: Candle[], ema20By: Map<string, number | null>) {
  const up = side === "CE", dir = up ? 1 : -1, R = Math.abs(entry - mid);
  const t1 = entry + dir * 2 * R, oneR = entry + dir * R, deadline = toMin(entryMin) + 45;
  let half = false, reached1R = false, stop = mid, t1Time: string | null = null;
  const closes15 = new Map(day15.map((k) => [hhmm(toMin(candleSlot(k.t)) + 15), k]));
  const rest = oneMin.filter((c) => { const s = candleSlot(c.t); return s >= entryMin && s < "15:15"; });
  const done = (slot: string, runner: number, status: "TARGET" | "SL" | "TIME_EXIT", why: string) => ({
    exit: slot, runner, status, why, t1Time, pts: half ? 0.5 * 2 * R + 0.5 * (runner - entry) * dir : (runner - entry) * dir,
  });
  for (const c of rest) {
    const slot = candleSlot(c.t), now = toMin(slot);
    if (half) {
      const k = closes15.get(slot);
      if (k && now > toMin(entryMin)) {
        const e = ema20By.get(k.t);
        if (e != null && (up ? k.c < e : k.c > e)) return done(slot, k.c, "TARGET", "runner: 15-min close across EMA20");
      }
      if (up ? c.l <= stop : c.h >= stop) return done(slot, stop, "TARGET", "runner: back to entry");
      continue;
    }
    if (up ? c.l <= stop : c.h >= stop) return done(slot, stop, "SL", "SL (OR middle)");
    if (up ? c.h >= t1 : c.l <= t1) { half = true; t1Time = slot; stop = entry; continue; }
    if (up ? c.h >= oneR : c.l <= oneR) reached1R = true;
    if (!reached1R && now >= deadline) return done(slot, c.o, "TIME_EXIT", "time stop (no +1R in 45 min)");
  }
  const last = rest[rest.length - 1]?.c ?? entry;
  return done("15:15", last, half ? "TARGET" : "TIME_EXIT", "15:15 exit");
}

export function runOrbBacktest(candles15: Candle[], oneMinByDay: Record<string, Candle[]>, dailies: Record<string, Candle>,
  from: string, to: string, emaN = 20, _band = 20, narrowPct = 0.25) {
  const e20 = ema(candles15.map((c) => c.c), emaN);
  const ema20By = new Map(candles15.map((c, i) => [c.t, e20[i]]));
  const days = [...new Set(candles15.map((c) => candleDate(c.t)))].filter((d) => d >= from && d <= to && oneMinByDay[d]?.length);
  const dailyDates = Object.keys(dailies).sort();
  const out: Record<string, any>[] = [];
  for (const day of days) {
    const prev = dailyDates.filter((d) => d < day).pop();
    if (!prev) continue;
    const d = dailies[prev];
    const p = (d.h + d.l + d.c) / 3, bc = (d.h + d.l) / 2, width = Math.abs(2 * p - 2 * bc);
    const cprPct = (width / p) * 100, narrow = cprPct < narrowPct;
    const day15 = candles15.filter((c) => candleDate(c.t) === day);
    const or = day15.filter((c) => candleSlot(c.t) < "09:45");
    if (or.length < 2) continue;
    const hi = Math.max(...or.map((c) => c.h)), lo = Math.min(...or.map((c) => c.l)), mid = r2((hi + lo) / 2);
    const sig = day15.find((c) => { const t = candleSlot(c.t); return t >= "09:45" && t <= "11:45" && (c.c > hi || c.c < lo); });
    if (!sig) continue;
    const side: Side = sig.c > hi ? "CE" : "PE";
    const entry = sig.c, entryMin = hhmm(toMin(candleSlot(sig.t)) + 15), R = r2(Math.abs(entry - mid));
    const ex = R > 0 ? simulateOrb(side, entry, mid, entryMin, oneMinByDay[day], day15, ema20By) : null;
    for (const v of ["H", "I"]) {
      const base = { variant: v, date: day, side, b_time: candleSlot(sig.t), trigger: entry, sl: mid, r: R, spec_r: R,
        target: r2(entry + (side === "CE" ? 2 : -2) * R), entry_time: null, exit_time: null, exit_price: null, r_mult: null, pnl_pts: null,
        extra: { or_high: hi, or_low: lo, narrow_cpr: narrow, cpr_pct: r2(cprPct) } };
      if (v === "I" && !narrow) { out.push({ ...base, status: "SKIPPED", reason: "CPR not narrow" }); continue; }
      if (!ex) { out.push({ ...base, status: "SKIPPED", reason: "zero risk" }); continue; }
      out.push({ ...base, status: ex.status, reason: ex.why, entry_time: entryMin, exit_time: ex.exit, exit_price: r2(ex.runner),
        r_mult: r2(ex.pts / R), pnl_pts: r2(ex.pts), extra: { ...base.extra, t1_time: ex.t1Time } });
    }
  }
  return out as { variant: string; status: string }[];
}
