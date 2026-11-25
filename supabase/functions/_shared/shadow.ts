// Phase 4 background ("shadow") variants: after the close, replay today's stored candles through every
// research variant (A–G, incl. B as a cross-check of the live tracker). Same code as the backtest.
import { runBacktest, runPullbackBacktest } from "./backtest.ts";
import type { Candle } from "./candles.ts";
import type { SignalRow } from "./scan.ts";
import type { StrategySettings } from "./strategy.ts";

export function shadowDay(history15: Candle[], today15: Candle[], today1: Candle[], prevDate: string, prevDaily: Candle, today: string, s: StrategySettings) {
  const c15 = [...history15, ...today15];
  const by = { [today]: today1 };
  const dailies = { [prevDate]: prevDaily };
  return [...runBacktest(c15, by, dailies, today, today, s), ...runPullbackBacktest(c15, by, dailies, today, today, s)];
}

const sign = (x: number) => (x >= 0 ? "+" : "−");
const rs = (x: number) => `${sign(x)}₹${Math.round(Math.abs(x)).toLocaleString("en-IN")}`;

/** Evening paper summary: main plan (B, real premiums) today + since start, and background variants today. */
export function paperSummary(today: string, todays: SignalRow[], allClosed: SignalRow[], shadow: { variant: string; status: string; r_mult: number | null }[], start: string | null): string {
  const closed = todays.filter((s) => ["TARGET", "SL", "TIME_EXIT"].includes(s.status));
  const lines = ["📒 PAPER TRADING — main plan B"];
  if (!closed.length) lines.push("Today: no trades.");
  for (const s of closed) lines.push(`• ${s.b_time} ${s.side} ${s.strike} → ${s.status} · ${rs(s.pnl_rs ?? 0)}`);
  if (closed.length > 1) lines.push(`Today total: ${rs(closed.reduce((a, s) => a + (s.pnl_rs ?? 0), 0))}`);
  if (allClosed.length) {
    const tot = allClosed.reduce((a, s) => a + (s.pnl_rs ?? 0), 0);
    const wins = allClosed.filter((s) => (s.pnl_rs ?? 0) > 0).length;
    lines.push(`Since ${start ?? "start"}: ${allClosed.length} trades · ${wins} winners · ${rs(tot)}`);
  }
  const taken = shadow.filter((t) => ["TARGET", "SL", "TIME_EXIT"].includes(t.status));
  if (taken.length) {
    const by: Record<string, number[]> = {};
    for (const t of taken) (by[t.variant] ??= []).push(t.r_mult ?? 0);
    lines.push("", "Background variants today (R):");
    lines.push(Object.keys(by).sort().map((v) => `${v} ${by[v].map((r) => `${r >= 0 ? "+" : ""}${r}`).join("/")}`).join(" · "));
  } else lines.push("", "Background variants: no trades today.");
  return lines.join("\n");
}
