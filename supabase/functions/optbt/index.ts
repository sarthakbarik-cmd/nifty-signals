// Edge Function `optbt` — research only: B's trades and a weekly iron condor priced with REAL expired-option candles
// (Upstox Plus "expired instruments" API). No orders, no alerts, no live effect. Auth: scheduler secret.
// Body: {"action":"spreads","offset":0,"limit":10} | {"action":"condor","from":"2025-11-25","to":"2025-12-31"}
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { Candle } from "../_shared/candles.ts";
import { atmStrike, closeAt, condorStrikes, LOT, minuteGrid, pickExpiry, simulateCondor } from "../_shared/optbt.ts";
import { SupabaseStore } from "../_shared/store.ts";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const enc = (s: string) => encodeURIComponent(s);
const r2 = (x: number) => Math.round(x * 100) / 100;
const pad = (n: number) => String(n).padStart(2, "0");
const addDays = (d: string, n: number) => { const t = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + n)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
const wd = (d: string) => (new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))).getUTCDay() + 6) % 7;
const diffDays = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

class Up {
  constructor(private token: string) {}
  async get(path: string): Promise<any> {
    for (let a = 0; a < 3; a++) {
      if (a) await new Promise((r) => setTimeout(r, 1200 * a));
      const r = await fetch(`https://api.upstox.com${path}`, { headers: { Accept: "application/json", Authorization: `Bearer ${this.token}` } });
      const t = await r.text();
      if (r.status === 429 || r.status >= 500) continue;
      if (r.status !== 200) throw new Error(`HTTP ${r.status} ${path.slice(0, 120)}: ${t.slice(0, 160)}`);
      return JSON.parse(t);
    }
    throw new Error(`Upstox retry limit ${path.slice(0, 120)}`);
  }
  candles(raw: any[][] | undefined): Candle[] {
    return (raw ?? []).map((x) => ({ t: String(x[0]), o: +x[1], h: +x[2], l: +x[3], c: +x[4] })).sort((a, b) => a.t.localeCompare(b.t));
  }
  async expiries(): Promise<string[]> { return (await this.get(`/v2/expired-instruments/expiries?instrument_key=${enc("NSE_INDEX|Nifty 50")}`)).data ?? []; }
  private cc = new Map<string, any[]>();
  async contracts(expiry: string) {
    if (!this.cc.has(expiry)) this.cc.set(expiry, (await this.get(`/v2/expired-instruments/option/contract?instrument_key=${enc("NSE_INDEX|Nifty 50")}&expiry_date=${expiry}`)).data ?? []);
    return this.cc.get(expiry)!;
  }
  async key(expiry: string, strike: number, type: "CE" | "PE"): Promise<string | null> {
    const c = (await this.contracts(expiry)).find((x) => Number(x.strike_price) === strike && x.instrument_type === type);
    return c?.instrument_key ?? null;
  }
  async optCandles(key: string, from: string, to: string) {
    return this.candles((await this.get(`/v2/expired-instruments/historical-candle/${enc(key)}/1minute/${to}/${from}`)).data?.candles);
  }
  async index(key: string, unit: string, n: number, from: string, to: string) {
    return this.candles((await this.get(`/v3/historical-candle/${enc(key)}/${unit}/${n}/${to}/${from}`)).data?.candles);
  }
}

Deno.serve(async (req) => {
  const store = new SupabaseStore();
  if (!(await store.checkCronSecret(req.headers.get("x-cron-secret")))) return json({ error: "not allowed" }, 401);
  const body = await req.json().catch(() => ({})) as Record<string, any>;
  const token = await store.getValidToken();
  if (!token) return json({ error: "no Upstox token" }, 412);
  const up = new Up(token);
  const holidays = new Set<string>(((await store.getConfig("holidays"))?.dates ?? []) as string[]);
  const expiries = (await up.expiries()).sort();
  const isTrading = (d: string) => (wd(d) < 5 && !holidays.has(d)) || expiries.includes(d);
  const prevTrading = (d: string) => { let p = addDays(d, -1); while (!isTrading(p)) p = addDays(p, -1); return p; };
  const rows: Record<string, unknown>[] = [];
  try {
    if (body.action === "spreads") {
      const { data: bt, error } = await store.db.from("backtest_trades").select("date,side,b_time,trigger,entry_time,exit_time,status")
        .eq("variant", "B").in("status", ["TARGET", "SL", "TIME_EXIT"]).order("date").order("b_time")
        .range(Number(body.offset ?? 0), Number(body.offset ?? 0) + Number(body.limit ?? 10) - 1);
      if (error) throw new Error(error.message);
      for (const b of bt ?? []) {
        const exp = pickExpiry(b.date, expiries, prevTrading);
        const base = { date: b.date, expiry: exp, side: b.side, entry_time: b.entry_time, exit_day: b.date, exit_time: b.exit_time, extra: { b_status: b.status, trigger: b.trigger } };
        if (!exp) { rows.push({ ...base, test: "naked", status: "SKIPPED", reason: "no expiry data" }); continue; }
        const atm = atmStrike(b.trigger), far = b.side === "CE" ? atm + 150 : atm - 150;
        const kAtm = await up.key(exp, atm, b.side), kFar = await up.key(exp, far, b.side);
        if (!kAtm || !kFar) { rows.push({ ...base, test: "naked", status: "SKIPPED", reason: "strike not listed" }); continue; }
        const cA = await up.optCandles(kAtm, b.date, b.date), cF = await up.optCandles(kFar, b.date, b.date);
        const exitMin = b.exit_time === "15:15" ? "15:14" : b.exit_time;
        const aIn = closeAt(cA, b.date, b.entry_time), aOut = closeAt(cA, b.date, exitMin);
        const fIn = closeAt(cF, b.date, b.entry_time), fOut = closeAt(cF, b.date, exitMin);
        if (aIn == null || aOut == null || fIn == null || fOut == null) { rows.push({ ...base, test: "naked", status: "SKIPPED", reason: "no option prices" }); continue; }
        const legs = { buy: { strike: atm, key: kAtm, in: aIn, out: aOut }, sell: { strike: far, key: kFar, in: fIn, out: fOut } };
        rows.push({ ...base, test: "naked", status: b.status, legs: { buy: legs.buy }, entry_value: aIn, exit_value: aOut, pnl_rs: Math.round((aOut - aIn) * LOT - 125) });
        rows.push({ ...base, test: "spread", status: b.status, legs, entry_value: r2(aIn - fIn), exit_value: r2(aOut - fOut), pnl_rs: Math.round(((aOut - fOut) - (aIn - fIn)) * LOT - 250) });
      }
      const dates = [...new Set(rows.map((r) => r.date as string))];
      if (dates.length) { const d = await store.db.from("option_bt").delete().in("test", ["naked", "spread"]).in("date", dates); if (d.error) throw new Error(d.error.message); }
    } else if (body.action === "condor") {
      const from = String(body.from), to = String(body.to);
      const vix = await up.index("NSE_INDEX|India VIX", "days", 1, addDays(from, -20), to);
      const vixClose = (d: string) => { let v: number | null = null; for (const k of vix) if (k.t.slice(0, 10) <= d) v = k.c; return v; };
      for (const E of expiries.filter((e) => e >= from && e <= to)) {
        const X = prevTrading(E), D = prevTrading(X);
        const v = vixClose(prevTrading(D));
        const base = { test: "condor", date: D, expiry: E, side: "IC", entry_time: "15:00", extra: { vix_prev: v } as Record<string, unknown> };
        if (v == null) { rows.push({ ...base, status: "SKIPPED", reason: "no VIX" }); continue; }
        if (v > 25) { rows.push({ ...base, status: "SKIPPED", reason: `VIX ${v} > 25` }); continue; }
        const nifty = await up.index("NSE_INDEX|Nifty 50", "minutes", 1, D, D);
        const spot = closeAt(nifty, D, "15:00");
        if (spot == null) { rows.push({ ...base, status: "SKIPPED", reason: "no Nifty price at 15:00" }); continue; }
        const s = condorStrikes(spot, v, diffDays(D, E));
        const keys = { sc: await up.key(E, s.sc, "CE"), sp: await up.key(E, s.sp, "PE"), lc: await up.key(E, s.lc, "CE"), lp: await up.key(E, s.lp, "PE") };
        base.extra = { ...base.extra, spot, em: s.em, strikes: s };
        if (Object.values(keys).some((k) => !k)) { rows.push({ ...base, status: "SKIPPED", reason: "strike not listed" }); continue; }
        const legs = { sc: await up.optCandles(keys.sc!, D, X), sp: await up.optCandles(keys.sp!, D, X), lc: await up.optCandles(keys.lc!, D, X), lp: await up.optCandles(keys.lp!, D, X) };
        const sim = simulateCondor(legs, D, "15:00", minuteGrid(D, "15:00", [D, X], X));
        if (!sim) { rows.push({ ...base, status: "SKIPPED", reason: "no option prices" }); continue; }
        if (sim.status === "SKIPPED") { rows.push({ ...base, status: "SKIPPED", reason: sim.reason, entry_value: sim.credit }); continue; }
        rows.push({ ...base, status: sim.status, reason: sim.reason, exit_day: sim.exitDay, exit_time: sim.exitMin, legs: keys,
          entry_value: sim.credit, exit_value: sim.exitCost, pnl_rs: Math.round((sim.credit - sim.exitCost!) * LOT - 760),
          extra: { ...base.extra, max_loss_rs: Math.round((150 - sim.credit) * LOT + 760) } });
      }
      const d = await store.db.from("option_bt").delete().eq("test", "condor").gte("expiry", from).lte("expiry", to);
      if (d.error) throw new Error(d.error.message);
    } else return json({ error: "action must be spreads or condor" }, 400);
    if (rows.length) { const ins = await store.db.from("option_bt").insert(rows); if (ins.error) throw new Error(ins.error.message); }
    const summary: Record<string, number> = {};
    for (const r of rows) summary[`${r.test}:${r.status}`] = (summary[`${r.test}:${r.status}`] ?? 0) + 1;
    await store.log("optbt", "info", `optbt ${body.action}: ${rows.length} rows`, summary);
    return json({ rows: rows.length, summary });
  } catch (e) {
    await store.log("optbt", "error", `optbt ${body.action} failed: ${(e as Error).message}`);
    return json({ error: (e as Error).message, partial: rows.length }, 500);
  }
});
