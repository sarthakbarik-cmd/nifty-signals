// Phase 3 rule engine (spec §6–7, interpretation approved in PHASE3_RULES.md). Pure: no I/O.
// SIGNALS ONLY — this module decides and explains; it never places orders.
import type { Candle } from "./candles.ts";
import type { LevelsDoc } from "./jobs.ts";
import { candleSlot } from "./time.ts";

export type Side = "CE" | "PE";

export interface StrategySettings {
  capital: number; risk_pct: number; max_trades: number; max_sl_pts: number; target_r: number;
  gap_pct: number; gap_wait_until: string; no_trade_band: number; entry_start: string; entry_end: string;
  ema_fast: number; ema_slow: number; ema_touch_pct: number; trigger_buffer: number; sl_buffer: number;
  // Phase 4
  sl_mode: string;            // "spec" (pullback extreme) | "atr" (variant B: trigger ∓ ATR(14))
  paper_mode: boolean;        // paper: never skip for SL size / lot budget, just note it
  daily_loss_limit_rs: number; // stop new signals once today's paper loss reaches this (0 = off)
  cost_per_trade: number;     // ₹ brokerage + charges per round trip (paper P&L)
}

export const DEFAULTS: StrategySettings = {
  capital: 50000, risk_pct: 2, max_trades: 2, max_sl_pts: 40, target_r: 2, gap_pct: 0.8, gap_wait_until: "10:00",
  no_trade_band: 20, entry_start: "09:30", entry_end: "14:30", ema_fast: 20, ema_slow: 50, ema_touch_pct: 0.0005,
  trigger_buffer: 5, sl_buffer: 5,
  sl_mode: "spec", paper_mode: false, daily_loss_limit_rs: 0, cost_per_trade: 60,
};

export function settingsFrom(raw: Record<string, unknown>): StrategySettings {
  const out = { ...DEFAULTS } as Record<string, unknown>;
  for (const k of Object.keys(DEFAULTS)) {
    const v = raw[k];
    if (v === undefined || v === null || v === "") continue;
    const t = typeof (DEFAULTS as any)[k];
    out[k] = t === "number" ? Number(v) : t === "boolean" ? (v === true || v === "true") : String(v);
  }
  return out as unknown as StrategySettings;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const toMin = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const pad = (n: number) => String(n).padStart(2, "0");
const minToHhmm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

/** EMA over closes, seeded with the SMA of the first `n` values; null until then. */
export function ema(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < n) return out;
  const k = 2 / (n + 1);
  let e = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = e;
  for (let i = n; i < values.length; i++) { e = values[i] * k + e * (1 - k); out[i] = e; }
  return out;
}

export interface Setup {
  side: Side; b: Candle; bClose: string; trigger: number; sl: number; R: number; target: number;
  validUntil: string; // HH:MM — end of the candle after B
  details: Record<string, unknown>;
}

export type Evaluation =
  | { kind: "none"; reason: string; details?: Record<string, unknown> }
  | { kind: "setup"; setup: Setup };

/**
 * Looks at the last candle (B) of `candles` (closed 15-min candles, oldest first, spanning
 * previous days for EMA warm-up) and returns a setup or the reason there is none.
 */
export function evaluateSetup(
  candles: Candle[], e20: (number | null)[], e50: (number | null)[], lv: LevelsDoc, s: StrategySettings,
): Evaluation {
  const i = candles.length - 1;
  if (i < 4) return { kind: "none", reason: "not enough candles" };
  const b = candles[i];
  const f = e20[i], sl50 = e50[i], f3 = e20[i - 3];
  if (f == null || sl50 == null || f3 == null || e50[i - 3] == null) return { kind: "none", reason: "EMAs still warming up (need more history)" };
  const bCloseMin = toMin(candleSlot(b.t)) + 15;
  const base = { b_time: candleSlot(b.t), close: b.c, ema20: r2(f), ema50: r2(sl50) };

  // 3. bias / no-trade zone (from B's close)
  if (b.c >= lv.BC && b.c <= lv.TC) return { kind: "none", reason: "price inside CPR (no-trade zone)", details: base };
  if (Math.abs(b.c - lv.PDC) <= s.no_trade_band) return { kind: "none", reason: `price within ±${s.no_trade_band} of previous close (no-trade zone)`, details: base };
  const side: Side = b.c > lv.TC ? "CE" : "PE";
  const up = side === "CE";

  // 5. trend
  const trendOk = up ? (f > sl50 && f > f3 && b.c > sl50) : (f < sl50 && f < f3 && b.c < sl50);
  if (!trendOk) return { kind: "none", reason: `${side} bias but 15-min trend not aligned (EMA20 ${r2(f)}, EMA50 ${r2(sl50)}, EMA20 3 candles ago ${r2(f3)})`, details: base };

  // 6. pullback A = 3 candles before B
  const A = [i - 3, i - 2, i - 1];
  const touched = A.some((j) => up ? candles[j].l <= (e20[j] as number) * (1 + s.ema_touch_pct)
                                    : candles[j].h >= (e20[j] as number) * (1 - s.ema_touch_pct));
  if (!touched) return { kind: "none", reason: "no pullback to EMA20 in the last 3 candles", details: base };
  const brokeSlow = [...A, i].some((j) => up ? candles[j].c < (e50[j] as number) : candles[j].c > (e50[j] as number));
  if (brokeSlow) return { kind: "none", reason: `pullback closed ${up ? "below" : "above"} EMA50`, details: base };

  // 7. confirmation candle B
  const range = b.h - b.l;
  const prev = candles[i - 1];
  const colourOk = up ? b.c > b.o : b.c < b.o;
  const thirdOk = range > 0 && (up ? b.c >= b.l + (2 / 3) * range : b.c <= b.h - (2 / 3) * range);
  const engulf = up ? (prev.c < prev.o && b.o <= prev.c && b.c >= prev.o) : (prev.c > prev.o && b.o >= prev.c && b.c <= prev.o);
  if (!colourOk || !(thirdOk || engulf)) {
    return { kind: "none", reason: `pullback seen, but candle B is not a ${up ? "bullish" : "bearish"} confirmation`, details: base };
  }

  // 8. trigger / SL / R / target
  const trigger = up ? b.h + s.trigger_buffer : b.l - s.trigger_buffer;
  const sl = up ? Math.min(...A.map((j) => candles[j].l)) - s.sl_buffer : Math.max(...A.map((j) => candles[j].h)) + s.sl_buffer;
  const R = Math.abs(trigger - sl);
  const target = up ? trigger + s.target_r * R : trigger - s.target_r * R;
  return {
    kind: "setup",
    setup: {
      side, b, bClose: minToHhmm(bCloseMin), trigger: r2(trigger), sl: r2(sl), R: r2(R), target: r2(target),
      validUntil: minToHhmm(bCloseMin + 15),
      details: { ...base, confirmation: thirdOk ? (up ? "close in top third" : "close in bottom third") : "engulfing",
        pullback: A.map((j) => ({ t: candleSlot(candles[j].t), l: candles[j].l, h: candles[j].h, c: candles[j].c, ema20: r2(e20[j] as number) })) },
    },
  };
}

/** Gates applied to a formed setup (§6.1 time/gap/trade limits, §6.4 R and room). null = passes. */
export function gateSetup(
  st: Setup, ctx: { todayOpen: number; tradesToday: number; busy: boolean; lossToday?: number },
  lv: LevelsDoc & { maxCallOI?: number | null; maxPutOI?: number | null }, s: StrategySettings,
): string | null {
  const close = toMin(st.bClose);
  if (close < toMin(s.entry_start) || close > toMin(s.entry_end)) return `outside entry window (${s.entry_start}–${s.entry_end})`;
  const gap = Math.abs(ctx.todayOpen - lv.PDC) / lv.PDC * 100;
  if (gap > s.gap_pct && close < toMin(s.gap_wait_until)) return `gap day (${gap.toFixed(2)}% > ${s.gap_pct}%): no signals before ${s.gap_wait_until}`;
  if (ctx.tradesToday >= s.max_trades) return `max ${s.max_trades} trades for today already taken`;
  if (ctx.busy) return "another signal is already pending/open";
  if (s.daily_loss_limit_rs > 0 && (ctx.lossToday ?? 0) >= s.daily_loss_limit_rs) return `daily loss limit reached (paper loss ₹${Math.round(ctx.lossToday!)} ≥ ₹${s.daily_loss_limit_rs})`;
  if (!s.paper_mode && st.R > s.max_sl_pts) return `SL too wide (R ${st.R} > ${s.max_sl_pts} pts)`;
  const need = s.target_r * st.R;
  const opp = oppositeLevels(st.side, lv).filter((x) => st.side === "CE" ? x.v > st.trigger : x.v < st.trigger)
    .map((x) => ({ ...x, d: Math.abs(x.v - st.trigger) })).sort((a, b) => a.d - b.d);
  if (opp.length && opp[0].d < need) return `no room: ${opp[0].name} ${opp[0].v} is only ${r2(opp[0].d)} pts away (need ${r2(need)})`;
  return null;
}

export function oppositeLevels(side: Side, lv: LevelsDoc & { maxCallOI?: number | null; maxPutOI?: number | null }) {
  const out = side === "CE"
    ? [{ name: "PDH", v: lv.PDH }, { name: "R1", v: lv.R1 }, { name: "R2", v: lv.R2 }, { name: "CPR top", v: lv.TC }, { name: "CPR bottom", v: lv.BC }]
    : [{ name: "PDL", v: lv.PDL }, { name: "S1", v: lv.S1 }, { name: "S2", v: lv.S2 }, { name: "CPR bottom", v: lv.BC }, { name: "CPR top", v: lv.TC }];
  const oi = side === "CE" ? lv.maxCallOI : lv.maxPutOI;
  if (oi != null) out.push({ name: side === "CE" ? "max call OI" : "max put OI", v: oi });
  return out;
}

// --------------------------------------------------------------------------- option + size (§7)
export interface ChainOpt { strike_price: number; underlying_spot_price?: number; call_options?: OptSide; put_options?: OptSide }
interface OptSide { instrument_key?: string; market_data?: { ltp?: number }; option_greeks?: { delta?: number } }

export interface OptionPick { strike: number; key: string; ltp: number; delta: number; atm: number; itmShift: boolean }

export function pickOption(chain: ChainOpt[], side: Side, spot: number): OptionPick | null {
  const rows = chain.filter((r) => (side === "CE" ? r.call_options : r.put_options)?.market_data?.ltp).sort((a, b) => a.strike_price - b.strike_price);
  if (!rows.length) return null;
  let idx = 0;
  rows.forEach((r, k) => { if (Math.abs(r.strike_price - spot) < Math.abs(rows[idx].strike_price - spot)) idx = k; });
  const atm = rows[idx].strike_price;
  const leg = (k: number) => (side === "CE" ? rows[k].call_options : rows[k].put_options)!;
  let d = Math.abs(Number(leg(idx).option_greeks?.delta ?? 0));
  let itmShift = false;
  if (d < 0.5) {
    const k2 = side === "CE" ? idx - 1 : idx + 1; // ITM: lower strike for CE, higher for PE
    if (k2 >= 0 && k2 < rows.length) { idx = k2; itmShift = true; d = Math.abs(Number(leg(idx).option_greeks?.delta ?? 0)); }
  }
  const o = leg(idx);
  return { strike: rows[idx].strike_price, key: String(o.instrument_key ?? ""), ltp: Number(o.market_data?.ltp ?? 0), delta: r2(d * 1000) / 1000, atm, itmShift };
}

export function sizePosition(R: number, delta: number, lotSize: number, s: StrategySettings) {
  const budget = s.capital * s.risk_pct / 100;
  const perLot = R * delta * lotSize;
  const lots = perLot > 0 ? Math.floor(budget / perLot) : 0;
  return { lots, perLot: Math.round(perLot), budget: Math.round(budget), risk: Math.round(lots * perLot) };
}

/** Wilder ATR(n) over candles (null until n candles). */
export function atrSeries(c: Candle[], n = 14): (number | null)[] {
  const out: (number | null)[] = new Array(c.length).fill(null);
  let a = 0;
  for (let i = 0; i < c.length; i++) {
    const tr = i === 0 ? c[i].h - c[i].l : Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
    if (i < n) { a += tr; if (i === n - 1) { a /= n; out[i] = a; } } else { a = (a * (n - 1) + tr) / n; out[i] = a; }
  }
  return out;
}

/** Variant B (approved main plan): SL = trigger ∓ ATR(14) of the 15-min candles at B, target = target_r × R. */
export function applyAtrStop(st: Setup, atrB: number, s: StrategySettings): Setup {
  const up = st.side === "CE", R = r2(atrB);
  const sl = r2(up ? st.trigger - R : st.trigger + R);
  return { ...st, sl, R, target: r2(up ? st.trigger + s.target_r * R : st.trigger - s.target_r * R),
    details: { ...st.details, sl_mode: "atr", atr14: R, spec_sl: st.sl, spec_r: st.R } };
}

/** Phase 3 lifecycle: did the candle after B hit the trigger? */
export function triggerHit(side: Side, trigger: number, next: Candle): boolean {
  return side === "CE" ? next.h >= trigger : next.l <= trigger;
}
