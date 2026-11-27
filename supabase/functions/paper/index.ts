// Edge Function `paper` — Phase 4 paper trading (main plan = variant B). SIGNALS ONLY: no order code.
// Auth: scheduler secret (x-cron-secret) only — started by pg_cron.
// Actions: candle_scan (after each 15-min close) | track (every minute) | paper_eod {date?} (after 15:45 job)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { Candle } from "../_shared/candles.ts";
import type { ExpiryCache } from "../_shared/levels.ts";
import { sendTelegram } from "../_shared/notify.ts";
import { runScan, type SignalRow } from "../_shared/scan.ts";
import { DEFAULT_SHADOW, paperSummary, shadowDay } from "../_shared/shadow.ts";
import { SupabaseStore } from "../_shared/store.ts";
import { settingsFrom } from "../_shared/strategy.ts";
import { istParts, isTradingDay, todayIst } from "../_shared/time.ts";
import { runTrack } from "../_shared/track.ts";
import { NIFTY_INDEX_KEY, UpstoxAuthError, UpstoxClient } from "../_shared/upstox.ts";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const env = (k: string) => Deno.env.get(k) ?? undefined;

async function ctx(store: SupabaseStore) {
  const today = todayIst();
  const holidays = new Set<string>(((await store.getHolidays())?.dates ?? []) as string[]);
  const app = await store.app();
  const notify = async (t: string) => { await sendTelegram(env("TELEGRAM_BOT_TOKEN"), env("TELEGRAM_CHAT_ID"), t, app.dashboard_url); };
  return { today, trading: isTradingDay(today, holidays), notify };
}

/** After each 15-min candle close (09:31 … 15:16 IST): resolve pending, evaluate the new candle (variant B). */
async function candleScan(store: SupabaseStore) {
  const { today, trading, notify } = await ctx(store);
  if (!trading) return { skipped: "not a trading day" };
  const token = await store.getValidToken();
  if (!token) { await store.log("candle_scan", "warn", "No Upstox token — scan skipped"); return { skipped: "no token" }; }
  const lv = await store.getLevelsFull({ date: today });
  if (!lv) { await store.log("candle_scan", "warn", `No levels for ${today} — scan skipped`); return { skipped: "no levels" }; }
  const client = new UpstoxClient(token);
  const now = Date.now();
  const intraday = (await client.intradayCandles(NIFTY_INDEX_KEY, "minutes", 15))
    .filter((c) => c.t.startsWith(today) && new Date(c.t).getTime() + 15 * 60_000 <= now);
  return await runScan({
    today, candles: [...await store.recent15m(today, 12), ...intraday], levels: lv, settings: settingsFrom(await store.settings()),
    signalsToday: await store.signalsFor(today),
    chain: async () => {
      const inst = await store.getConfig<ExpiryCache>("instruments");
      if (!inst || inst.for_date !== today) return null;
      return { rows: await client.optionChain(NIFTY_INDEX_KEY, inst.trade_expiry), expiry: inst.trade_expiry, lotSize: inst.lot_size };
    },
    insert: (r) => store.insertSignal(r), update: (id, p) => store.updateSignal(id, p), notify,
    log: (level, m, data) => store.log("candle_scan", level, m, data),
  });
}

/** Every minute 09:31–15:20 IST while a signal is pending/open: 1-min trigger, SL, target, 15:15 exit. */
async function track(store: SupabaseStore) {
  const now = istParts(new Date()).hhmm;
  if (now < "09:31" || now > "15:20") return { skipped: "outside market hours" };
  const { today, notify } = await ctx(store);
  const signals = (await store.signalsFor(today)).filter((x) => x.status === "PENDING" || x.status === "TRIGGERED");
  if (!signals.length) return { skipped: "nothing open" };
  const token = await store.getValidToken();
  if (!token) return { skipped: "no token" };
  const client = new UpstoxClient(token);
  const nowMs = Date.now();
  const oneMin = (await client.intradayCandles(NIFTY_INDEX_KEY, "minutes", 1))
    .filter((c) => c.t.startsWith(today) && new Date(c.t).getTime() + 60_000 <= nowMs);
  const cache = new Map<string, Candle[]>();
  const res = await runTrack({
    today, now, signals, oneMin, settings: settingsFrom(await store.settings()), notify,
    optionCandles: async (key) => {
      if (!cache.has(key)) cache.set(key, key ? (await client.intradayCandles(key, "minutes", 1)).filter((c) => c.t.startsWith(today)) : []);
      return cache.get(key)!;
    },
    update: (id, p) => store.updateSignal(id, p),
  });
  if (Object.keys(res).length) await store.log("track", "info", `track ${now}`, res);
  return res;
}

/** After the 15:45 job stored today's candles: background variants + the evening paper summary. */
async function paperEod(store: SupabaseStore, date?: string) {
  const c = await ctx(store);
  const today = date ?? c.today;
  if (!date && !c.trading) return { skipped: "not a trading day" };
  const raw = await store.settings();
  const st = settingsFrom(raw);
  const lv = await store.getLevelsFull({ date: today });
  const prevDaily = lv ? await store.getDaily(lv.based_on) : null;
  const today1 = await store.getIntraday(today, "1m");
  let shadow: { variant: string; status: string; r_mult: number | null }[] = [];
  if (lv && prevDaily && today1.length) {
    const keep = Array.isArray(raw.shadow_variants) ? (raw.shadow_variants as string[]) : DEFAULT_SHADOW;
    const rows = shadowDay(await store.recent15m(today, 12), await store.getIntraday(today, "15m"), today1, lv.based_on, prevDaily, today, st, keep);
    const del = await store.db.from("shadow_trades").delete().eq("date", today);
    if (del.error) throw new Error(del.error.message);
    if (rows.length) { const ins = await store.db.from("shadow_trades").insert(rows); if (ins.error) throw new Error(ins.error.message); }
    shadow = rows;
  } else await store.log("paper_eod", "warn", `No stored candles/levels for ${today}; background variants skipped`);
  const start = (raw.paper_start as string | undefined) ?? null;
  let q = store.db.from("signals").select("*").in("status", ["TARGET", "SL", "TIME_EXIT"]);
  if (start) q = q.gte("date", start);
  const { data: closed, error } = await q;
  if (error) throw new Error(error.message);
  await c.notify(paperSummary(today, await store.signalsFor(today), (closed ?? []) as SignalRow[], shadow, start));
  await store.log("paper_eod", "info", `Paper EOD ${today}: ${shadow.length} background rows`);
  return { date: today, shadow_rows: shadow.length };
}

Deno.serve(async (req) => {
  const store = new SupabaseStore();
  if (!(await store.checkCronSecret(req.headers.get("x-cron-secret")))) return json({ error: "not allowed" }, 401);
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const action = String(body.action ?? "");
  const jobs: Record<string, () => Promise<Record<string, unknown>>> = {
    candle_scan: () => candleScan(store), track: () => track(store),
    paper_eod: () => paperEod(store, body.date ? String(body.date) : undefined),
  };
  if (!jobs[action]) return json({ error: `unknown action ${action}` }, 400);
  try {
    return json(await jobs[action]());
  } catch (e) {
    const err = e as Error;
    await store.log(action, "error", `${err.name}: ${err.message}`, { stack: (err.stack ?? "").slice(-1500) });
    if (e instanceof UpstoxAuthError) await store.markTokenInvalid(err.message);
    if (action !== "track" || e instanceof UpstoxAuthError) {
      await sendTelegram(env("TELEGRAM_BOT_TOKEN"), env("TELEGRAM_CHAT_ID"), `❌ ${action} failed: ${err.message.slice(0, 300)}`);
    }
    return json({ error: err.message }, 500);
  }
});
