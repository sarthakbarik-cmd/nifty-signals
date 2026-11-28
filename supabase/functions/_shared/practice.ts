// Practice (paper) trading rules + the real-account discipline watcher. Pure: no I/O.
// Owner's rules (28 Nov 2026):
//  Practice: SL and target required (defaults by underlying); each trade also closes at +₹1,500; max 3 trades a day;
//            30-min cooldown after a losing trade; locked for the day once today's loss (closed + open risk) would reach ₹3,000.
//  Trailing (optional per trade): at +1×SL → SL to entry; at +1.5×SL → lock +0.5×SL; then trail 1×SL behind the high.
//  Watcher (real Upstox account, read-only + Kill Switch): alerts at 50% / 80% of the loss limit; at −₹3,000 or +₹1,500
//            the F&O segments are locked with Upstox's Kill Switch as soon as no F&O position is open. Never places orders.

export interface PracticeRules { loss_limit: number; per_trade_cap: number; max_trades: number; cooldown_min: number; cost: number; slippage: number }
export const PRACTICE_DEFAULTS: PracticeRules = { loss_limit: 3000, per_trade_cap: 1500, max_trades: 3, cooldown_min: 30, cost: 60, slippage: 0.5 };

export const UNDERLYINGS: Record<string, { key: string; tgt: number; sl: number; step: number }> = {
  "NIFTY": { key: "NSE_INDEX|Nifty 50", tgt: 20, sl: 10, step: 50 },
  "BANKNIFTY": { key: "NSE_INDEX|Nifty Bank", tgt: 40, sl: 20, step: 100 },
  "FINNIFTY": { key: "NSE_INDEX|Nifty Fin Service", tgt: 20, sl: 10, step: 50 },
  "MIDCPNIFTY": { key: "NSE_INDEX|NIFTY MID SELECT", tgt: 20, sl: 10, step: 25 },
  "SENSEX": { key: "BSE_INDEX|SENSEX", tgt: 40, sl: 20, step: 100 },
  "BANKEX": { key: "BSE_INDEX|BANKEX", tgt: 40, sl: 20, step: 100 },
};

export interface PTrade {
  id?: number; date: string; status: string; qty: number; entry_price: number; sl_price: number; target_price: number;
  sl_pts: number; tgt_pts: number; trail: boolean; high_water: number; exit_at?: string | null; pnl_rs?: number | null;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const openRisk = (t: PTrade) => Math.max(0, (t.entry_price - t.sl_price) * t.qty);

/** Why a new practice trade is refused (null = allowed). `now` is an ISO time. */
export function practiceGate(today: PTrade[], newRisk: number, now: string, r: PracticeRules = PRACTICE_DEFAULTS): string | null {
  if (today.length >= r.max_trades) return `max ${r.max_trades} trades for today already taken`;
  const closed = today.filter((t) => t.status !== "OPEN");
  const realised = closed.reduce((a, t) => a + (t.pnl_rs ?? 0), 0);
  if (-realised >= r.loss_limit) return `day locked: today's loss ₹${Math.round(-realised)} reached the ₹${r.loss_limit} limit`;
  const lastLoss = closed.filter((t) => (t.pnl_rs ?? 0) < 0 && t.exit_at).map((t) => t.exit_at!).sort().pop();
  if (lastLoss) {
    const until = Date.parse(lastLoss) + r.cooldown_min * 60_000;
    if (Date.parse(now) < until) return `cooldown after a loss: next trade allowed at ${new Date(until).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false })}`;
  }
  const open = today.filter((t) => t.status === "OPEN").reduce((a, t) => a + openRisk(t), 0);
  const worst = Math.max(0, -realised) + open + newRisk;
  if (worst > r.loss_limit) return `this trade could take today's loss to ₹${Math.round(worst)} (limit ₹${r.loss_limit}): use a smaller size or SL`;
  return null;
}

/** Step trailing; returns the new SL (never lower). */
export function trailSl(t: PTrade, high: number): number {
  if (!t.trail) return t.sl_price;
  const gain = high - t.entry_price, s = t.sl_pts;
  let sl = t.sl_price;
  if (gain >= s) sl = Math.max(sl, t.entry_price);
  if (gain >= 1.5 * s) sl = Math.max(sl, t.entry_price + 0.5 * s);
  if (gain >= 1.5 * s) sl = Math.max(sl, high - s);
  return r2(sl);
}

/** One price update for an open trade: new high/SL, and an exit if SL / target / ₹ cap is hit. */
export function practiceTick(t: PTrade, ltp: number, r: PracticeRules = PRACTICE_DEFAULTS) {
  const high = Math.max(t.high_water, ltp);
  const sl = trailSl({ ...t, high_water: high }, high);
  const pnl = (p: number) => Math.round((p - t.entry_price) * t.qty - r.cost);
  if (ltp <= sl) return { high, sl, exit: { status: sl > t.entry_price ? "TRAIL" : sl === t.entry_price ? "BREAKEVEN" : "SL", price: r2(ltp - r.slippage), pnl: pnl(ltp - r.slippage) } };
  if (ltp >= t.target_price) return { high, sl, exit: { status: "TARGET", price: r2(ltp - r.slippage), pnl: pnl(ltp - r.slippage) } };
  if ((ltp - t.entry_price) * t.qty >= r.per_trade_cap) return { high, sl, exit: { status: "CAP", price: r2(ltp - r.slippage), pnl: pnl(ltp - r.slippage) } };
  return { high, sl, exit: null };
}

// --------------------------------------------------------------------------- real-account watcher
export interface GuardCfg { loss_limit: number; target: number }
export interface GuardDay { date: string; alerts: string[]; trigger?: "LOSS" | "TARGET" | null; locked_by_app?: boolean; locked_at?: string | null; segments?: string[] }

export interface Position { instrument_token: string; quantity: number; pnl: number }
export const FO = (p: Position) => p.instrument_token.startsWith("NSE_FO|") || p.instrument_token.startsWith("BSE_FO|");

/** Decide alerts and whether to lock. Alerts fire once per day each. */
export function guardStep(day: GuardDay, positions: Position[], cfg: GuardCfg) {
  const pnl = Math.round(positions.reduce((a, p) => a + (Number(p.pnl) || 0), 0));
  const openFo = positions.filter((p) => FO(p) && Number(p.quantity) !== 0).length;
  const alerts: string[] = [];
  const fire = (k: string) => { if (!day.alerts.includes(k)) { day.alerts.push(k); alerts.push(k); } };
  if (pnl <= -0.5 * cfg.loss_limit) fire("L50");
  if (pnl <= -0.8 * cfg.loss_limit) fire("L80");
  if (pnl <= -cfg.loss_limit) { fire("LOSS"); day.trigger ??= "LOSS"; }
  if (pnl >= cfg.target) { fire("TARGET"); day.trigger ??= "TARGET"; }
  const lockNow = Boolean(day.trigger) && !day.locked_by_app && openFo === 0;
  return { pnl, openFo, alerts, lockNow };
}

export function guardMessage(kind: string, pnl: number, cfg: GuardCfg, openFo: number): string {
  const rs = (x: number) => `${x < 0 ? "−" : "+"}₹${Math.abs(x).toLocaleString("en-IN")}`;
  switch (kind) {
    case "L50": return `⚠️ Real account: today ${rs(pnl)} — half of your ₹${cfg.loss_limit.toLocaleString("en-IN")} daily limit used. Slow down.`;
    case "L80": return `⚠️ Real account: today ${rs(pnl)} of −₹${cfg.loss_limit.toLocaleString("en-IN")}. Last chance to stop.`;
    case "LOSS": return `🛑 DAILY LOSS LIMIT HIT (${rs(pnl)}). ${openFo ? "Close your open position now — " : ""}F&O will lock for 12 hours ${openFo ? "the moment you are flat" : "now"}.`;
    case "TARGET": return `🎯 Daily target reached (${rs(pnl)}). ${openFo ? "Close up — " : ""}F&O will lock for 12 hours. Keep practising on the Practice page.`;
    default: return kind;
  }
}
