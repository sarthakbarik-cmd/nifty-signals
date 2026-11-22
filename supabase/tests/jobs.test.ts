import * as jobs from "../functions/_shared/jobs.ts";
import { daysBetween, weekday } from "../functions/_shared/time.ts";
import { UpstoxAuthError } from "../functions/_shared/upstox.ts";
import { eq, FakeClient, FakeStore, failing, makeDay, ok, throws } from "./helpers.ts";

const TODAY = "2026-11-20"; // Friday

Deno.test("15:45 job stores today's candles and next day's levels", async () => {
  const store = new FakeStore(), client = new FakeClient(TODAY);
  const r = await jobs.runEod(client as any, store, TODAY, new Set());
  eq(r.status, "ok", JSON.stringify(r.issues));
  eq([store.intraday.get(`${TODAY}|15m`)!.length, store.intraday.get(`${TODAY}|1m`)!.length], [25, 375]);
  ok(store.daily.has(TODAY) && store.checks.has(TODAY));
  ok(client.calls.every((c) => c[0] === "intraday"));
  eq(r.levels_for, "2026-11-23"); // Fri -> Mon
  const lv = store.levels.get("2026-11-23")!;
  const d = store.daily.get(TODAY)!;
  eq([lv.based_on, lv.PDH, lv.PDC], [TODAY, Math.round(d.h * 100) / 100, Math.round(d.c * 100) / 100]);
  const msg = jobs.formatReport(r);
  ok(msg.startsWith("✅") && msg.includes("15m 25/25") && msg.includes("1m 375/375"));
  ok(jobs.formatLevels("2026-11-23", r.levels!).includes("NIFTY levels for 2026-11-23"));
});

Deno.test("levels skip a holiday", async () => {
  const thu = "2026-11-19";
  const r = await jobs.runEod(new FakeClient(thu) as any, new FakeStore(), thu, new Set(["2026-11-20"]));
  eq(r.levels_for, "2026-11-23");
});

Deno.test("backfill chunks ≤28 days, skips weekends/holidays, computes levels", async () => {
  const hol = new Set(["2026-11-04"]);
  const store = new FakeStore(), client = new FakeClient(TODAY, hol);
  const reports = await jobs.storeRange(client as any, store, "2026-09-01", "2026-11-19", TODAY, hol);
  eq(client.calls.filter((c) => c[0] === "hist" && c[1] === "minutes" && c[2] === 1).length, 3); // 80 days
  ok(!store.checks.has("2026-11-04") && !store.checks.has("2026-11-08"));
  ok(reports.every((r) => r.status === "ok"));
  eq(reports.length, daysBetween("2026-09-01", "2026-11-19").filter((d) => weekday(d) < 5 && !hol.has(d)).length);
  ok(store.levels.has("2026-11-20") && store.levels.has("2026-11-05")); // Tue 3rd -> Thu 5th skips holiday 4th
  eq(store.levels.get("2026-11-05")!.based_on, "2026-11-03");
});

Deno.test("special weekend session (Muhurat) is stored but never used for levels", async () => {
  // Fri 6 Nov full day, Sun 8 Nov one-hour Muhurat session, Mon 9 Nov is the next trading day.
  const store = new FakeStore();
  const client = new FakeClient(TODAY);
  const realHist = client.historicalCandles.bind(client);
  client.historicalCandles = async (k: string, unit: string, interval: number, a: string, b: string) => {
    const rows = await realHist(k, unit, interval, a, b);
    // add a short Sunday session to whatever was requested
    const sun = makeDay("2026-11-08");
    const extra = unit === "days" ? [sun.daily] : (interval === 1 ? sun.c1.slice(0, 70) : sun.c15.slice(0, 5));
    return [...rows, ...extra];
  };
  const reports = await jobs.storeRange(client as any, store, "2026-11-06", "2026-11-09", TODAY, new Set());
  const sunday = reports.find((r) => r.date === "2026-11-08")!;
  ok(sunday && sunday.levels_for === undefined, "Muhurat day must not produce levels");
  ok(sunday.issues.some((i) => i.code === "non_trading_day"));
  ok(store.intraday.has("2026-11-08|15m"), "special-session candles are still stored");
  eq(store.levels.get("2026-11-09")!.based_on, "2026-11-06"); // Monday's levels come from Friday
});

Deno.test("unknown holiday is reported, stored data never overwritten with empty", async () => {
  const store = new FakeStore(), client = new FakeClient(TODAY, new Set(["2026-11-18"]));
  store.intraday.set("2026-11-18|15m", ["previously stored"] as any);
  const [r] = await jobs.storeRange(client as any, store, "2026-11-18", "2026-11-18", TODAY, new Set());
  eq(r.status, "error");
  eq(store.intraday.get("2026-11-18|15m"), ["previously stored"]);
});

Deno.test("09:20 adds OI + instruments without erasing pivots", async () => {
  const store = new FakeStore();
  await jobs.runEod(new FakeClient("2026-11-19") as any, store, "2026-11-19", new Set()); // levels for 20 Nov
  const pivot = store.levels.get(TODAY)!.P;
  const client = new FakeClient(TODAY);
  const res = await jobs.runPremarket(client as any, store, TODAY, new Set());
  const lv = store.levels.get(TODAY)!;
  eq([lv.P, lv.maxCallOI, lv.maxPutOI, lv.oi_expiry], [pivot, 24600, 24400, "2026-11-24"]);
  ok(client.calls.some((c) => c[0] === "chain" && c[1] === "2026-11-24"));
  eq([store.instruments!.trade_expiry, store.instruments!.lot_size], ["2026-11-24", 75]);
  ok(jobs.formatLevels(TODAY, res).includes("Max call OI 24,600"));
});

Deno.test("09:20 recomputes missing levels from stored or fetched daily", async () => {
  const s1 = new FakeStore();
  s1.daily.set("2026-11-19", { t: "x", o: 85, h: 100, l: 80, c: 90 });
  await jobs.runPremarket(new FakeClient(TODAY) as any, s1, TODAY, new Set());
  eq([s1.levels.get(TODAY)!.based_on, s1.levels.get(TODAY)!.P, s1.levels.get(TODAY)!.maxCallOI], ["2026-11-19", 90, 24600]);
  ok(s1.logs.some(([, , m]) => m.includes("missing")));

  const s2 = new FakeStore();
  await jobs.runPremarket(new FakeClient(TODAY) as any, s2, TODAY, new Set());
  ok(s2.daily.has("2026-11-19") && s2.levels.get(TODAY)!.based_on === "2026-11-19");
});

Deno.test("holidays: fresh cache, refresh, fallback on failure", async () => {
  const fresh = new FakeStore({ year: 2026, dates: ["2026-11-24"], updated_at: new Date().toISOString() });
  const c = new FakeClient(TODAY);
  c.marketHolidays = () => { throw new Error("should not refetch"); };
  eq([...await jobs.resolveHolidays(c as any, fresh, TODAY)], ["2026-11-24"]);

  const stale = new FakeStore({ year: 2025, dates: ["2025-12-25"], updated_at: new Date().toISOString() });
  eq([...await jobs.resolveHolidays(new FakeClient(TODAY, new Set(["2026-11-24"])) as any, stale, TODAY)].sort(), ["2025-12-25", "2026-11-24"]);

  const down = new FakeStore({ year: 2025, dates: ["2025-12-25"], updated_at: new Date().toISOString() });
  const c2 = new FakeClient(TODAY);
  c2.marketHolidays = failing() as any;
  eq([...await jobs.resolveHolidays(c2 as any, down, TODAY)], ["2025-12-25"]);
  eq(down.logs.at(-1)![1], "warn");
});

Deno.test("token check", async () => {
  const store = new FakeStore();
  eq(await jobs.checkToken(new FakeClient(TODAY) as any, store), [true, "Owner"]);
  eq((await jobs.checkToken(new FakeClient(TODAY, new Set(), null) as any, store))[0], false);
  const c = new FakeClient(TODAY);
  c.profile = async () => { throw new UpstoxAuthError("401", 401); };
  eq((await jobs.checkToken(c as any, store))[0], false);
  ok(store.invalid);
});

Deno.test("backfill window", () => {
  const before = new Date("2026-11-20T11:00:00+05:30"), after = new Date("2026-11-20T15:40:00+05:30");
  eq(jobs.backfillWindow("2026-11-06", "2026-11-20", before), ["2026-11-06", "2026-11-19"]);
  eq(jobs.backfillWindow("2026-11-06", "2026-11-20", after), ["2026-11-06", "2026-11-20"]);
  throws(() => jobs.backfillWindow("2026-11-20", "2026-11-20", before), RangeError);
  throws(() => jobs.backfillWindow("2026-10-01", "2026-11-19", after), RangeError);
  throws(() => jobs.backfillWindow("bad", "2026-11-19", after), RangeError);
});
