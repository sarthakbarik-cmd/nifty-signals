// Edge Function `api` — scheduled jobs + owner dashboard actions. SIGNALS ONLY: no order code.
//
// Auth (verify_jwt is off; this function checks itself):
//   • pg_cron:   header x-cron-secret == the random secret in Vault  -> premarket_check, daily_levels
//   • dashboard: Authorization: Bearer <owner's Supabase JWT>        -> every action below
//
// Actions: premarket_check | daily_levels | request_token | test_telegram | login_url | backfill {from,to}
//          | refresh_premarket | today_candles | status   (Phase 4 scan/tracking live in the `paper` function)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { buildChartSvg } from "../_shared/chart.ts";
import { fetchParticipantOi, fiiLines, type PartRow } from "../_shared/fii.ts";
import * as jobs from "../_shared/jobs.ts";
import type { ExpiryCache } from "../_shared/levels.ts";
import { BADGE, dayLabel, dayShort, eveningReport, type LevelsWithOi, morningPlan } from "../_shared/messages.ts";
import { sendTelegram, sendTelegramPhoto } from "../_shared/notify.ts";
import { svgToPng } from "../_shared/render.ts";
import { SupabaseStore } from "../_shared/store.ts";
import { istParts, isTradingDay, prevTradingDay, todayIst } from "../_shared/time.ts";
import { startTokenRequest, type TokenRequestState } from "../_shared/tokenflow.ts";
import { buildAuthorizeUrl, NIFTY_INDEX_KEY, UpstoxAuthError, UpstoxClient, UpstoxError } from "../_shared/upstox.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const env = (k: string) => Deno.env.get(k) ?? undefined;
const telegram = (text: string) => sendTelegram(env("TELEGRAM_BOT_TOKEN"), env("TELEGRAM_CHAT_ID"), text);

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function settingsBand(store: SupabaseStore): Promise<number> {
  return Number((await store.settings()).no_trade_band ?? 20);
}

async function cprCfg(store: SupabaseStore) {
  const s = await store.settings();
  return { narrow: Number(s.cpr_narrow_pct ?? 0.25), wide: Number(s.cpr_wide_pct ?? 0.5) };
}

const fmt0 = (x: number) => Math.round(x).toLocaleString("en-IN");

/** 09:20 message: plain-language plan + chart (previous day's candles, today's levels, now line). */
async function sendMorning(store: SupabaseStore, today: string, lv: LevelsWithOi, price: number, inst: ExpiryCache | null, prefix = "", suffix = "") {
  const plan = morningPlan(today, lv, price, inst, await cprCfg(store));
  const bias = plan.bias;
  const joined = suffix ? `${plan.text}\n\n${suffix}` : plan.text;
  const split = Boolean(suffix) && (prefix + joined).length > 1024; // keep the plan as the chart caption
  const text = split ? plan.text : joined;
  const { svg } = buildChartSvg({
    title: `NIFTY plan · ${dayLabel(today)}`,
    subtitle: `Candles: ${dayLabel(lv.based_on)} (15-min)  ·  Levels for ${dayLabel(today)}  ·  Nifty ${fmt0(price)} at 09:20`,
    badge: { text: BADGE[bias], tone: bias }, candles: await store.getIntraday(lv.based_on, "15m"),
    levels: lv, prevName: dayShort(lv.based_on), now: { price },
  });
  const png = await svgToPng(svg);
  const app = await store.app();
  await sendTelegramPhoto(env("TELEGRAM_BOT_TOKEN"), env("TELEGRAM_CHAT_ID"), prefix + text, png, app.dashboard_url);
  if (split) await telegram(suffix);
  return { chart: Boolean(png), chars: (prefix + text).length, fii_separate: split };
}

/** 15:45 message: data check + next trading day's levels + chart (today's candles, next day's levels). */
async function sendEvening(store: SupabaseStore, report: Parameters<typeof eveningReport>[0], next: string | null,
  lv: LevelsWithOi | null, holidays: Set<string>, prefix = "") {
  const text = prefix + eveningReport(report, next, lv, holidays, await cprCfg(store));
  let png: Uint8Array | null = null;
  if (next && lv) {
    const { svg } = buildChartSvg({
      title: `NIFTY · ${dayLabel(report.date)} close`,
      subtitle: `Candles: ${dayLabel(report.date)} (15-min)  ·  Levels for ${dayLabel(next)}`,
      badge: { text: `Plan for ${dayLabel(next)}`, tone: "info" }, candles: await store.getIntraday(report.date, "15m"),
      levels: lv, prevName: dayShort(report.date), now: null,
    });
    png = await svgToPng(svg);
  }
  const app = await store.app();
  await sendTelegramPhoto(env("TELEGRAM_BOT_TOKEN"), env("TELEGRAM_CHAT_ID"), text, png, app.dashboard_url);
  return { chart: Boolean(png), chars: text.length };
}

/** Sends both messages, marked TEST, from the latest stored data. Changes nothing in the database. */
async function testTelegram(store: SupabaseStore): Promise<Record<string, unknown>> {
  const today = todayIst();
  const client = new UpstoxClient(null);
  const holidays = await jobs.resolveHolidays(client, store, today);
  const lv = await store.getLevelsFull({ onOrBefore: today });
  if (!lv) throw new HttpError(412, "No levels stored yet.");
  const inst = await store.getConfig<ExpiryCache>("instruments");
  const price = lv.oi_spot ?? lv.PDC;
  const morning = await sendMorning(store, lv.date, lv, price, inst?.for_date === lv.date ? inst : null, "🧪 TEST (sample of the 09:20 message)\n\n",
    await fiiContext(store, lv.based_on, holidays));
  const check = await store.getCheck(lv.based_on);
  const evening = check
    ? await sendEvening(store, check, lv.date, { ...lv, maxCallOI: null, maxPutOI: null }, holidays, "🧪 TEST (sample of the 15:45 message)\n\n")
    : null;
  return { levels_date: lv.date, morning, evening };
}

/** Ask Upstox to send an approval request to the owner's phone (Upstox app + WhatsApp). */
async function requestToken(store: SupabaseStore, by: TokenRequestState["by"]) {
  return await startTokenRequest(store, env("UPSTOX_API_KEY"), env("UPSTOX_API_SECRET"), by);
}

/** 08:45 IST on trading days: send the approval request so the token is ready before 09:20. */
async function scheduledTokenRequest(store: SupabaseStore): Promise<Record<string, unknown>> {
  const today = todayIst();
  const holidays = await jobs.resolveHolidays(new UpstoxClient(null), store, today);
  if (!isTradingDay(today, holidays)) return { skipped: "not a trading day" };
  const app = await store.app();
  try {
    const r = await requestToken(store, "schedule");
    if (r.sent) await telegram(`📲 Good morning! Approve the Upstox request on your phone (Upstox app or WhatsApp) to start today's signals.\nOr log in on the dashboard: ${app.dashboard_url ?? ""}`);
    return r;
  } catch (e) {
    await store.log("token_request", "error", (e as Error).message);
    await telegram(`⚠️ Couldn't send the Upstox approval request: ${(e as Error).message.slice(0, 200)}\nPlease log in on the dashboard: ${app.dashboard_url ?? ""}`);
    return { sent: false, reason: (e as Error).message };
  }
}

/** FII block for the 09:20 message (context only). Uses stored rows, else NSE's file; never throws. */
async function fiiContext(store: SupabaseStore, day: string, holidays: Set<string>): Promise<string> {
  const load = async (d: string): Promise<PartRow | null> => {
    const { data } = await store.db.from("participant_oi").select("*").eq("date", d).eq("client_type", "FII").maybeSingle();
    if (data) return data as PartRow;
    const rows = await fetchParticipantOi(d);
    if (!rows) return null;
    await store.db.from("participant_oi").upsert(Object.entries(rows).map(([client_type, r]) => ({ date: d, client_type, ...r })));
    return rows.FII;
  };
  try {
    const cur = await load(day);
    if (!cur) return `🏦 FII data for ${dayLabel(day)} not available today.`;
    const prevDay = prevTradingDay(day, holidays);
    const prev = await load(prevDay).catch(() => null);
    return fiiLines(day, cur, prev ? prevDay : null, prev);
  } catch (e) {
    await store.log("fii", "warn", `FII data not added: ${(e as Error).message}`);
    return `🏦 FII data not available today.`;
  }
}

// --------------------------------------------------------------------------- scheduled jobs
async function premarketCheck(store: SupabaseStore): Promise<Record<string, unknown>> {
  const app = await store.app();
  const client = new UpstoxClient(await store.getValidToken());
  const today = todayIst();
  const holidays = await jobs.resolveHolidays(client, store, today);
  if (!isTradingDay(today, holidays)) {
    await store.log("premarket_check", "info", `${today} is not a trading day; skipped`);
    return { skipped: "not a trading day" };
  }
  const [ok, detail] = await jobs.checkToken(client, store);
  await store.log("premarket_check", ok ? "info" : "warn", `Token check: ${detail}`);
  if (!ok) {
    let resent = false;
    try { resent = (await requestToken(store, "reminder")).sent; } catch (e) { await store.log("token_request", "warn", (e as Error).message); }
    await telegram(resent
      ? `⏰ Upstox is not approved yet, so today's plan can't run. I've sent the approval request to your phone again (Upstox app / WhatsApp).\nOr log in on the dashboard: ${app.dashboard_url ?? ""}`
      : `⏰ Upstox not logged in (${detail}). Log in before signals can run:\n${app.dashboard_url ?? ""}`);
    return { token: false, detail, resent };
  }
  const res = await jobs.runPremarket(client, store, today, holidays, await settingsBand(store));
  await sendMorning(store, today, res, res.oi_spot, res.instruments, "", await fiiContext(store, res.based_on, holidays));
  return { token: true, maxCallOI: res.maxCallOI, maxPutOI: res.maxPutOI, trade_expiry: res.instruments.trade_expiry, lot_size: res.instruments.lot_size };
}

async function dailyLevels(store: SupabaseStore): Promise<Record<string, unknown>> {
  const app = await store.app();
  const token = await store.getValidToken();
  const client = new UpstoxClient(token);
  const today = todayIst();
  const holidays = await jobs.resolveHolidays(client, store, today);
  if (!isTradingDay(today, holidays)) {
    await store.log("daily_levels", "info", `${today} is not a trading day; skipped`);
    return { skipped: "not a trading day" };
  }
  if (!token) {
    await store.log("daily_levels", "error", "No valid Upstox token; candles not stored");
    await telegram(`❌ Today's candles and tomorrow's levels NOT done: Upstox not logged in. Log in, then fetch ${today} on the Data tab:\n${app.dashboard_url ?? ""}`);
    return { token: false };
  }
  const report = await jobs.runEod(client, store, today, holidays, await settingsBand(store));
  await sendEvening(store, report, report.levels_for ?? null, report.levels ?? null, holidays);
  return { status: report.status, counts: report.counts, levels_for: report.levels_for };
}

async function runJob(store: SupabaseStore, name: string, fn: (s: SupabaseStore) => Promise<Record<string, unknown>>) {
  try {
    return await fn(store);
  } catch (e) {
    const err = e as Error;
    await store.log(name, "error", `${err.name}: ${err.message}`, { stack: (err.stack ?? "").slice(-1500) });
    if (e instanceof UpstoxAuthError) {
      await store.markTokenInvalid(err.message);
      const app = await store.app();
      await telegram(`❌ ${name}: Upstox token rejected. Please log in again:\n${app.dashboard_url ?? ""}`);
    } else {
      await telegram(`❌ ${name} failed: ${err.name}: ${err.message.slice(0, 300)}`);
    }
    throw new HttpError(500, `${name} failed: ${err.message}`);
  }
}

// --------------------------------------------------------------------------- owner actions
async function requireOwner(store: SupabaseStore, req: Request): Promise<string> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) throw new HttpError(401, "Not signed in.");
  const { data, error } = await store.db.auth.getUser(jwt);
  if (error || !data.user) throw new HttpError(401, "Not signed in.");
  if (!(await store.isOwner(data.user.id))) throw new HttpError(403, "Not allowed.");
  return data.user.id;
}

async function ownerClient(store: SupabaseStore): Promise<UpstoxClient> {
  const token = await store.getValidToken();
  if (!token) throw new HttpError(412, "Log in to Upstox first.");
  return new UpstoxClient(token);
}

async function upstoxCall<T>(store: SupabaseStore, job: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof UpstoxAuthError) {
      await store.markTokenInvalid(e.message);
      throw new HttpError(401, "Upstox token rejected; log in again.");
    }
    if (e instanceof UpstoxError || e instanceof RangeError || (e instanceof Error && /option chain|expiries/.test(e.message))) {
      await store.log(job, "error", (e as Error).message);
      throw new HttpError(502, (e as Error).message);
    }
    throw e;
  }
}

// --------------------------------------------------------------------------- router
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const store = new SupabaseStore();
  let body: Record<string, any> = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const action = String(body.action ?? "");

  try {
    // Scheduler path
    const cronSecret = req.headers.get("x-cron-secret");
    if (cronSecret !== null) {
      if (!(await store.checkCronSecret(cronSecret))) throw new HttpError(401, "Bad scheduler secret.");
      if (action === "premarket_check") return json(await runJob(store, action, premarketCheck));
      if (action === "daily_levels") return json(await runJob(store, action, dailyLevels));
      if (action === "test_telegram") return json(await testTelegram(store));
      if (action === "request_token") return json(await scheduledTokenRequest(store));
      throw new HttpError(400, `Unknown scheduled action: ${action}`);
    }

    // Owner path
    const uid = await requireOwner(store, req);
    switch (action) {
      case "status":
        return json({ owner: true, today: todayIst(), now_ist: istParts(new Date()).hhmm, token: Boolean(await store.getValidToken()) });

      case "login_url": {
        const key = env("UPSTOX_API_KEY");
        if (!key) throw new HttpError(412, "UPSTOX_API_KEY secret is not set in Supabase.");
        const state = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
        await store.saveOauthState(state, uid);
        return json({ url: buildAuthorizeUrl(key, (await store.app()).upstox_redirect_uri, state) });
      }

      case "backfill": {
        let start: string, end: string;
        try { [start, end] = jobs.backfillWindow(String(body.from ?? ""), String(body.to ?? ""), new Date()); }
        catch (e) { throw new HttpError(400, (e as Error).message); }
        const client = await ownerClient(store);
        const band = await settingsBand(store);
        const reports = await upstoxCall(store, "backfill", async () => {
          const holidays = await jobs.resolveHolidays(client, store, todayIst());
          return await jobs.storeRange(client, store, start, end, todayIst(), holidays, band);
        });
        await store.log("backfill", "info", `Backfilled ${start}..${end}`,
          { days: reports.length, statuses: Object.fromEntries(reports.map((r) => [r.date, r.status])) });
        return json({ from: start, to: end, days: reports.map((r) => ({ date: r.date, status: r.status, counts: r.counts, levels_for: r.levels_for ?? null })) });
      }

      case "refresh_premarket": {
        const client = await ownerClient(store);
        const today = todayIst();
        const band = await settingsBand(store);
        const res = await upstoxCall(store, "refresh_premarket", async () => {
          const holidays = await jobs.resolveHolidays(client, store, today);
          if (!isTradingDay(today, holidays)) throw new RangeError(`${today} is not a trading day.`);
          return await jobs.runPremarket(client, store, today, holidays, band);
        });
        return json({ date: today, maxCallOI: res.maxCallOI, maxPutOI: res.maxPutOI, trade_expiry: res.instruments.trade_expiry, lot_size: res.instruments.lot_size });
      }

      case "today_candles": {
        const client = await ownerClient(store);
        const today = todayIst();
        const rows = await upstoxCall(store, "today_candles", () => client.intradayCandles(NIFTY_INDEX_KEY, "minutes", 15));
        return json({ date: today, candles: rows.filter((c) => c.t.startsWith(today)) });
      }

      case "test_telegram":
        return json(await testTelegram(store));

      case "request_token": {
        try { return json(await requestToken(store, "dashboard")); }
        catch (e) { throw new HttpError(502, (e as Error).message); }
      }

      // Manual "run now" of the scheduled jobs, for testing from the dashboard.
      case "premarket_check":
        return json(await runJob(store, action, premarketCheck));
      case "daily_levels":
        if (istParts(new Date()).minutes < 15 * 60 + 31) throw new HttpError(400, "daily_levels can only run after 15:31 IST (needs the full day).");
        return json(await runJob(store, action, dailyLevels));

      default:
        throw new HttpError(400, `Unknown action: ${action}`);
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
