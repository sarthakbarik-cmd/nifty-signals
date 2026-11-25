// Phase 3 rule tests with fixed candles (spec §12: CE and PE, each skip reason).
import type { Candle } from "../functions/_shared/candles.ts";
import { runScan, type ScanDeps, type SignalRow } from "../functions/_shared/scan.ts";
import { DEFAULTS, ema, evaluateSetup, gateSetup, pickOption, settingsFrom, sizePosition, triggerHit } from "../functions/_shared/strategy.ts";
import { eq, ok } from "./helpers.ts";
import { ceLevels, ceSeries, mirror } from "./strategy_fixtures.ts";

const emas = (cs: Candle[]) => { const c = cs.map((x) => x.c); return [ema(c, 20), ema(c, 50)] as const; };
const evalCs = (cs: Candle[], lv = ceLevels(), s = DEFAULTS) => { const [a, b] = emas(cs); return evaluateSetup(cs, a, b, lv, s); };
const peLevels = () => {
  const m = (x: number) => 48000 - x, L = ceLevels();
  return { ...L, TC: m(L.BC), BC: m(L.TC), P: m(L.P), R1: m(L.S1), R2: m(L.S2), S1: m(L.R1), S2: m(L.R2), PDH: m(L.PDL), PDL: m(L.PDH),
    PDC: m(L.PDC), no_trade: { ...L.no_trade, pdc_low: m(L.no_trade.pdc_high), pdc_high: m(L.no_trade.pdc_low) }, maxCallOI: m(L.maxPutOI), maxPutOI: m(L.maxCallOI) };
};

// ------------------------------------------------------------------ EMA
Deno.test("EMA: SMA seed then 2/(n+1) smoothing", () => {
  const e = ema([1, 2, 3, 4, 5, 6], 3);
  eq([e[0], e[1], e[2], e[3], e[5]], [null, null, 2, 3, 5]);
});

// ------------------------------------------------------------------ setups
Deno.test("CE setup: trend + pullback to EMA20 + strong green B", () => {
  const ev = evalCs(ceSeries());
  ok(ev.kind === "setup", JSON.stringify(ev));
  const s = (ev as any).setup;
  eq([s.side, s.bClose, s.trigger, s.sl, s.R, s.target, s.validUntil], ["CE", "10:45", 24224, 24196, 28, 24280, "11:00"]);
  eq(s.details.confirmation, "close in top third");
});

Deno.test("PE setup: exact mirror", () => {
  const ev = evalCs(mirror(ceSeries()), peLevels());
  ok(ev.kind === "setup", JSON.stringify(ev));
  const s = (ev as any).setup;
  eq([s.side, s.trigger, s.sl, s.R, s.target], ["PE", 23776, 23804, 28, 23720]);
  eq(s.details.confirmation, "close in bottom third");
});

Deno.test("no signal inside CPR or near the previous close", () => {
  const cs = ceSeries();
  const b = cs[cs.length - 1].c; // 24218
  eq((evalCs(cs, ceLevels({ BC: b - 10, TC: b + 10 })) as any).reason, "price inside CPR (no-trade zone)");
  ok((evalCs(cs, ceLevels({ PDC: b + 15 })) as any).reason.startsWith("price within ±20 of previous close"));
});

Deno.test("no signal when trend, pullback or EMA50 rule fails", () => {
  const cs = ceSeries();
  const [e20, e50] = emas(cs);
  const n = cs.length - 1;
  const flat = e20.map((v, i) => i >= n - 3 ? (e50[i] as number) - 1 : v); // EMA20 below EMA50
  ok((evaluateSetup(cs, flat, e50, ceLevels(), DEFAULTS) as any).reason.includes("trend not aligned"));
  const far = e20.map((v, i) => i >= n - 3 && i < n ? (v as number) - 60 : v); // no touch
  eq((evaluateSetup(cs, far, e50, ceLevels(), DEFAULTS) as any).reason, "no pullback to EMA20 in the last 3 candles");
  const high50 = e50.map((v, i) => i === n - 2 ? cs[i].c + 1 : v); // a pullback candle closed below EMA50
  eq((evaluateSetup(cs, e20, high50, ceLevels(), DEFAULTS) as any).reason, "pullback closed below EMA50");
});

Deno.test("no signal when B is not a confirmation; engulfing counts", () => {
  ok((evalCs(ceSeries({ bGreenStrong: false })) as any).reason.includes("not a bullish confirmation"));
  const cs = ceSeries({ bGreenStrong: false });
  const prev = cs[cs.length - 2], b = cs[cs.length - 1];
  cs[cs.length - 1] = { ...b, o: prev.c - 1, c: prev.o + 1, h: prev.o + 20 }; // engulfs prev body, not top third
  const ev = evalCs(cs);
  ok(ev.kind === "setup" && (ev as any).setup.details.confirmation === "engulfing", JSON.stringify(ev));
});

// ------------------------------------------------------------------ skips
const ceSetup = () => (evalCs(ceSeries()) as any).setup;
const ctx = { todayOpen: 24225, tradesToday: 0, busy: false };

Deno.test("skip reasons: window, gap, max trades, busy, SL too wide, no room", () => {
  const s = ceSetup(), lv = ceLevels();
  eq(gateSetup(s, ctx, lv, DEFAULTS), null);
  eq(gateSetup(s, ctx, lv, { ...DEFAULTS, entry_end: "10:30" }), "outside entry window (09:30–10:30)");
  ok(gateSetup(s, ctx, lv, { ...DEFAULTS, gap_pct: 0.3, gap_wait_until: "11:00" })!.startsWith("gap day (0.52% > 0.3%)"));
  eq(gateSetup(s, { ...ctx, tradesToday: 2 }, lv, DEFAULTS), "max 2 trades for today already taken");
  eq(gateSetup(s, { ...ctx, busy: true }, lv, DEFAULTS), "another signal is already pending/open");
  eq(gateSetup(s, ctx, lv, { ...DEFAULTS, max_sl_pts: 20 }), "SL too wide (R 28 > 20 pts)");
  eq(gateSetup(s, ctx, ceLevels({ R1: 24260 }), DEFAULTS), "no room: R1 24260 is only 36 pts away (need 56)");
  eq(gateSetup(s, ctx, ceLevels({ PDH: 24250, R1: 24900, R2: 25000, maxCallOI: 26000 }), DEFAULTS), "no room: PDH 24250 is only 26 pts away (need 56)");
});

Deno.test("PE no-room uses levels BELOW the trigger", () => {
  const s = (evalCs(mirror(ceSeries()), peLevels()) as any).setup;
  eq(gateSetup(s, { ...ctx, todayOpen: 23775 }, { ...peLevels(), S1: 23740 }, DEFAULTS), "no room: S1 23740 is only 36 pts away (need 56)");
});

// ------------------------------------------------------------------ option + size
const chain = (spot: number, deltas: Record<number, [number, number]>) =>
  Object.entries(deltas).map(([k, [dc, dp]]) => ({
    strike_price: Number(k), underlying_spot_price: spot,
    call_options: { instrument_key: `CE${k}`, market_data: { ltp: 100 + (spot - Number(k)) / 2 }, option_greeks: { delta: dc } },
    put_options: { instrument_key: `PE${k}`, market_data: { ltp: 100 - (spot - Number(k)) / 2 }, option_greeks: { delta: dp } },
  }));

Deno.test("strike: ATM, or one strike ITM when |delta| < 0.5", () => {
  const c = chain(24218, { 24150: [0.62, -0.38], 24200: [0.55, -0.45], 24250: [0.45, -0.55] });
  eq(pickOption(c, "CE", 24218), { strike: 24200, key: "CE24200", ltp: 109, delta: 0.55, atm: 24200, itmShift: false });
  const p = pickOption(c, "PE", 24218)!; // ATM 24200 delta 0.45 → ITM for PE = higher strike
  eq([p.strike, p.delta, p.itmShift], [24250, 0.55, true]);
  const c2 = chain(24218, { 24150: [0.62, -0.38], 24200: [0.48, -0.52], 24250: [0.40, -0.6] });
  eq([pickOption(c2, "CE", 24218)!.strike, pickOption(c2, "CE", 24218)!.itmShift], [24150, true]);
});

Deno.test("lots = floor(capital × risk% ÷ (R × delta × lot size)); 0 when 1 lot is too risky", () => {
  eq(sizePosition(28, 0.5, 65, DEFAULTS), { lots: 1, perLot: 910, budget: 1000, risk: 910 });
  eq(sizePosition(10, 0.5, 65, DEFAULTS).lots, 3);
  eq(sizePosition(40, 0.55, 75, DEFAULTS), { lots: 0, perLot: 1650, budget: 1000, risk: 0 });
  eq(settingsFrom({ capital: "100000", entry_end: "14:00", junk: 1 }).capital, 100000);
});

Deno.test("trigger hit uses the next candle's high (CE) / low (PE)", () => {
  const n = { t: "x", o: 0, h: 24230, l: 24190, c: 0 };
  ok(triggerHit("CE", 24224, n) && !triggerHit("CE", 24231, n) && triggerHit("PE", 24190, n) && !triggerHit("PE", 24189, n));
});

// ------------------------------------------------------------------ scan lifecycle
function deps(cs: Candle[], over: Partial<ScanDeps> = {}) {
  const rows: SignalRow[] = [];
  const msgs: string[] = [];
  let id = 0;
  const d: ScanDeps = {
    today: "2026-11-25", candles: cs, levels: ceLevels(), settings: DEFAULTS, signalsToday: rows,
    chain: async () => ({ rows: chain(24218, { 24150: [0.62, -0.38], 24200: [0.5, -0.5], 24250: [0.45, -0.55] }) as any, expiry: "2026-12-01", lotSize: 65 }),
    insert: async (r) => { rows.push({ ...r, id: ++id }); },
    update: async (i, p) => { Object.assign(rows.find((r) => r.id === i)!, p); },
    notify: async (t) => { msgs.push(t); },
    log: async () => {},
    ...over,
  };
  return { d, rows, msgs };
}

Deno.test("scan: PENDING signal in the spec's Telegram format", async () => {
  const { d, rows, msgs } = deps(ceSeries());
  const r = await runScan(d);
  eq(r.result, "pending");
  const s = rows[0];
  eq([s.status, s.strike, s.lots, s.risk_rs, s.prem_sl, s.prem_target], ["PENDING", 24200, 1, 910, 95, 137]);
  for (const line of ["NIFTY CE SIGNAL  (PENDING)", "Buy 24,200 CE  1-Dec expiry", "If Nifty crosses 24,224 by 11:00",
    "SL: Nifty 24,196  | premium ~95", "Target: Nifty 24,280 | premium ~137", "Lots: 1 (lot size 65) | Risk ≈ ₹910"]) {
    ok(msgs[0].includes(line), `missing "${line}" in:\n${msgs[0]}`);
  }
  eq((await runScan(d)).result, "already evaluated"); // re-run on the same candle does nothing
});

Deno.test("scan: next candle hits trigger → TRIGGERED; misses → CANCELLED", async () => {
  const base = ceSeries();
  for (const [high, want] of [[24230, "TRIGGERED"], [24220, "CANCELLED"]] as const) {
    const { d, rows, msgs } = deps(base);
    await runScan(d);
    const next = { t: "2026-11-25T10:45:00+05:30", o: 24218, h: high, l: 24210, c: 24215 };
    d.candles = [...base, next];
    await runScan(d);
    eq(rows[0].status, want);
    ok(msgs[1].includes(want), msgs[1]);
  }
});

Deno.test("scan: ₹1,001 risk for 1 lot (> ₹1,000) is SKIPPED, not rounded up", async () => {
  const { d, rows } = deps(ceSeries(), {
    chain: async () => ({ rows: chain(24218, { 24150: [0.62, -0.38], 24200: [0.55, -0.45], 24250: [0.45, -0.55] }) as any, expiry: "2026-12-01", lotSize: 65 }),
  });
  await runScan(d);
  eq([rows[0].status, rows[0].reason], ["SKIPPED", "risk too high for 1 lot (1 lot risks ₹1001 > ₹1000)"]);
});

Deno.test("scan: setup with 0 lots is stored as SKIPPED with the reason", async () => {
  const { d, rows, msgs } = deps(ceSeries(), { settings: { ...DEFAULTS, capital: 20000 } });
  eq((await runScan(d)).result, "skipped");
  eq([rows[0].status, rows[0].reason], ["SKIPPED", "risk too high for 1 lot (1 lot risks ₹910 > ₹400)"]);
  ok(msgs[0].startsWith("⚪ NIFTY CE setup SKIPPED (10:30 candle)"));
});

Deno.test("scan: PE end to end", async () => {
  const { d, rows, msgs } = deps(mirror(ceSeries()), {
    levels: peLevels(),
    chain: async () => ({ rows: chain(23782, { 23750: [0.4, -0.45], 23800: [0.5, -0.5], 23850: [0.62, -0.62] }) as any, expiry: "2026-12-01", lotSize: 65 }),
  });
  eq((await runScan(d)).result, "pending");
  eq([rows[0].side, rows[0].strike, rows[0].trigger], ["PE", 23800, 23776]);
  ok(msgs[0].includes("If Nifty falls below 23,776 by 11:00"));
});
