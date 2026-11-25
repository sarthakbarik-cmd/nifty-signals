// Phase 3 candle-close scan: resolve the pending signal, evaluate the newest closed 15-min candle,
// gate it, pick the option, size it, store + alert. All I/O is injected so it is unit-testable.
import type { Candle } from "./candles.ts";
import type { LevelsDoc } from "./jobs.ts";
import {
  applyAtrStop, atrSeries, type ChainOpt, ema, evaluateSetup, gateSetup, pickOption, type Setup, type Side, sizePosition,
  type StrategySettings, triggerHit,
} from "./strategy.ts";
import { candleDate, candleSlot } from "./time.ts";

export type Status = "PENDING" | "TRIGGERED" | "CANCELLED" | "SKIPPED" | "TARGET" | "SL" | "TIME_EXIT";
export const TAKEN: Status[] = ["TRIGGERED", "TARGET", "SL", "TIME_EXIT"];

export interface SignalRow {
  id?: number; date: string; b_time: string; side: Side; status: Status; reason: string | null;
  trigger: number; sl: number; target: number; r: number; valid_until: string;
  strike?: number | null; expiry?: string | null; option_key?: string | null; delta?: number | null;
  ltp?: number | null; prem_sl?: number | null; prem_target?: number | null;
  lot_size?: number | null; lots?: number | null; risk_rs?: number | null;
  triggered_at?: string | null; details?: Record<string, unknown>;
  entry_premium?: number | null; exit_premium?: number | null; exit_reason?: string | null; closed_at?: string | null;
  pnl_rs?: number | null;
}

export interface ScanDeps {
  today: string;
  candles: Candle[];                     // closed 15-min candles, oldest first, incl. previous days
  levels: LevelsDoc & { maxCallOI?: number | null; maxPutOI?: number | null };
  settings: StrategySettings;
  signalsToday: SignalRow[];
  chain: () => Promise<{ rows: ChainOpt[]; expiry: string; lotSize: number } | null>;
  insert: (row: SignalRow) => Promise<void>;
  update: (id: number, patch: Partial<SignalRow>) => Promise<void>;
  notify: (text: string) => Promise<void>;
  log: (level: "info" | "warn", msg: string, data?: Record<string, unknown>) => Promise<void>;
}

const fmt = (x: number) => x.toLocaleString("en-IN", { maximumFractionDigits: 2 });
const fmt0 = (x: number) => Math.round(x).toLocaleString("en-IN");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const expLabel = (d?: string | null) => d ? `${Number(d.slice(8, 10))}-${MON[Number(d.slice(5, 7)) - 1]}` : "";
const addMin = (hhmm: string, m: number) => {
  const t = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) + m;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

export function pendingMessage(s: SignalRow): string {
  const notes = (s.details?.real_money_notes as string[] | undefined) ?? [];
  const atr = s.details?.sl_mode === "atr";
  return [
    `NIFTY ${s.side} SIGNAL  (PENDING)${s.details?.paper ? " · 📝 paper" : ""}`,
    `Buy ${fmt0(s.strike!)} ${s.side}  ${expLabel(s.expiry)} expiry`,
    `If Nifty ${s.side === "CE" ? "crosses" : "falls below"} ${fmt(s.trigger)} by ${s.valid_until}`,
    `SL: Nifty ${fmt(s.sl)}  | premium ~${fmt0(s.prem_sl!)}`,
    `Target: Nifty ${fmt(s.target)} | premium ~${fmt0(s.prem_target!)}`,
    `Lots: ${s.lots} (lot size ${s.lot_size}) | Risk ≈ ₹${fmt0(s.risk_rs!)}`,
    "",
    `Why: ${s.side === "CE" ? "uptrend" : "downtrend"}, pullback to EMA20, ${(s.details?.confirmation as string) ?? "confirmation"} on the ${s.b_time} candle. Premium now ~${fmt0(s.ltp!)} (delta ${s.delta}).${atr ? ` SL = 1 ATR (${fmt(s.r)} pts).` : ""}`,
    ...(notes.length ? ["", `Real money: ${notes.join("; ")}`] : []),
  ].join("\n");
}

export function skippedMessage(s: SignalRow): string {
  return [
    `⚪ NIFTY ${s.side} setup SKIPPED (${s.b_time} candle)`,
    `Reason: ${s.reason}`,
    `Would have been: trigger ${fmt(s.trigger)} · SL ${fmt(s.sl)} · target ${fmt(s.target)} · R ${fmt(s.r)} pts`,
  ].join("\n");
}

/** One scan. Returns a short summary for logs. */
export async function runScan(d: ScanDeps): Promise<Record<string, unknown>> {
  const today = d.today;
  const todays = d.candles.filter((c) => candleDate(c.t) === today);
  const out: Record<string, unknown> = { candles_today: todays.length };
  if (!todays.length) return { ...out, result: "no closed candle yet today" };

  // 1. resolve PENDING signals with the candle after B
  for (const s of d.signalsToday.filter((x) => x.status === "PENDING")) {
    const next = todays.find((c) => candleSlot(c.t) === addMin(s.b_time, 15));
    if (!next) continue;
    const hit = triggerHit(s.side, s.trigger, next);
    const patch: Partial<SignalRow> = hit
      ? { status: "TRIGGERED", triggered_at: `${today}T${candleSlot(next.t)}`, reason: `trigger hit in the ${candleSlot(next.t)} candle` }
      : { status: "CANCELLED", reason: `trigger ${fmt(s.trigger)} not reached by ${s.valid_until}` };
    await d.update(s.id!, patch);
    Object.assign(s, patch);
    await d.notify(hit
      ? `✅ NIFTY ${s.side} TRIGGERED — Nifty ${s.side === "CE" ? "crossed" : "fell below"} ${fmt(s.trigger)} (${candleSlot(next.t)}–${addMin(candleSlot(next.t), 15)} candle).\nPaper trade open: Buy ${fmt0(s.strike!)} ${s.side} ${expLabel(s.expiry)} · ${s.lots} lot(s)\nSL Nifty ${fmt(s.sl)} · Target Nifty ${fmt(s.target)}`
      : `❌ NIFTY ${s.side} signal CANCELLED — trigger ${fmt(s.trigger)} not reached by ${s.valid_until}.`);
    out.resolved = `${s.side} ${s.b_time} → ${patch.status}`;
  }

  // 2. evaluate B = newest closed candle (once per candle)
  const b = todays[todays.length - 1];
  const bTime = candleSlot(b.t);
  out.b_time = bTime;
  if (d.signalsToday.some((x) => x.b_time === bTime)) return { ...out, result: "already evaluated" };
  const closes = d.candles.map((c) => c.c);
  const e20 = ema(closes, d.settings.ema_fast), e50 = ema(closes, d.settings.ema_slow);
  const ev = evaluateSetup(d.candles, e20, e50, d.levels, d.settings);
  if (ev.kind === "none") {
    await d.log("info", `${bTime} candle: no signal — ${ev.reason}`, ev.details);
    return { ...out, result: "none", reason: ev.reason };
  }
  let st: Setup = ev.setup;
  if (d.settings.sl_mode === "atr") {
    const atrB = atrSeries(d.candles)[d.candles.length - 1];
    if (atrB == null) return { ...out, result: "none", reason: "ATR still warming up" };
    st = applyAtrStop(st, atrB, d.settings);
  }

  // 3. gates
  const tradesToday = d.signalsToday.filter((x) => TAKEN.includes(x.status)).length;
  const busy = d.signalsToday.some((x) => x.status === "PENDING" || x.status === "TRIGGERED");
  const pnlToday = d.signalsToday.reduce((a, x) => a + (x.pnl_rs ?? 0), 0);
  const base: SignalRow = {
    date: today, b_time: bTime, side: st.side, status: "SKIPPED", reason: null, trigger: st.trigger, sl: st.sl,
    target: st.target, r: st.R, valid_until: st.validUntil, details: st.details,
  };
  const skip = async (reason: string) => {
    const row = { ...base, reason };
    await d.insert(row);
    await d.notify(skippedMessage(row));
    await d.log("info", `${bTime} candle: ${st.side} setup SKIPPED — ${reason}`, st.details);
    return { ...out, result: "skipped", reason };
  };
  const gate = gateSetup(st, { todayOpen: todays[0].o, tradesToday, busy, lossToday: Math.max(0, -pnlToday) }, d.levels, d.settings);
  if (gate) return await skip(gate);

  // 4. option + size (§7)
  const ch = await d.chain();
  if (!ch) return await skip("option chain unavailable");
  const pick = pickOption(ch.rows, st.side, b.c);
  if (!pick || !pick.ltp || !pick.delta) return await skip("no usable option price/delta in the chain");
  const size = sizePosition(st.R, pick.delta, ch.lotSize, d.settings);
  const notes: string[] = [];
  if (st.R > d.settings.max_sl_pts) notes.push(`SL ${st.R} pts is wider than the ${d.settings.max_sl_pts}-pt limit`);
  if (size.lots < 1) notes.push(`1 lot risks ₹${fmt0(size.perLot)} (> ₹${fmt0(size.budget)} budget)`);
  if (d.settings.paper_mode && size.lots < 1) Object.assign(size, { lots: 1, risk: size.perLot });
  const opt = {
    strike: pick.strike, expiry: ch.expiry, option_key: pick.key, delta: pick.delta, ltp: pick.ltp,
    prem_sl: Math.max(0, Math.round((pick.ltp - st.R * pick.delta) * 100) / 100),
    prem_target: Math.round((pick.ltp + d.settings.target_r * st.R * pick.delta) * 100) / 100,
    lot_size: ch.lotSize, lots: size.lots, risk_rs: size.risk,
  };
  Object.assign(base, opt, { details: { ...st.details, atm: pick.atm, itm_shift: pick.itmShift, paper: d.settings.paper_mode, real_money_notes: notes } });
  if (size.lots < 1) return await skip(`risk too high for 1 lot (1 lot risks ₹${size.perLot} > ₹${size.budget})`);

  const row: SignalRow = { ...base, status: "PENDING", reason: "setup confirmed" };
  await d.insert(row);
  await d.notify(pendingMessage(row));
  await d.log("info", `${bTime} candle: ${st.side} signal PENDING — trigger ${st.trigger}, SL ${st.sl}, R ${st.R}`, st.details);
  return { ...out, result: "pending", side: st.side, trigger: st.trigger };
}
