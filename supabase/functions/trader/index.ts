// Edge Function `trader` — Practice (paper) trading + the real-account discipline watcher.
// NEVER places, modifies or cancels a real order. Real-account actions are limited to READING positions and
// switching Upstox's Kill Switch for NSE_FO/BSE_FO (lock at the daily limit, unlock the next trading morning).
//
// Owner (dashboard JWT): underlyings | expiries {u} | chain {u, expiry} | state | place {...} | close {id} | tick
// Scheduler (x-cron-secret): guard   — every minute; 09:00–15:30 IST on trading days (unlock, watch, lock, practice backup)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  type GuardDay, guardMessage, guardStep, type Position, PRACTICE_DEFAULTS, practiceGate, practiceTick, type PTrade, UNDERLYINGS,
} from "../_shared/practice.ts";
import { sendTelegram } from "../_shared/notify.ts";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
class HttpError extends Error { constructor(public status: number, m: string) { super(m); } }
const env = (k: string) => Deno.env.get(k) ?? undefined;
const enc = (s: string) => encodeURIComponent(s);
const pad = (n: number) => String(n).padStart(2, "0");
const ist = (d = new Date()) => { const t = new Date(d.getTime() + 330 * 60_000); return { date: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`, hhmm: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}` }; };
const wd = (d: string) => (new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7;

function admin(): SupabaseClient {
  let key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) key = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default;
  return createClient(Deno.env.get("SUPABASE_URL")!, key!, { auth: { persistSession: false, autoRefreshToken: false } });
}
const db = admin();
async function cfg<T = any>(key: string): Promise<T | null> { const { data } = await db.from("app_config").select("value").eq("key", key).maybeSingle(); return (data?.value as T) ?? null; }
async function setCfg(key: string, value: unknown) { const { error } = await db.from("app_config").upsert({ key, value, updated_at: new Date().toISOString() }); if (error) throw new Error(error.message); }
async function log(level: string, message: string, data: Record<string, unknown> = {}) { try { await db.from("logs").insert({ job: "trader", level, message, data }); } catch { /* never break */ } }
async function telegram(text: string) { const app = await cfg<{ dashboard_url?: string }>("app"); await sendTelegram(env("TELEGRAM_BOT_TOKEN"), env("TELEGRAM_CHAT_ID"), text, app?.dashboard_url); }
async function token(): Promise<string | null> { const { data } = await db.rpc("srv_get_token"); return (data as string) ?? null; }

async function up(path: string, init: RequestInit = {}): Promise<any> {
  const t = await token();
  if (!t) throw new HttpError(412, "Upstox not logged in today.");
  const r = await fetch(`https://api.upstox.com${path}`, { ...init, headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${t}`, ...(init.headers ?? {}) } });
  const text = await r.text();
  if (r.status !== 200) throw new HttpError(502, `Upstox HTTP ${r.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}
async function ltps(keys: string[]): Promise<Record<string, number>> {
  if (!keys.length) return {};
  const d = (await up(`/v3/market-quote/ltp?instrument_key=${enc([...new Set(keys)].join(","))}`)).data ?? {};
  const out: Record<string, number> = {};
  for (const v of Object.values(d) as any[]) if (v?.instrument_token) out[v.instrument_token] = Number(v.last_price);
  return out;
}

async function rules() { const s = await cfg<Record<string, any>>("settings"); return { ...PRACTICE_DEFAULTS, ...((s?.practice_rules ?? {}) as Partial<typeof PRACTICE_DEFAULTS>) }; }
async function todays(date: string): Promise<(PTrade & Record<string, any>)[]> {
  const { data, error } = await db.from("practice_trades").select("*").eq("date", date).order("id");
  if (error) throw new Error(error.message);
  return (data ?? []) as any;
}

/** Update open practice trades with live prices (SL / target / cap / trailing; time exit at 15:15). */
async function tick(now = new Date()) {
  const { date, hhmm } = ist(now);
  const r = await rules();
  const open = (await todays(date)).filter((t) => t.status === "OPEN");
  if (!open.length) return 0;
  const px = await ltps(open.map((t) => t.instrument_key));
  let changed = 0;
  for (const t of open) {
    const ltp = px[t.instrument_key];
    if (ltp == null) continue;
    const res = practiceTick(t, ltp, r);
    const exit = res.exit ?? (hhmm >= "15:15" ? { status: "TIME", price: Math.round((ltp - r.slippage) * 100) / 100, pnl: Math.round((ltp - r.slippage - t.entry_price) * t.qty - r.cost) } : null);
    const patch: Record<string, unknown> = { high_water: res.high, sl_price: res.sl, last_price: ltp, updated_at: now.toISOString() };
    if (exit) Object.assign(patch, { status: exit.status, exit_price: exit.price, exit_at: now.toISOString(), pnl_rs: exit.pnl });
    if (exit || res.sl !== t.sl_price || res.high !== t.high_water || ltp !== t.last_price) { await db.from("practice_trades").update(patch).eq("id", t.id); changed++; }
  }
  return changed;
}

async function state() {
  const now = new Date(), { date } = ist(now), r = await rules();
  const trades = await todays(date);
  const closed = trades.filter((t) => t.status !== "OPEN");
  const realised = closed.reduce((a, t) => a + (t.pnl_rs ?? 0), 0);
  const openRisk = trades.filter((t) => t.status === "OPEN").reduce((a, t) => a + Math.max(0, (t.entry_price - t.sl_price) * t.qty), 0);
  const gate = practiceGate(trades, 0, now.toISOString(), r);
  return { date, rules: r, trades, realised: Math.round(realised), open_risk: Math.round(openRisk),
    budget_left: Math.max(0, Math.round(r.loss_limit + Math.min(0, realised) - openRisk)), blocked: gate,
    guard: { day: await cfg("guard_day"), lock: await cfg("guard_lock"), limits: await guardCfg() }, underlyings: UNDERLYINGS };
}

async function guardCfg() { const s = (await cfg<Record<string, any>>("settings")) ?? {}; return { loss_limit: Number(s.guard_loss ?? 3000), target: Number(s.guard_target ?? 1500), enabled: s.guard_enabled !== false }; }

/** Kill Switch for NSE_FO/BSE_FO. action DISABLE = lock, ENABLE = unlock. Only touches segments that need it. */
async function killSwitch(action: "DISABLE" | "ENABLE", only?: string[]) {
  const st = ((await up("/v2/user/kill-switch")).data ?? []) as { segment: string; segment_status: string; kill_switch_enabled: boolean }[];
  const want = (only ?? ["NSE_FO", "BSE_FO"]).filter((s) => st.some((x) => x.segment === s && x.segment_status === "ACTIVE" && x.kill_switch_enabled === (action === "ENABLE")));
  if (!want.length) return { changed: [] as string[], status: st };
  const res = await up("/v2/user/kill-switch", { method: "POST", body: JSON.stringify(want.map((segment) => ({ segment, action }))) });
  return { changed: want, status: res.data };
}

async function guard() {
  const now = new Date(), { date, hhmm } = ist(now);
  const holidays = new Set<string>(((await cfg<{ dates: string[] }>("holidays"))?.dates ?? []));
  if (wd(date) > 4 || holidays.has(date) || hhmm < "09:00" || hhmm > "15:30") return { skipped: "outside market hours" };
  if (!(await token())) return { skipped: "no token" };
  const out: Record<string, unknown> = {};
  // 1. morning unlock of a previous day's app lock (after Upstox's 12-hour cooling period)
  const lock = await cfg<{ locked_at: string; segments: string[] }>("guard_lock");
  if (lock && ist(new Date(lock.locked_at)).date < date && now.getTime() - Date.parse(lock.locked_at) >= 12 * 3600_000) {
    try {
      const k = await killSwitch("ENABLE", lock.segments);
      await db.from("app_config").delete().eq("key", "guard_lock");
      await telegram(`🔓 F&O unlocked for today${k.changed.length ? ` (${k.changed.join(", ")})` : ""}. Daily limits: −₹3,000 loss / +₹1,500 target.`);
      await log("info", "Kill switch: morning unlock", { changed: k.changed });
      out.unlocked = k.changed;
    } catch (e) { await log("warn", `Morning unlock failed: ${(e as Error).message}`); out.unlock_error = (e as Error).message; }
  }
  if (hhmm < "09:15") return out;
  // 2. watch today's real P&L
  const g = await guardCfg();
  if (g.enabled) {
    let day = await cfg<GuardDay>("guard_day");
    if (!day || day.date !== date) day = { date, alerts: [] };
    const positions = ((await up("/v2/portfolio/short-term-positions")).data ?? []) as Position[];
    const s = guardStep(day, positions, g);
    for (const a of s.alerts) await telegram(guardMessage(a, s.pnl, g, s.openFo));
    if (s.lockNow) {
      try {
        const k = await killSwitch("DISABLE");
        day.locked_by_app = true; day.locked_at = now.toISOString(); day.segments = k.changed;
        if (k.changed.length) await setCfg("guard_lock", { locked_at: now.toISOString(), segments: k.changed, trigger: day.trigger });
        await telegram(`🔒 F&O LOCKED (${day.trigger === "LOSS" ? "daily loss limit" : "daily target"}) at ${hhmm} — no new F&O orders for 12 hours. It unlocks automatically tomorrow morning.`);
        await log("info", "Kill switch: locked", { trigger: day.trigger, pnl: s.pnl, changed: k.changed });
      } catch (e) {
        await telegram(`⚠️ Couldn't lock F&O automatically: ${(e as Error).message.slice(0, 160)}. Please switch on the Kill Switch in the Upstox app.`);
        await log("error", `Kill switch lock failed: ${(e as Error).message}`);
      }
    }
    (day as any).pnl = s.pnl; (day as any).open_fo = s.openFo; (day as any).at = hhmm;
    await setCfg("guard_day", day);
    Object.assign(out, { pnl: s.pnl, open_fo: s.openFo, alerts: s.alerts, locked: day.locked_by_app ?? false });
  }
  // 3. practice backup tick (the page ticks every few seconds while open)
  out.practice_updates = await tick(now);
  return out;
}

async function requireOwner(req: Request) {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data.user) throw new HttpError(401, "Not signed in.");
  const { data: ok } = await db.rpc("srv_is_owner", { uid: data.user.id });
  if (!ok) throw new HttpError(403, "Not allowed.");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const body = await req.json().catch(() => ({})) as Record<string, any>;
  const action = String(body.action ?? "");
  try {
    const cron = req.headers.get("x-cron-secret");
    if (cron !== null) {
      const { data: ok } = await db.rpc("srv_check_cron_secret", { p_secret: cron });
      if (!ok) throw new HttpError(401, "Bad scheduler secret.");
      if (action === "guard") return json(await guard());
      throw new HttpError(400, `unknown scheduled action ${action}`);
    }
    await requireOwner(req);
    switch (action) {
      case "underlyings": return json(UNDERLYINGS);
      case "expiries": {
        const u = UNDERLYINGS[String(body.u)]; if (!u) throw new HttpError(400, "unknown underlying");
        const c = ((await up(`/v2/option/contract?instrument_key=${enc(u.key)}`)).data ?? []) as any[];
        const today = ist().date;
        const ex = [...new Set(c.map((x) => String(x.expiry).slice(0, 10)))].filter((e) => e >= today).sort().slice(0, 6);
        return json({ expiries: ex, lot_size: Number(c.find((x) => String(x.expiry).startsWith(ex[0]))?.lot_size ?? 0) });
      }
      case "chain": {
        const u = UNDERLYINGS[String(body.u)]; if (!u) throw new HttpError(400, "unknown underlying");
        const rows = ((await up(`/v2/option/chain?instrument_key=${enc(u.key)}&expiry_date=${String(body.expiry)}`)).data ?? []) as any[];
        const spot = Number(rows[0]?.underlying_spot_price ?? 0);
        const near = rows.map((r) => ({ strike: Number(r.strike_price), ce: { key: r.call_options?.instrument_key, ltp: r.call_options?.market_data?.ltp },
          pe: { key: r.put_options?.instrument_key, ltp: r.put_options?.market_data?.ltp } }))
          .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot)).slice(0, 15).sort((a, b) => a.strike - b.strike);
        await tick();
        return json({ spot, rows: near, state: await state() });
      }
      case "state": await tick(); return json(await state());
      case "tick": await tick(); return json(await state());
      case "place": {
        const u = UNDERLYINGS[String(body.u)]; if (!u) throw new HttpError(400, "unknown underlying");
        const lots = Math.floor(Number(body.lots)), sl = Number(body.sl_pts), tgt = Number(body.tgt_pts);
        if (!(lots >= 1 && lots <= 20)) throw new HttpError(400, "lots must be 1–20");
        if (!(sl > 0)) throw new HttpError(400, "a stop-loss is required");
        if (!(tgt > 0)) throw new HttpError(400, "a target is required");
        const c = ((await up(`/v2/option/contract?instrument_key=${enc(u.key)}`)).data ?? []) as any[];
        const con = c.find((x) => x.instrument_key === body.key);
        if (!con) throw new HttpError(400, "contract not found");
        const r = await rules(), now = new Date(), { date, hhmm } = ist(now);
        if (hhmm < "09:15" || hhmm >= "15:15") throw new HttpError(400, "practice trades only 09:15–15:15");
        const qty = lots * Number(con.lot_size);
        const gate = practiceGate(await todays(date), sl * qty + r.cost, now.toISOString(), r);
        if (gate) throw new HttpError(409, gate);
        const ltp = (await ltps([con.instrument_key]))[con.instrument_key];
        if (!ltp) throw new HttpError(502, "no live price for this option");
        const entry = Math.round((ltp + r.slippage) * 100) / 100;
        const row = { date, underlying: String(body.u), instrument_key: con.instrument_key, symbol: con.trading_symbol, side: con.instrument_type,
          strike: Number(con.strike_price), expiry: String(con.expiry).slice(0, 10), lots, lot_size: Number(con.lot_size), qty, entry_at: now.toISOString(),
          entry_price: entry, sl_pts: sl, tgt_pts: tgt, sl_price: Math.round((entry - sl) * 100) / 100, target_price: Math.round((entry + tgt) * 100) / 100,
          trail: Boolean(body.trail), high_water: entry, last_price: ltp, status: "OPEN" };
        const { error } = await db.from("practice_trades").insert(row);
        if (error) throw new Error(error.message);
        return json(await state());
      }
      case "close": {
        const { data: t } = await db.from("practice_trades").select("*").eq("id", Number(body.id)).eq("status", "OPEN").maybeSingle();
        if (!t) throw new HttpError(404, "no open practice trade with that id");
        const r = await rules(), ltp = (await ltps([t.instrument_key]))[t.instrument_key];
        if (!ltp) throw new HttpError(502, "no live price");
        const price = Math.round((ltp - r.slippage) * 100) / 100;
        await db.from("practice_trades").update({ status: "MANUAL", exit_price: price, exit_at: new Date().toISOString(), last_price: ltp,
          pnl_rs: Math.round((price - t.entry_price) * t.qty - r.cost), updated_at: new Date().toISOString() }).eq("id", t.id);
        return json(await state());
      }
      default: throw new HttpError(400, `unknown action ${action}`);
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    await log("error", `${action} failed: ${(e as Error).message}`);
    return json({ error: (e as Error).message }, 500);
  }
});
