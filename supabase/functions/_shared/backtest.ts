// Backtest of the Phase 3 rules with 4 SL/target variants (research only — no orders, no live effect).
//   A  spec:          SL = pullback extreme ∓ 5,             target = 2R
//   B  ATR:           SL = trigger ∓ 1 × ATR(14, 15-min),    target = 2R
//   C  signal candle: SL = B low − 5 (CE) / B high + 5 (PE),  target = 2R
//   D  level target:  SL as B, target = next opposing level if ≥ 1.5R away (none → 2R; too close → skip)
// Exits on 1-min candles: SL or target first; both in one minute → SL; else exit at 15:15.
import type { Candle } from "./candles.ts";
import type { LevelsDoc } from "./jobs.ts";
import { computeLevels } from "./levels.ts";
import { ema, evaluateSetup, oppositeLevels, type Side, type StrategySettings } from "./strategy.ts";
import { candleDate, candleSlot } from "./time.ts";

export type Variant = "A" | "B" | "C" | "D";
export const VARIANTS: Variant[] = ["A", "B", "C", "D"];

export interface BtTrade {
  variant: Variant; date: string; side: Side; b_time: string;
  status: "SKIPPED" | "CANCELLED" | "TARGET" | "SL" | "TIME_EXIT"; reason: string | null;
  trigger: number; sl: number; target: number; r: number; spec_r: number;
  entry_time: string | null; exit_time: string | null; exit_price: number | null;
  r_mult: number | null; pnl_pts: number | null;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Wilder ATR over 15-min candles (null until `n` candles). */
export function atr(c: Candle[], n = 14): (number | null)[] {
  const out: (number | null)[] = new Array(c.length).fill(null);
  let a = 0;
  for (let i = 0; i < c.length; i++) {
    const tr = i === 0 ? c[i].h - c[i].l
      : Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
    if (i < n) { a += tr; if (i === n - 1) { a /= n; out[i] = a; } }
    else { a = (a * (n - 1) + tr) / n; out[i] = a; }
  }
  return out;
}

interface Plan { sl: number; target: number; R: number }

/** SL/target for a variant, or a skip reason. Room check (spec §6.4) applies to A, B, C. */
export function planFor(
  v: Variant, side: Side, trigger: number, specSl: number, b: Candle, atrB: number | null,
  lv: LevelsDoc, s: StrategySettings,
): Plan | string {
  const up = side === "CE", dir = up ? 1 : -1;
  let sl: number;
  if (v === "A") sl = specSl;
  else if (v === "C") sl = up ? b.l - s.sl_buffer : b.h + s.sl_buffer;
  else { if (!atrB) return "ATR not ready"; sl = trigger - dir * atrB; }
  const R = Math.abs(trigger - sl);
  if (R <= 0) return "zero risk";
  const opp = oppositeLevels(side, { ...lv, maxCallOI: null, maxPutOI: null })
    .filter((x) => up ? x.v > trigger : x.v < trigger)
    .map((x) => ({ ...x, d: Math.abs(x.v - trigger) })).sort((a, b) => a.d - b.d);
  if (v === "D") {
    if (!opp.length) return { sl, R, target: trigger + dir * s.target_r * R };
    if (opp[0].d < 1.5 * R) return `no room: ${opp[0].name} only ${r2(opp[0].d)} pts away (need 1.5R ${r2(1.5 * R)})`;
    return { sl, R, target: opp[0].v };
  }
  const need = s.target_r * R;
  if (opp.length && opp[0].d < need) return `no room: ${opp[0].name} only ${r2(opp[0].d)} pts away (need ${r2(need)})`;
  return { sl, R, target: trigger + dir * need };
}

/** Walk 1-min candles from the trigger minute: first of SL / target (same minute → SL), else 15:15. */
export function simulateExit(side: Side, trigger: number, plan: Plan, oneMin: Candle[], fromSlot: string, toSlot: string) {
  const up = side === "CE";
  const win = oneMin.filter((c) => { const s = candleSlot(c.t); return s >= fromSlot && s < toSlot; });
  const entryIdx = win.findIndex((c) => up ? c.h >= trigger : c.l <= trigger);
  if (entryIdx < 0) return null; // trigger never hit in the validity candle
  const entry = candleSlot(win[entryIdx].t);
  const rest = oneMin.filter((c) => { const s = candleSlot(c.t); return s >= entry && s < "15:15"; });
  for (const c of rest) {
    const hitSl = up ? c.l <= plan.sl : c.h >= plan.sl;
    const hitT = up ? c.h >= plan.target : c.l <= plan.target;
    if (hitSl) return { entry, exit: candleSlot(c.t), price: plan.sl, status: "SL" as const };
    if (hitT) return { entry, exit: candleSlot(c.t), price: plan.target, status: "TARGET" as const };
  }
  const last = rest[rest.length - 1];
  return { entry, exit: "15:15", price: last ? last.c : trigger, status: "TIME_EXIT" as const };
}

/**
 * Backtest the trading days in [from, to].
 * candles15: 15-min, oldest first, incl. ≥ 3 weeks before `from` for EMA/ATR warm-up.
 * oneMinByDay: date -> 1-min candles. dailies: date -> daily candle (official close), incl. the day before `from`.
 */
export function runBacktest(
  candles15: Candle[], oneMinByDay: Record<string, Candle[]>, dailies: Record<string, Candle>,
  from: string, to: string, s: StrategySettings,
): BtTrade[] {
  const closes = candles15.map((c) => c.c);
  const e20 = ema(closes, s.ema_fast), e50 = ema(closes, s.ema_slow), at = atr(candles15);
  const days = [...new Set(candles15.map((c) => candleDate(c.t)))].filter((d) => d >= from && d <= to && oneMinByDay[d]?.length);
  const dailyDates = Object.keys(dailies).sort();
  const trades: BtTrade[] = [];

  for (const day of days) {
    const prev = dailyDates.filter((d) => d < day).pop();
    if (!prev) continue;
    const lv: LevelsDoc = { ...computeLevels(dailies[prev], s.no_trade_band), based_on: prev };
    const idxs = candles15.map((c, i) => (candleDate(c.t) === day ? i : -1)).filter((i) => i >= 0);
    const todayOpen = candles15[idxs[0]].o;
    const state = Object.fromEntries(VARIANTS.map((v) => [v, { busyUntil: "00:00", taken: 0 }])) as Record<Variant, { busyUntil: string; taken: number }>;

    for (const i of idxs) {
      const bSlot = candleSlot(candles15[i].t);
      const close = toMin(bSlot) + 15;
      if (close < toMin(s.entry_start) || close > toMin(s.entry_end)) continue;
      const ev = evaluateSetup(candles15.slice(0, i + 1), e20.slice(0, i + 1), e50.slice(0, i + 1), lv, s);
      if (ev.kind === "none") continue;
      const st = ev.setup;
      const gap = Math.abs(todayOpen - lv.PDC) / lv.PDC * 100;
      const nextSlot = st.bClose; // the validity candle starts when B closes
      const endSlot = st.validUntil;
      for (const v of VARIANTS) {
        const sv = state[v];
        const base = { variant: v, date: day, side: st.side, b_time: bSlot, trigger: st.trigger, spec_r: st.R,
          entry_time: null, exit_time: null, exit_price: null, r_mult: null, pnl_pts: null };
        const skip = (reason: string, p?: Plan) =>
          trades.push({ ...base, status: "SKIPPED", reason, sl: r2(p?.sl ?? st.sl), target: r2(p?.target ?? st.target), r: r2(p?.R ?? st.R) });
        if (gap > s.gap_pct && close < toMin(s.gap_wait_until)) { skip("gap day"); continue; }
        if (sv.taken >= s.max_trades) { skip("max trades reached"); continue; }
        if (bSlot < sv.busyUntil) { skip("previous trade still open"); continue; }
        const plan = planFor(v, st.side, st.trigger, st.sl, st.b, at[i], lv, s);
        if (typeof plan === "string") { skip(plan); continue; }
        const ex = simulateExit(st.side, st.trigger, plan, oneMinByDay[day], nextSlot, endSlot);
        if (!ex) {
          trades.push({ ...base, status: "CANCELLED", reason: "trigger not hit in the next candle", sl: r2(plan.sl), target: r2(plan.target), r: r2(plan.R) });
          continue;
        }
        sv.taken++;
        sv.busyUntil = ex.exit;
        const pts = (st.side === "CE" ? 1 : -1) * (ex.price - st.trigger);
        trades.push({ ...base, status: ex.status, reason: null, sl: r2(plan.sl), target: r2(plan.target), r: r2(plan.R),
          entry_time: ex.entry, exit_time: ex.exit, exit_price: r2(ex.price), r_mult: r2(pts / plan.R), pnl_pts: r2(pts) });
      }
    }
  }
  return trades;
}

// ---------------------------------------------------------------------------------------------
// Option 3 "half and half" (research): trend pullback entry, book half at T1, SL to entry, trail rest.
//   E: T1 = 1.5R   F: T1 = 2R   G: as E, only on days that open outside CPR on the trade's side.
export type PbVariant = "E" | "F" | "G";
export const PB_VARIANTS: PbVariant[] = ["E", "F", "G"];
const T1R: Record<PbVariant, number> = { E: 1.5, F: 2, G: 1.5 };

export interface PbSetup { side: Side; trigger: number; sl: number; R: number; bClose: string; validUntil: string; reds: number; greens: number }

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** Trend → ≥2 impulse candles → 1–2 counter candles → resume candle B (last of `c`). */
export function evaluatePullback(c: Candle[], e20: (number | null)[], e50: (number | null)[], lv: LevelsDoc, s: StrategySettings): PbSetup | null {
  const i = c.length - 1;
  if (i < 6) return null;
  const b = c[i], f = e20[i], sl50 = e50[i];
  if (f == null || sl50 == null) return null;
  if (b.c >= lv.BC && b.c <= lv.TC) return null;
  if (Math.abs(b.c - lv.PDC) <= s.no_trade_band) return null;
  const side: Side = b.c > lv.TC ? "CE" : "PE";
  const up = side === "CE";
  const green = (x: Candle) => (up ? x.c > x.o : x.c < x.o);
  const red = (x: Candle) => (up ? x.c < x.o : x.c > x.o);
  if (!(up ? f > sl50 && b.c > f : f < sl50 && b.c < f)) return null;
  const range = b.h - b.l;
  if (!green(b) || range <= 0 || !(up ? b.c >= b.l + range / 2 : b.c <= b.h - range / 2)) return null;
  let reds = 0;
  while (reds < 3 && red(c[i - 1 - reds])) reds++;
  if (reds < 1 || reds > 2) return null;
  const pb = c.slice(i - reds, i);
  if (pb.some((x, k) => { const e = e50[i - reds + k]; return e == null || (up ? x.c < e : x.c > e); })) return null;
  let greens = 0;
  for (let j = i - reds - 1; j >= 0 && greens < 10; j--) {
    const e = e20[j];
    if (e == null || !green(c[j]) || (up ? c[j].c <= e : c[j].c >= e)) break;
    greens++;
  }
  if (greens < 2) return null;
  const trigger = up ? b.h + s.trigger_buffer : b.l - s.trigger_buffer;
  const sl = up ? Math.min(...pb.map((x) => x.l), b.l) - s.sl_buffer : Math.max(...pb.map((x) => x.h), b.h) + s.sl_buffer;
  const close = toMin(candleSlot(b.t)) + 15;
  return { side, trigger: r2(trigger), sl: r2(sl), R: r2(Math.abs(trigger - sl)), bClose: hhmm(close), validUntil: hhmm(close + 15), reds, greens };
}

/** Half at T1, rest trails under each closed 15-min candle (never below entry). Same minute SL+T1 → SL. */
export function simulateHalf(st: PbSetup, t1R: number, oneMin: Candle[], day15: Candle[], buf: number) {
  const up = st.side === "CE", dir = up ? 1 : -1;
  const win = oneMin.filter((c) => { const s = candleSlot(c.t); return s >= st.bClose && s < st.validUntil; });
  const ei = win.findIndex((c) => (up ? c.h >= st.trigger : c.l <= st.trigger));
  if (ei < 0) return null;
  const entry = candleSlot(win[ei].t);
  const t1 = st.trigger + dir * t1R * st.R;
  const rest = oneMin.filter((c) => { const s = candleSlot(c.t); return s >= entry && s < "15:15"; });
  let t1Time: string | null = null, stop = st.sl;
  for (const c of rest) {
    const slot = candleSlot(c.t), now = toMin(slot);
    if (t1Time) {
      for (const k of day15) { // trail with 15-min candles that closed after entry and before this minute
        const kEnd = toMin(candleSlot(k.t)) + 15;
        if (kEnd <= now && kEnd > toMin(entry)) stop = up ? Math.max(stop, k.l - buf) : Math.min(stop, k.h + buf);
      }
      if (up ? c.l <= stop : c.h >= stop) {
        return { entry, t1Time, exit: slot, runner: stop, status: "TARGET" as const, pts: 0.5 * (t1 - st.trigger) * dir + 0.5 * (stop - st.trigger) * dir };
      }
      continue;
    }
    if (up ? c.l <= st.sl : c.h >= st.sl) return { entry, t1Time, exit: slot, runner: st.sl, status: "SL" as const, pts: -st.R };
    if (up ? c.h >= t1 : c.l <= t1) { t1Time = slot; stop = st.trigger; }
  }
  const last = rest[rest.length - 1]?.c ?? st.trigger;
  const pts = t1Time ? 0.5 * t1R * st.R + 0.5 * (last - st.trigger) * dir : (last - st.trigger) * dir;
  return { entry, t1Time, exit: "15:15", runner: last, status: t1Time ? "TARGET" as const : "TIME_EXIT" as const, pts };
}

export function runPullbackBacktest(
  candles15: Candle[], oneMinByDay: Record<string, Candle[]>, dailies: Record<string, Candle>,
  from: string, to: string, s: StrategySettings,
): (Omit<BtTrade, "variant"> & { variant: PbVariant; extra: Record<string, unknown> })[] {
  const e20 = ema(candles15.map((c) => c.c), s.ema_fast), e50 = ema(candles15.map((c) => c.c), s.ema_slow);
  const days = [...new Set(candles15.map((c) => candleDate(c.t)))].filter((d) => d >= from && d <= to && oneMinByDay[d]?.length);
  const dailyDates = Object.keys(dailies).sort();
  const out: (Omit<BtTrade, "variant"> & { variant: PbVariant; extra: Record<string, unknown> })[] = [];
  for (const day of days) {
    const prev = dailyDates.filter((d) => d < day).pop();
    if (!prev) continue;
    const lv: LevelsDoc = { ...computeLevels(dailies[prev], s.no_trade_band), based_on: prev };
    const idxs = candles15.map((c, i) => (candleDate(c.t) === day ? i : -1)).filter((i) => i >= 0);
    const day15 = idxs.map((i) => candles15[i]);
    const open = day15[0].o;
    const gap = Math.abs(open - lv.PDC) / lv.PDC * 100;
    const state = Object.fromEntries(PB_VARIANTS.map((v) => [v, { busyUntil: "00:00", taken: 0 }])) as Record<PbVariant, { busyUntil: string; taken: number }>;
    for (const i of idxs) {
      const bSlot = candleSlot(candles15[i].t), close = toMin(bSlot) + 15;
      if (close < toMin(s.entry_start) || close > toMin(s.entry_end)) continue;
      const st = evaluatePullback(candles15.slice(0, i + 1), e20, e50, lv, s);
      if (!st) continue;
      for (const v of PB_VARIANTS) {
        const sv = state[v];
        const base = { variant: v, date: day, side: st.side, b_time: bSlot, trigger: st.trigger, sl: st.sl, r: st.R, spec_r: st.R,
          target: r2(st.trigger + (st.side === "CE" ? 1 : -1) * T1R[v] * st.R),
          entry_time: null, exit_time: null, exit_price: null, r_mult: null, pnl_pts: null, extra: { reds: st.reds, greens: st.greens } };
        const skip = (reason: string) => out.push({ ...base, status: "SKIPPED", reason });
        if (gap > s.gap_pct && close < toMin(s.gap_wait_until)) { skip("gap day"); continue; }
        if (v === "G" && !(st.side === "CE" ? open > lv.TC : open < lv.BC)) { skip("not a trend day (open inside/against CPR)"); continue; }
        if (sv.taken >= s.max_trades) { skip("max trades reached"); continue; }
        if (bSlot < sv.busyUntil) { skip("previous trade still open"); continue; }
        const ex = simulateHalf(st, T1R[v], oneMinByDay[day], day15, s.sl_buffer);
        if (!ex) { out.push({ ...base, status: "CANCELLED", reason: "trigger not hit in the next candle" }); continue; }
        sv.taken++; sv.busyUntil = ex.exit;
        out.push({ ...base, status: ex.status, reason: null, entry_time: ex.entry, exit_time: ex.exit, exit_price: r2(ex.runner),
          r_mult: r2(ex.pts / st.R), pnl_pts: r2(ex.pts), extra: { ...base.extra, t1_time: ex.t1Time } });
      }
    }
  }
  return out;
}
