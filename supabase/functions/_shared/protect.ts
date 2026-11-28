// Level-2 auto-protect decisions (pure). The Oracle executor (fixed IP) carries the actions out; Supabase decides.
// Owner's rules (29 Nov 2026):
//  Upstox  − alerts at 50% / 80% of the loss limit
//          − at −₹3,000: cancel pending F&O orders + exit all F&O positions, then Kill Switch (NSE_FO, BSE_FO)
//          − at +₹1,500: protect a +₹1,000 floor; open trades may run; any NEW F&O position is exited at once;
//            P&L back at the floor → exit all; once flat → Kill Switch
//  Dhan    − Dhan's own P&L Exit (loss 3,000 / profit 1,500, kill switch ON) is set every morning once the token is pasted;
//            Dhan itself exits and locks. We only send the 50% / 80% nudges.
// Never opens a position. The only orders ever sent are exits of existing positions.

export interface ProtectCfg { loss_limit: number; target: number; floor: number }
export const PROTECT_DEFAULTS: ProtectCfg = { loss_limit: 3000, target: 1500, floor: 1000 };

export type Mode = "NORMAL" | "LOSS_EXIT" | "TARGET_PROTECT" | "FLOOR_EXIT" | "LOCKED";
export interface UpDay { date: string; alerts: string[]; mode: Mode; allowed?: Record<string, number>; pnl?: number; at?: string }
export interface UpPos { instrument_token: string; quantity: number; pnl: number }
export type Action = { type: "EXIT_ALL" } | { type: "EXIT"; keys: string[] };

export const isFo = (k: string) => k.startsWith("NSE_FO|") || k.startsWith("BSE_FO|");

/** One decision step for Upstox. Mutates `day` (mode, alerts, allowed sizes). */
export function upstoxDecide(day: UpDay, positions: UpPos[], cfg: ProtectCfg = PROTECT_DEFAULTS) {
  const pnl = Math.round(positions.reduce((a, p) => a + (Number(p.pnl) || 0), 0));
  const open = positions.filter((p) => isFo(p.instrument_token) && Number(p.quantity) !== 0);
  const alerts: string[] = [];
  const actions: Action[] = [];
  const fire = (k: string) => { if (!day.alerts.includes(k)) { day.alerts.push(k); alerts.push(k); } };
  day.pnl = pnl;
  if (day.mode === "LOCKED") return { pnl, openFo: open.length, alerts, actions, lockNow: false };

  if (day.mode === "NORMAL" || day.mode === "TARGET_PROTECT") {
    if (pnl <= -0.5 * cfg.loss_limit) fire("L50");
    if (pnl <= -0.8 * cfg.loss_limit) fire("L80");
  }
  if (pnl <= -cfg.loss_limit && day.mode !== "LOSS_EXIT") { day.mode = "LOSS_EXIT"; fire("LOSS"); }
  if (day.mode === "NORMAL" && pnl >= cfg.target) {
    day.mode = "TARGET_PROTECT";
    day.allowed = Object.fromEntries(open.map((p) => [p.instrument_token, Math.abs(Number(p.quantity))]));
    fire("TARGET");
  }
  if (day.mode === "TARGET_PROTECT") {
    const allowed = day.allowed ?? {};
    const fresh: string[] = [];
    for (const p of positions.filter((x) => isFo(x.instrument_token))) {
      const q = Math.abs(Number(p.quantity)), k = p.instrument_token;
      if (q > (allowed[k] ?? 0)) fresh.push(k);
      else allowed[k] = Math.min(allowed[k] ?? q, q); // a closed or reduced trade can't be re-opened
    }
    day.allowed = allowed;
    if (fresh.length) { actions.push({ type: "EXIT", keys: fresh }); fire("NEW_AFTER_TARGET"); }
    if (pnl <= cfg.floor) { day.mode = "FLOOR_EXIT"; fire("FLOOR"); }
  }
  if ((day.mode === "LOSS_EXIT" || day.mode === "FLOOR_EXIT") && open.length) actions.unshift({ type: "EXIT_ALL" });
  const lockNow = day.mode !== "NORMAL" && open.length === 0 &&
    !(day.mode === "TARGET_PROTECT" && actions.length);
  return { pnl, openFo: open.length, alerts, actions, lockNow };
}

export interface DhanDay { date: string; alerts: string[]; pnl_exit_set?: boolean; pnl?: number; at?: string }
export interface DhanPos { realizedProfit?: number; unrealizedProfit?: number; netQty?: number }

export function dhanDecide(day: DhanDay, positions: DhanPos[], cfg: ProtectCfg = PROTECT_DEFAULTS) {
  const pnl = Math.round(positions.reduce((a, p) => a + (Number(p.realizedProfit) || 0) + (Number(p.unrealizedProfit) || 0), 0));
  const alerts: string[] = [];
  const fire = (k: string) => { if (!day.alerts.includes(k)) { day.alerts.push(k); alerts.push(k); } };
  day.pnl = pnl;
  if (pnl <= -0.5 * cfg.loss_limit) fire("L50");
  if (pnl <= -0.8 * cfg.loss_limit) fire("L80");
  return { pnl, alerts, setPnlExit: !day.pnl_exit_set };
}

const rs = (x: number) => `${x < 0 ? "−" : "+"}₹${Math.abs(x).toLocaleString("en-IN")}`;
export function protectMessage(broker: "Upstox" | "Dhan", kind: string, pnl: number, cfg: ProtectCfg = PROTECT_DEFAULTS): string {
  const L = cfg.loss_limit.toLocaleString("en-IN");
  switch (kind) {
    case "L50": return `⚠️ ${broker}: today ${rs(pnl)} — half of your ₹${L} daily limit used. Slow down.`;
    case "L80": return `⚠️ ${broker}: today ${rs(pnl)} of −₹${L}. Last chance to stop.`;
    case "LOSS": return `🛑 ${broker}: DAILY LOSS LIMIT HIT (${rs(pnl)}). Cancelling F&O orders and exiting all F&O positions, then locking F&O for 12 hours.`;
    case "TARGET": return `🎯 ${broker}: daily target reached (${rs(pnl)}). Open trades may run, but if today's P&L falls to +₹${cfg.floor.toLocaleString("en-IN")} everything is closed. No new trades — F&O locks as soon as you are flat.`;
    case "NEW_AFTER_TARGET": return `⛔ ${broker}: a new F&O position was opened after the target — it is being closed. Practise on the Practice page instead.`;
    case "FLOOR": return `🔐 ${broker}: P&L fell back to the +₹${cfg.floor.toLocaleString("en-IN")} floor (${rs(pnl)}). Exiting all F&O positions and locking.`;
    default: return `${broker}: ${kind}`;
  }
}
