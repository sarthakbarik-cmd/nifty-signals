// Edge Function `backtest` — research only. Runs the Phase 3 rules over past Upstox candles for
// SL/target variants A–D and stores every simulated trade in backtest_trades. No orders, no alerts,
// no effect on live signals. Auth: the scheduler secret (x-cron-secret), so only the owner's
// database can start it. Body: {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"} (≤ 31 days per call).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { runBacktest } from "../_shared/backtest.ts";
import { type Candle, groupByDate } from "../_shared/candles.ts";
import { SupabaseStore } from "../_shared/store.ts";
import { settingsFrom } from "../_shared/strategy.ts";
import { addDays, diffDays, isTradingDay, isValidDate } from "../_shared/time.ts";
import { NIFTY_INDEX_KEY, UpstoxClient } from "../_shared/upstox.ts";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

async function chunked(from: string, to: string, fn: (a: string, b: string) => Promise<Candle[]>): Promise<Candle[]> {
  const out: Candle[] = [];
  for (let a = from; a <= to; a = addDays(a, 28)) {
    const b = addDays(a, 27) < to ? addDays(a, 27) : to;
    out.push(...await fn(a, b));
  }
  return out;
}

Deno.serve(async (req) => {
  const store = new SupabaseStore();
  if (!(await store.checkCronSecret(req.headers.get("x-cron-secret")))) return json({ error: "not allowed" }, 401);
  const { from, to } = await req.json().catch(() => ({}));
  if (!isValidDate(String(from)) || !isValidDate(String(to)) || diffDays(from, to) < 0 || diffDays(from, to) > 31) {
    return json({ error: "body must be {from, to} within 31 days" }, 400);
  }
  const token = await store.getValidToken();
  if (!token) return json({ error: "no Upstox token" }, 412);
  const client = new UpstoxClient(token);
  const holidays = new Set<string>(((await store.getHolidays())?.dates ?? []) as string[]);
  const trading = (c: Candle) => isTradingDay(c.t.slice(0, 10), holidays); // drop special weekend sessions

  try {
    const warm = addDays(from, -35); // EMA50 / ATR warm-up
    const c15 = (await chunked(warm, to, (a, b) => client.historicalCandles(NIFTY_INDEX_KEY, "minutes", 15, a, b))).filter(trading);
    const c1 = (await chunked(from, to, (a, b) => client.historicalCandles(NIFTY_INDEX_KEY, "minutes", 1, a, b))).filter(trading);
    const dl = (await client.historicalCandles(NIFTY_INDEX_KEY, "days", 1, addDays(from, -10), to)).filter(trading);
    const dailies = Object.fromEntries(dl.map((d) => [d.t.slice(0, 10), d]));
    const trades = runBacktest(c15, groupByDate(c1), dailies, from, to, settingsFrom(await store.settings()));

    const del = await store.db.from("backtest_trades").delete().gte("date", from).lte("date", to);
    if (del.error) throw new Error(del.error.message);
    for (let i = 0; i < trades.length; i += 500) {
      const ins = await store.db.from("backtest_trades").insert(trades.slice(i, i + 500));
      if (ins.error) throw new Error(ins.error.message);
    }
    const summary: Record<string, Record<string, number>> = {};
    for (const t of trades) (summary[t.variant] ??= {})[t.status] = (summary[t.variant]?.[t.status] ?? 0) + 1;
    await store.log("backtest", "info", `Backtest ${from}..${to}: ${trades.length} rows`, summary);
    return json({ from, to, days: new Set(c1.map((c) => c.t.slice(0, 10))).size, rows: trades.length, summary });
  } catch (e) {
    await store.log("backtest", "error", `Backtest ${from}..${to} failed: ${(e as Error).message}`);
    return json({ error: (e as Error).message }, 500);
  }
});
