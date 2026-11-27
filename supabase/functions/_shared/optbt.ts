// Real-option-price research (Upstox expired contracts) — research only, no orders, no live effect.
// Rules fixed before testing (27 Nov 2026, approved by the owner):
//  Part 1  B's backtest trades, priced with real premiums:
//          naked = buy 1 lot ATM; spread = buy ATM + sell 150 pts OTM (same expiry). Same entry minute and exit as B.
//          Expiry: current weekly, rolled to the next on expiry day and the trading day before. Costs: ₹125 naked, ₹250 spread.
//  Part 2  Weekly iron condor, 1 lot: enter 15:00 two trading days before expiry; short CE/PE ≈ 1 expected move away
//          (prev-day India VIX, calendar days to expiry), rounded outward to 50; long wings 150 pts further out.
//          Exit: cost-to-close ≤ 50% of credit (target) / ≥ 3× credit, i.e. loss 2× credit (stop) / 15:15 the day before expiry.
//          Skip weeks with India VIX > 25. Costs ₹760 per round trip (₹500 charges + ₹0.5 slippage per leg per side).
//  Prices: 1-min candle CLOSE at the decision minute (forward-filled when a leg has no trade that minute).
import type { Candle } from "./candles.ts";
import { candleSlot } from "./time.ts";

export const LOT = 65;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Weekly expiry to trade on `day` (YYYY-MM-DD): first expiry ≥ day, rolled to the next on expiry day / the day before. */
export function pickExpiry(day: string, expiries: string[], prevTrading: (d: string) => string): string | null {
  const ex = [...expiries].sort();
  const i = ex.findIndex((e) => e >= day);
  if (i < 0) return null;
  const roll = ex[i] === day || prevTrading(ex[i]) === day;
  return roll ? (ex[i + 1] ?? null) : ex[i];
}

export const atmStrike = (spot: number, step = 50) => Math.round(spot / step) * step;

/** Close at minute `hhmm` of `day`, else the latest earlier traded minute (carried over from earlier days). Candles oldest first. */
export function closeAt(c: Candle[], day: string, hhmm: string): number | null {
  const key = `${day} ${hhmm}`;
  let best: number | null = null;
  for (const k of c) {
    if (`${k.t.slice(0, 10)} ${candleSlot(k.t)}` <= key) best = k.c; else break;
  }
  return best;
}

export function condorStrikes(spot: number, vixPct: number, calendarDays: number, wing = 150, step = 50) {
  const em = spot * (vixPct / 100) * Math.sqrt(Math.max(calendarDays, 1) / 365);
  const sc = Math.ceil((spot + em) / step) * step, sp = Math.floor((spot - em) / step) * step;
  return { em: r2(em), sc, sp, lc: sc + wing, lp: sp - wing };
}

export interface Leg { candles: Candle[]; sign: 1 | -1 } // +1 = we hold it (bought), −1 = we sold it

/**
 * Iron condor path on minute closes. `minutes` = ordered [day, hhmm] after entry up to the last exit minute.
 * Value to close = Σ(−sign × price) for shorts… expressed as cost = shorts − longs.
 */
export function simulateCondor(legs: { sc: Candle[]; sp: Candle[]; lc: Candle[]; lp: Candle[] }, entryDay: string, entryMin: string,
  minutes: [string, string][], targetFrac = 0.5, stopMult = 3) {
  const px = (c: Candle[], d: string, m: string) => closeAt(c, d, m);
  const e = { sc: px(legs.sc, entryDay, entryMin), sp: px(legs.sp, entryDay, entryMin), lc: px(legs.lc, entryDay, entryMin), lp: px(legs.lp, entryDay, entryMin) };
  if (Object.values(e).some((v) => v == null)) return null;
  const credit = r2(e.sc! + e.sp! - e.lc! - e.lp!);
  if (credit <= 0) return { credit, status: "SKIPPED" as const, reason: "no credit", exitCost: null, exitDay: null, exitMin: null };
  let last: { cost: number; d: string; m: string } | null = null;
  for (const [d, m] of minutes) {
    const v = [px(legs.sc, d, m), px(legs.sp, d, m), px(legs.lc, d, m), px(legs.lp, d, m)];
    if (v.some((x) => x == null)) continue;
    const cost = r2(v[0]! + v[1]! - v[2]! - v[3]!);
    last = { cost, d, m };
    if (cost <= targetFrac * credit) return { credit, status: "TARGET" as const, reason: "50% of credit captured", exitCost: cost, exitDay: d, exitMin: m };
    if (cost >= stopMult * credit) return { credit, status: "SL" as const, reason: "loss reached 2× credit", exitCost: cost, exitDay: d, exitMin: m };
  }
  if (!last) return null;
  return { credit, status: "TIME_EXIT" as const, reason: "exit 15:15 the day before expiry", exitCost: last.cost, exitDay: last.d, exitMin: last.m };
}

/** Minute grid [day, hhmm] from (entryDay, after entryMin) through exitDay 15:14, trading minutes only. */
export function minuteGrid(entryDay: string, entryMin: string, days: string[], exitDay: string, lastMin = "15:14"): [string, string][] {
  const out: [string, string][] = [];
  const pad = (n: number) => String(n).padStart(2, "0");
  for (const d of days) {
    if (d < entryDay || d > exitDay) continue;
    for (let t = 9 * 60 + 15; t <= 15 * 60 + 29; t++) {
      const m = `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
      if (d === entryDay && m <= entryMin) continue;
      if (d === exitDay && m > lastMin) break;
      out.push([d, m]);
    }
  }
  return out;
}
// Result (real expired-option candles, Nov 2025 – Nov 2026, 1 lot):
//   B naked +₹5,001 / 37 trades; B debit spread −₹6,356; weekly 1-SD iron condor −₹37,144 / 52 weeks (gross +₹2,374 before costs).
