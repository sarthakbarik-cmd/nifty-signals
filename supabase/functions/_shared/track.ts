// Phase 4 paper tracking (every minute while a signal is pending/open). SIGNALS ONLY: no orders.
//  • PENDING  → TRIGGERED as soon as a 1-min candle in the validity window hits the trigger.
//  • TRIGGERED → SL / TARGET (first hit on 1-min candles; same minute → SL) or TIME_EXIT at 15:15.
//  • Paper fill = the option's own 1-min close at the entry and exit minutes (real premiums, so time decay counts).
import { simulateExit } from "./backtest.ts";
import type { Candle } from "./candles.ts";
import type { SignalRow } from "./scan.ts";
import type { StrategySettings } from "./strategy.ts";
import { candleSlot } from "./time.ts";

export interface TrackDeps {
  today: string;
  now: string;                                  // IST HH:MM
  signals: SignalRow[];                         // today's
  oneMin: Candle[];                             // Nifty 1-min, closed candles only, today
  optionCandles: (key: string) => Promise<Candle[]>; // option 1-min, today
  settings: StrategySettings;
  update: (id: number, patch: Partial<SignalRow>) => Promise<void>;
  notify: (text: string) => Promise<void>;
}

const fmt = (x: number) => x.toLocaleString("en-IN", { maximumFractionDigits: 2 });
const fmt0 = (x: number) => Math.round(x).toLocaleString("en-IN");
const addMin = (hhmm: string, m: number) => {
  const t = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) + m;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Option close at a minute (or the nearest earlier minute). */
export function premiumAt(c: Candle[], hhmm: string): number | null {
  let best: Candle | null = null;
  for (const k of c) if (candleSlot(k.t) <= hhmm) best = k;
  return best ? best.c : null;
}

export const EXIT_LABEL = { TARGET: "🎯 TARGET hit", SL: "🛑 SL hit", TIME_EXIT: "⏰ 15:15 exit" } as const;

export async function runTrack(d: TrackDeps): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const s of d.signals) {
    const from = addMin(s.b_time, 15);
    if (s.status === "PENDING") {
      const hit = d.oneMin.find((c) => {
        const m = candleSlot(c.t);
        return m >= from && m < s.valid_until && (s.side === "CE" ? c.h >= s.trigger : c.l <= s.trigger);
      });
      if (!hit) continue;
      const m = candleSlot(hit.t);
      const prem = premiumAt(await d.optionCandles(s.option_key!), m);
      const patch: Partial<SignalRow> = { status: "TRIGGERED", triggered_at: `${d.today}T${m}`, reason: `trigger hit at ${m}`, entry_premium: prem ?? s.ltp ?? null };
      await d.update(s.id!, patch);
      Object.assign(s, patch);
      await d.notify(`✅ NIFTY ${s.side} TRIGGERED at ${m} — Nifty ${s.side === "CE" ? "crossed" : "fell below"} ${fmt(s.trigger)}.\n📝 Paper trade open: Buy ${fmt0(s.strike!)} ${s.side} · ${s.lots} lot(s) @ ~₹${fmt(patch.entry_premium ?? 0)}\nSL Nifty ${fmt(s.sl)} · Target Nifty ${fmt(s.target)} · exit by 15:15`);
      out[`${s.b_time}`] = "TRIGGERED";
    }
    if (s.status === "TRIGGERED") {
      const ex = simulateExit(s.side, s.trigger, { sl: s.sl, target: s.target, R: s.r }, d.oneMin, from, s.valid_until);
      if (!ex) continue; // the 15-min scan saw the trigger before the 1-min data arrived; check next minute
      if (ex.status === "TIME_EXIT" && d.now < "15:15") {
        if (s.entry_premium == null) {
          const prem = premiumAt(await d.optionCandles(s.option_key!), ex.entry);
          if (prem != null) { await d.update(s.id!, { entry_premium: prem }); s.entry_premium = prem; }
        }
        out[`${s.b_time}`] = "open";
        continue;
      }
      const opt = await d.optionCandles(s.option_key!);
      const entry = s.entry_premium ?? premiumAt(opt, ex.entry) ?? s.ltp ?? 0;
      const exitMin = ex.status === "TIME_EXIT" ? "15:14" : ex.exit;
      const exit = premiumAt(opt, exitMin) ?? entry;
      const qty = (s.lot_size ?? 0) * (s.lots ?? 1);
      const pnl = Math.round((exit - entry) * qty - d.settings.cost_per_trade);
      const pts = r2((s.side === "CE" ? 1 : -1) * (ex.price - s.trigger));
      const patch: Partial<SignalRow> = {
        status: ex.status, entry_premium: entry, exit_premium: exit, closed_at: `${d.today}T${ex.exit}`, pnl_rs: pnl,
        exit_reason: `${ex.status === "TIME_EXIT" ? "15:15 time exit" : ex.status === "SL" ? "SL hit" : "target hit"} at ${ex.exit}; Nifty ${fmt(ex.price)} (${pts >= 0 ? "+" : ""}${pts} pts, ${r2(pts / s.r)}R)`,
      };
      await d.update(s.id!, patch);
      Object.assign(s, patch);
      await d.notify([
        `${EXIT_LABEL[ex.status]} — NIFTY ${fmt0(s.strike!)} ${s.side} (paper)`,
        `Nifty ${fmt(s.trigger)} → ${fmt(ex.price)} (${pts >= 0 ? "+" : ""}${pts} pts, ${r2(pts / s.r)}R) · ${ex.entry}–${ex.exit}`,
        `Premium ₹${fmt(entry)} → ₹${fmt(exit)} × ${qty} qty`,
        `P&L: ${pnl >= 0 ? "+" : "−"}₹${fmt0(Math.abs(pnl))} (after ₹${d.settings.cost_per_trade} costs)`,
      ].join("\n"));
      out[`${s.b_time}`] = ex.status;
    }
  }
  return out;
}
