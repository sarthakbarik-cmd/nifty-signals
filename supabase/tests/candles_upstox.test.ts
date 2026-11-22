import { aggregate, buildDayReport, groupByDate } from "../functions/_shared/candles.ts";
import {
  buildAuthorizeUrl, NIFTY_INDEX_KEY, normalizeCandles, nseTradingHolidays, UpstoxAuthError, UpstoxClient, UpstoxError,
} from "../functions/_shared/upstox.ts";
import { eq, makeDay, ok, rejects } from "./helpers.ts";

const DAY = "2026-11-20";
const codes = (r: { issues: { code: string }[] }) => new Set(r.issues.map((i) => i.code));

// ------------------------------------------------------------------ validation
Deno.test("clean day is OK (official close is info only)", () => {
  const { c1, c15, daily } = makeDay(DAY);
  const r = buildDayReport(DAY, c1, c15, daily);
  eq(r.status, "ok", JSON.stringify(r.issues));
  eq(r.counts, { "15m": 25, "15m_expected": 25, "1m": 375, "1m_expected": 375, daily: 1 });
  ok(codes(r).has("official_close"));
});

Deno.test("aggregate 1m -> 15m buckets", () => {
  const { c1 } = makeDay(DAY);
  const agg = aggregate(c1, 15);
  ok(agg.length === 25 && agg.every((a) => a.n === 15));
  eq([agg[0].t, agg[0].o, agg[0].c, agg[0].h], [`${DAY}T09:15:00+05:30`, c1[0].o, c1[14].c, Math.max(...c1.slice(0, 15).map((c) => c.h))]);
});

Deno.test("missing candles are errors and name the slot", () => {
  const { c1, c15, daily } = makeDay(DAY);
  const r = buildDayReport(DAY, c1.slice(0, -5), c15.slice(0, -1), daily);
  eq(r.status, "error");
  ok(codes(r).has("1m_missing") && codes(r).has("15m_missing"));
  ok(r.issues.find((i) => i.code === "15m_missing")!.msg.includes("15:15"));
});

Deno.test("duplicate, bad OHLC and off-session candles", () => {
  const { c1, c15, daily } = makeDay(DAY);
  const bad = structuredClone(c15);
  bad.splice(3, 0, { ...bad[3] });
  bad[10].h = bad[10].l - 1;
  bad.push({ ...bad[bad.length - 1], t: `${DAY}T15:30:00+05:30` });
  const r = buildDayReport(DAY, c1, bad, daily);
  ok(["15m_duplicate", "15m_bad_ohlc", "15m_off_session"].every((c) => codes(r).has(c)));
});

Deno.test("feed mismatches are warnings", () => {
  const { c1, c15, daily } = makeDay(DAY);
  const m = structuredClone(c15);
  m[5].c += 2;
  const r = buildDayReport(DAY, c1, m, { ...daily, h: daily.h + 10 });
  eq(r.status, "warn");
  ok(codes(r).has("agg_mismatch") && codes(r).has("daily_high_mismatch"));
});

Deno.test("no data at all", () => {
  const r = buildDayReport(DAY, [], [], null);
  eq(r.status, "error");
  ok(["1m_no_data", "15m_no_data", "daily_no_data"].every((c) => codes(r).has(c)));
});

Deno.test("group by date", () => {
  const { c1 } = makeDay(DAY);
  const other = c1.slice(0, 3).map((c) => ({ ...c, t: c.t.replace(DAY, "2026-11-19") }));
  const g = groupByDate([...other, ...c1]);
  eq([Object.keys(g).sort(), g["2026-11-19"].length], [["2026-11-19", DAY], 3]);
});

// ------------------------------------------------------------------ Upstox client
const ROWS = [
  ["2026-11-20T09:30:00+05:30", 24410.5, 24420, 24400.1, 24415, 0, 0],
  ["2026-11-20T09:15:00+05:30", 24400, 24412, 24390, 24410.5, 0, 0],
];
type R = Response | Error;
function fakeFetch(responses: R[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = responses.shift()!;
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { f, calls };
}
const res = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
const success = (data: unknown) => res(200, { status: "success", data });

Deno.test("normalize sorts oldest first", () => {
  const c = normalizeCandles(ROWS);
  eq(c.map((x) => x.t.slice(11, 16)), ["09:15", "09:30"]);
  eq(c[0], { t: "2026-11-20T09:15:00+05:30", o: 24400, h: 24412, l: 24390, c: 24410.5, v: 0, oi: 0 });
});

Deno.test("historical V3 URL + bearer header", async () => {
  const { f, calls } = fakeFetch([success({ candles: ROWS })]);
  const out = await new UpstoxClient("tok", f, 1, 0).historicalCandles(NIFTY_INDEX_KEY, "minutes", 15, "2026-11-03", "2026-11-20");
  eq(calls[0].url, "https://api.upstox.com/v3/historical-candle/NSE_INDEX%7CNifty%2050/minutes/15/2026-11-20/2026-11-03");
  eq([calls[0].headers.Authorization, out.length], ["Bearer tok", 2]);
});

Deno.test("intraday, option chain and contract URLs", async () => {
  const { f, calls } = fakeFetch([success({ candles: [] }), success([{ strike_price: 24500 }]), success([])]);
  const c = new UpstoxClient("tok", f, 1, 0);
  await c.intradayCandles(NIFTY_INDEX_KEY, "minutes", 1);
  eq(await c.optionChain(NIFTY_INDEX_KEY, "2026-11-24"), [{ strike_price: 24500 }]);
  await c.optionContracts(NIFTY_INDEX_KEY);
  eq(calls.map((x) => x.url), [
    "https://api.upstox.com/v3/historical-candle/intraday/NSE_INDEX%7CNifty%2050/minutes/1",
    "https://api.upstox.com/v2/option/chain?instrument_key=NSE_INDEX%7CNifty%2050&expiry_date=2026-11-24",
    "https://api.upstox.com/v2/option/contract?instrument_key=NSE_INDEX%7CNifty%2050",
  ]);
});

Deno.test("retries once then succeeds / then raises", async () => {
  const a = fakeFetch([res(503), success({ candles: ROWS })]);
  eq((await new UpstoxClient("tok", a.f, 1, 0).intradayCandles(NIFTY_INDEX_KEY, "minutes", 15)).length, 2);
  eq(a.calls.length, 2);
  const b = fakeFetch([new TypeError("boom"), res(429)]);
  const e = await rejects(() => new UpstoxClient("tok", b.f, 1, 0).intradayCandles(NIFTY_INDEX_KEY, "minutes", 15), UpstoxError) as UpstoxError;
  eq([e.status, b.calls.length], [429, 2]);
});

Deno.test("401 is an auth error without retry; no token is an auth error", async () => {
  const a = fakeFetch([res(401, { status: "error" })]);
  await rejects(() => new UpstoxClient("tok", a.f, 1, 0).profile(), UpstoxAuthError);
  eq(a.calls.length, 1);
  await rejects(() => new UpstoxClient(null, fakeFetch([]).f).profile(), UpstoxAuthError);
});

Deno.test("authorize URL", () => {
  const u = new URL(buildAuthorizeUrl("KEY", "https://x.supabase.co/functions/v1/upstox-callback", "st8"));
  eq(u.origin + u.pathname, "https://api.upstox.com/v2/login/authorization/dialog");
  eq(Object.fromEntries(u.searchParams), { response_type: "code", client_id: "KEY", redirect_uri: "https://x.supabase.co/functions/v1/upstox-callback", state: "st8" });
});

Deno.test("holiday filter keeps NSE/NFO trading holidays only", () => {
  eq(nseTradingHolidays([
    { date: "2026-01-26", holiday_type: "TRADING_HOLIDAY", closed_exchanges: ["NSE", "NFO", "BSE"] },
    { date: "2026-02-19", holiday_type: "SETTLEMENT_HOLIDAY", closed_exchanges: ["NSE"] },
    { date: "2026-03-03", holiday_type: "TRADING_HOLIDAY", closed_exchanges: ["MCX"] },
  ]), ["2026-01-26"]);
});

Deno.test("no order endpoints anywhere in the functions (spec §1/§13)", async () => {
  const root = new URL("../functions/", import.meta.url);
  const bad = /\/order|\/gtt|place_?order|modify_?order|cancel_?order/i;
  async function walk(dir: URL) {
    for await (const e of Deno.readDir(dir)) {
      const p = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
      if (e.isDirectory) await walk(p);
      else if (e.name.endsWith(".ts")) ok(!bad.test(await Deno.readTextFile(p)), `order endpoint found in ${p.pathname}`);
    }
  }
  await walk(root);
});
