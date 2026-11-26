// Quick-trade ("scalp") backtest — research only. Rules fixed before testing (26 Nov 2026, owner's spec):
//   Bias at 09:20 (as in the morning message): above CPR → CE only, below → PE only, inside CPR / near PDC → no trades.
//   First entry 10:00 (ATM option); after each exit re-enter the next minute, same side; max 3 trades; no entry after 15:00.
//   Target +10 premium points (≈ +20 Nifty points at ATM delta 0.5). J: no SL (exit 15:15). K: SL −25 premium (≈ −50 Nifty).
//   Same minute touching SL and target → SL (conservative). 3 lots; ₹ and costs are applied in the report.
import type { Candle } from "./candles.ts";
import { candleSlot } from "./time.ts";

const r2 = (x: number) => Math.round(x * 100) / 100;
export const DELTA = 0.5;

export function bias09_20(price: number, d: { h: number; l: number; c: number }, band = 20): "CE" | "PE" | null {
  const p = (d.h + d.l + d.c) / 3;
  let bc = (d.h + d.l) / 2, tc = 2 * p - bc;
  if (bc > tc) [bc, tc] = [tc, bc];
  if (price >= bc && price <= tc) return null;
  if (Math.abs(price - d.c) <= band) return null;
  return price > tc ? "CE" : "PE";
}

/** One day of quick trades. `slPrem` null = no SL. Returns the trades (index points, + = profit). */
export function scalpDay(oneMin: Candle[], side: "CE" | "PE", targetPrem = 10, slPrem: number | null = null, maxTrades = 3) {
  const dir = side === "CE" ? 1 : -1, tPts = targetPrem / DELTA, sPts = slPrem == null ? null : slPrem / DELTA;
  const mins = oneMin.filter((c) => { const s = candleSlot(c.t); return s >= "10:00" && s < "15:15"; });
  const trades: { entry_time: string; exit_time: string; entry: number; exit: number; pts: number; status: "TARGET" | "SL" | "TIME_EXIT" }[] = [];
  let i = 0;
  while (trades.length < maxTrades && i < mins.length && candleSlot(mins[i].t) <= "15:00") {
    const e = mins[i].o, tgt = e + dir * tPts, sl = sPts == null ? null : e - dir * sPts;
    let j = i, done: (typeof trades)[number] | null = null;
    for (; j < mins.length; j++) {
      const c = mins[j];
      if (sl != null && (dir > 0 ? c.l <= sl : c.h >= sl)) { done = { entry_time: candleSlot(mins[i].t), exit_time: candleSlot(c.t), entry: e, exit: sl, pts: -sPts!, status: "SL" }; break; }
      if (dir > 0 ? c.h >= tgt : c.l <= tgt) { done = { entry_time: candleSlot(mins[i].t), exit_time: candleSlot(c.t), entry: e, exit: tgt, pts: tPts, status: "TARGET" }; break; }
    }
    if (!done) {
      const last = mins[mins.length - 1];
      trades.push({ entry_time: candleSlot(mins[i].t), exit_time: "15:15", entry: e, exit: last.c, pts: r2((last.c - e) * dir), status: "TIME_EXIT" });
      break;
    }
    trades.push(done);
    i = j + 1;
  }
  return trades;
}

export function runScalpBacktest(oneMinByDay: Record<string, Candle[]>, dailies: Record<string, Candle>, from: string, to: string, band = 20) {
  const out: Record<string, unknown>[] = [];
  const dailyDates = Object.keys(dailies).sort();
  for (const day of Object.keys(oneMinByDay).sort()) {
    if (day < from || day > to) continue;
    const prev = dailyDates.filter((d) => d < day).pop();
    if (!prev) continue;
    const m = oneMinByDay[day];
    const at920 = m.find((c) => candleSlot(c.t) >= "09:20");
    if (!at920) continue;
    const side = bias09_20(at920.o, dailies[prev], band);
    for (const [v, sl] of [["J", null], ["K", 25]] as const) {
      if (!side) { out.push({ variant: v, date: day, side: "CE", b_time: "09:20", status: "SKIPPED", reason: "no bias (inside CPR / near previous close)", trigger: at920.o, sl: 0, target: 0, r: 20, spec_r: 20 }); continue; }
      for (const t of scalpDay(m, side, 10, sl)) {
        out.push({ variant: v, date: day, side, b_time: "09:20", status: t.status, reason: null, trigger: t.entry,
          sl: sl == null ? 0 : r2(t.entry - (side === "CE" ? 1 : -1) * sl / DELTA), target: r2(t.entry + (side === "CE" ? 1 : -1) * 10 / DELTA),
          r: 20, spec_r: 20, entry_time: t.entry_time, exit_time: t.exit_time, exit_price: r2(t.exit), pnl_pts: r2(t.pts), r_mult: r2(t.pts / 20) });
      }
    }
  }
  return out;
}

// Result (Nov 2025 – Nov 2026, 3 lots, ₹255 costs/trade): J (no SL) −₹2.48 lakh, K (SL 25) −₹1.17 lakh → not adopted.
