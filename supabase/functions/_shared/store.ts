// Supabase implementation of Store (service role; bypasses RLS). Server-side only.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import type { Candle, DayReport } from "./candles.ts";
import type { Level, LevelsDoc, Store } from "./jobs.ts";
import type { ExpiryCache, OiLevels } from "./levels.ts";
import { NIFTY_INDEX_KEY } from "./upstox.ts";

export function adminClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL")!;
  let key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    key = keys.default;
  }
  return createClient(url, key!, { auth: { persistSession: false, autoRefreshToken: false } });
}

function check<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`DB ${what}: ${res.error.message}`);
  return res.data;
}

export class SupabaseStore implements Store {
  constructor(public db: SupabaseClient = adminClient()) {}

  // ---- config (app_config key/value)
  async getConfig<T = any>(key: string): Promise<T | null> {
    const d = check(await this.db.from("app_config").select("value").eq("key", key).maybeSingle(), `get ${key}`);
    return (d?.value as T) ?? null;
  }
  async setConfig(key: string, value: unknown) {
    check(await this.db.from("app_config").upsert({ key, value, updated_at: new Date().toISOString() }), `set ${key}`);
  }
  async settings(): Promise<Record<string, any>> { return (await this.getConfig("settings")) ?? {}; }
  async app(): Promise<{ project_url: string; upstox_redirect_uri: string; dashboard_url: string | null }> {
    return (await this.getConfig("app"))!;
  }

  // ---- token / oauth (private schema via service-only RPCs)
  async getValidToken(): Promise<string | null> { return check(await this.db.rpc("srv_get_token"), "get token") ?? null; }
  async saveToken(token: string, expiresAt: Date, profile: { user_name?: string; user_id?: string }) {
    check(await this.db.rpc("srv_save_token", { p_token: token, p_expires_at: expiresAt.toISOString() }), "save token");
    await this.setConfig("upstox_status", {
      logged_in: true, expires_at: expiresAt.toISOString(), issued_at: new Date().toISOString(),
      user_name: profile.user_name ?? "", user_id: profile.user_id ?? "",
    });
  }
  async markTokenInvalid(reason: string) {
    const cur = (await this.getConfig<Record<string, unknown>>("upstox_status")) ?? {};
    await this.setConfig("upstox_status", { ...cur, logged_in: false, invalid_reason: reason, invalid_at: new Date().toISOString() });
  }
  async saveOauthState(state: string, userId: string) {
    check(await this.db.rpc("srv_save_oauth_state", { p_state: state, p_user: userId }), "save state");
  }
  async consumeOauthState(state: string): Promise<boolean> {
    return Boolean(check(await this.db.rpc("srv_consume_oauth_state", { p_state: state }), "consume state"));
  }
  async checkCronSecret(secret: string | null): Promise<boolean> {
    return Boolean(check(await this.db.rpc("srv_check_cron_secret", { p_secret: secret ?? "" }), "cron secret"));
  }
  async isOwner(uid: string): Promise<boolean> {
    return Boolean(check(await this.db.rpc("srv_is_owner", { uid }), "is owner"));
  }

  // ---- holidays / instruments
  async getHolidays() { return await this.getConfig("holidays"); }
  async saveHolidays(year: number, dates: string[], source: string) {
    const existing = (await this.getHolidays())?.dates ?? [];
    await this.setConfig("holidays", { year, dates: [...new Set([...existing, ...dates])].sort(), source, updated_at: new Date().toISOString() });
  }
  async saveInstruments(cache: ExpiryCache) {
    await this.setConfig("instruments", { ...cache, fetched_at: new Date().toISOString() });
  }

  // ---- candles
  async saveIntraday(date: string, key: "15m" | "1m", candles: Candle[], source: string) {
    check(await this.db.from(key === "15m" ? "candles_15m" : "candles_1m").upsert({
      date, instrument: NIFTY_INDEX_KEY, count: candles.length, candles, source, fetched_at: new Date().toISOString(),
    }), `save ${key}`);
  }
  async saveDaily(date: string, c: Candle, source: string) {
    check(await this.db.from("candles_daily").upsert({
      date, instrument: NIFTY_INDEX_KEY, t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v ?? 0, oi: c.oi ?? 0, source,
      fetched_at: new Date().toISOString(),
    }), "save daily");
  }
  async getDaily(date: string): Promise<Candle | null> {
    return check(await this.db.from("candles_daily").select("t,o,h,l,c,v,oi").eq("date", date).maybeSingle(), "get daily");
  }
  async saveCheck(date: string, r: DayReport & { levels_for?: string }) {
    check(await this.db.from("data_checks").upsert({
      date, status: r.status, counts: r.counts, daily: r.daily, issues: r.issues, levels_for: r.levels_for ?? null,
      checked_at: new Date().toISOString(),
    }), "save check");
  }

  // ---- levels (column-level upserts, so pivots and OI never erase each other)
  async getLevels(date: string): Promise<LevelsDoc | null> {
    const d = check(await this.db.from("levels").select("*").eq("date", date).maybeSingle(), "get levels");
    if (!d || d.p == null) return null;
    return {
      P: d.p, BC: d.bc, TC: d.tc, R1: d.r1, R2: d.r2, S1: d.s1, S2: d.s2, PDH: d.pdh, PDL: d.pdl, PDC: d.pdc,
      cpr_width: d.cpr_width, no_trade: d.no_trade, based_on: d.based_on,
    };
  }
  async saveLevels(date: string, lv: LevelsDoc) {
    check(await this.db.from("levels").upsert({
      date, based_on: lv.based_on, p: lv.P, bc: lv.BC, tc: lv.TC, r1: lv.R1, r2: lv.R2, s1: lv.S1, s2: lv.S2,
      pdh: lv.PDH, pdl: lv.PDL, pdc: lv.PDC, cpr_width: lv.cpr_width, no_trade: lv.no_trade, updated_at: new Date().toISOString(),
    }), "save levels");
  }
  async saveOi(date: string, oi: OiLevels & { oi_expiry: string }) {
    check(await this.db.from("levels").upsert({
      date, max_call_oi: oi.maxCallOI, max_call_oi_oi: oi.maxCallOI_oi, max_put_oi: oi.maxPutOI, max_put_oi_oi: oi.maxPutOI_oi,
      call_oi_top: oi.call_oi_top, put_oi_top: oi.put_oi_top, oi_expiry: oi.oi_expiry, oi_spot: oi.oi_spot,
      oi_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }), "save oi");
  }

  // ---- logs
  async log(job: string, level: Level, message: string, data: Record<string, unknown> = {}) {
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(`[${job}] ${message}`, data);
    try {
      await this.db.from("logs").insert({ job, level, message, data });
    } catch (e) {
      console.error("log write failed", (e as Error).message); // logging must never break a job
    }
  }
}
