// Quick target on top of B's signals — research only. Rules fixed before testing (26 Nov 2026):
//   Entries = variant B's backtest trades (same signal, entry minute and price = B's trigger).
//   Target +10 premium (≈ +20 Nifty at delta 0.5). L: SL 10 premium (≈ 20 Nifty). M: B's own ATR stop.
//   First of SL / target on 1-min candles (same minute → SL), else exit 15:15. One exit per signal.
import type { Candle } from "./candles.ts";
import { candleSlot } from "./time.ts";

export function quickExit(side: "CE" | "PE", entry: number, entryMin: string, sl: number, oneMin: Candle[], targetPts = 20) {
  const up = side === "CE", tgt = entry + (up ? targetPts : -targetPts);
  const rest = oneMin.filter((c) => { const s = candleSlot(c.t); return s >= entryMin && s < "15:15"; });
  for (const c of rest) {
    if (up ? c.l <= sl : c.h >= sl) return { status: "SL" as const, exit: candleSlot(c.t), price: sl };
    if (up ? c.h >= tgt : c.l <= tgt) return { status: "TARGET" as const, exit: candleSlot(c.t), price: tgt };
  }
  const last = rest[rest.length - 1];
  return { status: "TIME_EXIT" as const, exit: "15:15", price: last ? last.c : entry };
}
// Run by the deployed `backtest` function (v5) over B's stored backtest trades.
// Result (Nov 2025 – Nov 2026, 3 lots, ₹255 costs): L (SL 10 prem) +₹4,215 / 37 trades; M (B's ATR SL) −₹14,688;
// B itself with its 2R target +₹34,410 on the same entries → B's 2R target kept.
