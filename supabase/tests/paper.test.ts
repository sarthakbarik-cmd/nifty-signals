// Phase 4: variant B live stop, paper sizing, daily loss limit, 1-min tracking with option premiums.
import type { Candle } from "../functions/_shared/candles.ts";
import { runScan, type SignalRow } from "../functions/_shared/scan.ts";
import { paperSummary } from "../functions/_shared/shadow.ts";
import { applyAtrStop, atrSeries, DEFAULTS, gateSetup, settingsFrom } from "../functions/_shared/strategy.ts";
import { premiumAt, runTrack } from "../functions/_shared/track.ts";
import { eq, ok } from "./helpers.ts";
import { ceLevels, ceSeries } from "./strategy_fixtures.ts";

const m = (hhmm: string, o: number, h: number, l: number, c: number): Candle => ({ t: `2026-11-25T${hhmm}:00+05:30`, o, h, l, c });
const PAPER = { ...DEFAULTS, sl_mode: "atr", paper_mode: true, daily_loss_limit_rs: 2000 };

const chainRows = (spot: number) => [24150, 24200, 24250].map((k) => ({
  strike_price: k, underlying_spot_price: spot,
  call_options: { instrument_key: `NSE_FO|CE${k}`, market_data: { ltp: 120 - (k - 24150) / 2 }, option_greeks: { delta: k === 24200 ? 0.5 : k < 24200 ? 0.6 : 0.4 } },
  put_options: { instrument_key: `NSE_FO|PE${k}`, market_data: { ltp: 100 }, option_greeks: { delta: -0.5 } },
}));

function deps(settings = PAPER, signalsToday: SignalRow[] = []) {
  const rows: SignalRow[] = [], msgs: string[] = [];
  return {
    rows, msgs,
    d: {
      today: "2026-11-25", candles: ceSeries(), levels: ceLevels(), settings, signalsToday,
      chain: async () => ({ rows: chainRows(24218) as any, expiry: "2026-12-01", lotSize: 65 }),
      insert: async (r: SignalRow) => { rows.push(r); }, update: async () => {}, notify: async (t: string) => { msgs.push(t); },
      log: async () => {},
    },
  };
}

Deno.test("settings: booleans and strings coerced from app_config", () => {
  const s = settingsFrom({ sl_mode: "atr", paper_mode: true, daily_loss_limit_rs: "2000" });
  eq([s.sl_mode, s.paper_mode, s.daily_loss_limit_rs, s.cost_per_trade], ["atr", true, 2000, 60]);
  eq(settingsFrom({ paper_mode: "false" }).paper_mode, false);
});

Deno.test("variant B: SL = trigger − ATR, target = 2R; spec values kept in details", () => {
  const cs = ceSeries();
  const a = atrSeries(cs)[cs.length - 1]!;
  const st = applyAtrStop({ side: "CE", b: cs[cs.length - 1], bClose: "10:45", trigger: 24224, sl: 24196, R: 28, target: 24280, validUntil: "11:00", details: {} }, a, PAPER);
  eq(st.R, Math.round(a * 100) / 100);
  eq(st.sl, Math.round((24224 - st.R) * 100) / 100);
  eq(st.target, Math.round((24224 + 2 * st.R) * 100) / 100);
  eq([st.details.spec_sl, st.details.spec_r, st.details.sl_mode], [24196, 28, "atr"]);
});

Deno.test("paper scan: ATR stop, never skipped for lot budget, real-money note shown", async () => {
  const { d, rows, msgs } = deps({ ...PAPER, capital: 10000 }); // ₹200 budget → real money would skip
  eq((await runScan(d)).result, "pending");
  const s = rows[0];
  eq([s.status, s.lots], ["PENDING", 1]);
  eq(s.details?.sl_mode, "atr");
  ok(msgs[0].includes("📝 paper") && msgs[0].includes("Real money: ") && msgs[0].includes("budget"), msgs[0]);
  ok(msgs[0].includes("SL = 1 ATR"), msgs[0]);
});

Deno.test("daily loss limit: new setups skipped once paper loss ≥ limit", () => {
  const st = { side: "CE" as const, b: ceSeries()[0], bClose: "10:45", trigger: 24224, sl: 24196, R: 28, target: 24280, validUntil: "11:00", details: {} };
  const lv = ceLevels({ PDH: 30000, R1: 30000, R2: 30000, maxCallOI: null as any });
  eq(gateSetup(st, { todayOpen: 24100, tradesToday: 1, busy: false, lossToday: 1999 }, lv, PAPER), null);
  ok(String(gateSetup(st, { todayOpen: 24100, tradesToday: 1, busy: false, lossToday: 2100 }, lv, PAPER)).startsWith("daily loss limit reached"));
  ok(String(gateSetup({ ...st, R: 60 }, { todayOpen: 24100, tradesToday: 0, busy: false }, lv, DEFAULTS)).startsWith("SL too wide"));
  eq(gateSetup({ ...st, R: 60, target: 24344 }, { todayOpen: 24100, tradesToday: 0, busy: false }, lv, PAPER), null); // paper: no R cap
});

const sig = (over: Partial<SignalRow> = {}): SignalRow => ({
  id: 1, date: "2026-11-25", b_time: "10:30", side: "CE", status: "PENDING", reason: null, trigger: 24224, sl: 24184, target: 24304,
  r: 40, valid_until: "11:00", strike: 24200, option_key: "NSE_FO|X", lots: 1, lot_size: 65, ltp: 100, ...over,
});

function trackDeps(signals: SignalRow[], oneMin: Candle[], opt: Candle[], now: string) {
  const msgs: string[] = [];
  return { msgs, d: { today: "2026-11-25", now, signals, oneMin, optionCandles: async () => opt, settings: PAPER,
    update: async (_: number, p: Partial<SignalRow>) => { Object.assign(signals[0], p); }, notify: async (t: string) => { msgs.push(t); } } };
}

Deno.test("track: trigger on the 1-min candle, then target with real option premiums", async () => {
  const s = sig();
  const idx = [m("10:45", 24210, 24215, 24205, 24212), m("10:47", 24212, 24226, 24211, 24225), m("11:20", 24260, 24306, 24255, 24300)];
  const opt = [m("10:47", 100, 104, 99, 103), m("11:20", 130, 142, 129, 140)];
  const { d, msgs } = trackDeps([s], idx.slice(0, 2), opt, "10:48");
  await runTrack(d);
  eq([s.status, s.triggered_at, s.entry_premium], ["TRIGGERED", "2026-11-25T10:47", 103]);
  d.oneMin = idx; d.now = "11:21";
  await runTrack(d);
  eq([s.status, s.exit_premium, s.pnl_rs], ["TARGET", 140, Math.round((140 - 103) * 65 - 60)]);
  ok(msgs[1].startsWith("🎯 TARGET hit") && msgs[1].includes("+₹2,345"), msgs[1]);
});

Deno.test("track: stays open before 15:15, time-exits at 15:15 with the 15:14 premium; SL path", async () => {
  const s = sig({ status: "TRIGGERED", entry_premium: 100 });
  const idx = [m("10:47", 24212, 24226, 24211, 24225), m("15:14", 24240, 24245, 24235, 24241)];
  const opt = [m("10:47", 100, 101, 99, 100), m("15:14", 90, 91, 89, 90)];
  const { d } = trackDeps([s], idx, opt, "15:10");
  await runTrack(d);
  eq(s.status, "TRIGGERED");
  d.now = "15:16";
  await runTrack(d);
  eq([s.status, s.exit_premium, s.pnl_rs], ["TIME_EXIT", 90, -710]);

  const s2 = sig({ status: "TRIGGERED", entry_premium: 100 });
  const t2 = trackDeps([s2], [m("10:47", 24212, 24226, 24211, 24225), m("10:58", 24200, 24201, 24180, 24185)], [m("10:58", 82, 83, 80, 81)], "11:00");
  await runTrack(t2.d);
  eq([s2.status, s2.pnl_rs], ["SL", Math.round((81 - 100) * 65 - 60)]);
  ok(t2.msgs[0].startsWith("🛑 SL hit"));
});

Deno.test("premiumAt uses the minute's close or the nearest earlier one", () => {
  const c = [m("10:00", 1, 1, 1, 10), m("10:05", 1, 1, 1, 12)];
  eq([premiumAt(c, "10:03"), premiumAt(c, "10:05"), premiumAt(c, "09:59")], [10, 12, null]);
});

Deno.test("evening paper summary", () => {
  const closed = [sig({ status: "TARGET", pnl_rs: 2345 }), sig({ b_time: "13:00", status: "SL", pnl_rs: -1295 })];
  const t = paperSummary("2026-11-25", closed, closed, [{ variant: "A", status: "SL", r_mult: -1 }, { variant: "E", status: "TARGET", r_mult: 1.8 }], "2026-11-26");
  ok(t.includes("Today total: +₹1,050") && t.includes("2 trades · 1 winners") && t.includes("A -1 · E +1.8"), t);
});
