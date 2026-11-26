import { atr, planFor, runBacktest, simulateExit } from "../functions/_shared/backtest.ts";
import type { Candle } from "../functions/_shared/candles.ts";
import { DEFAULTS } from "../functions/_shared/strategy.ts";
import { eq, ok } from "./helpers.ts";
import { ceLevels, ceSeries } from "./strategy_fixtures.ts";

const m = (hhmm: string, o: number, h: number, l: number, c: number): Candle => ({ t: `2026-11-25T${hhmm}:00+05:30`, o, h, l, c });
const B = { t: "2026-11-25T10:30:00+05:30", o: 100, h: 110, l: 98, c: 109 };

Deno.test("ATR: Wilder smoothing", () => {
  const cs = Array.from({ length: 16 }, (_, i) => ({ t: String(i), o: 10, h: 12, l: 8, c: 10 }));
  const a = atr(cs, 14);
  eq([a[12], a[13], a[15]], [null, 4, 4]);
});

Deno.test("variant SL/target: A spec, B ATR, C signal candle, D next level", () => {
  const lv = ceLevels({ PDH: 10000, R1: 10000, R2: 10000, TC: 50, BC: 40 });
  eq(planFor("A", "CE", 115, 90, B, 12, lv, DEFAULTS), { sl: 90, R: 25, target: 165 });
  eq(planFor("B", "CE", 115, 90, B, 12, lv, DEFAULTS), { sl: 103, R: 12, target: 139 });
  eq(planFor("C", "CE", 115, 90, B, 12, lv, DEFAULTS), { sl: 93, R: 22, target: 159 });
  eq(planFor("D", "CE", 115, 90, B, 12, ceLevels({ PDH: 140, R1: 10000, R2: 10000, TC: 50, BC: 40 }), DEFAULTS), { sl: 103, R: 12, target: 140 });
  ok(String(planFor("D", "CE", 115, 90, B, 12, ceLevels({ PDH: 125, R1: 10000, R2: 10000, TC: 50, BC: 40 }), DEFAULTS)).startsWith("no room"));
  ok(String(planFor("A", "CE", 115, 90, B, 12, ceLevels({ PDH: 150, R1: 10000, R2: 10000, TC: 50, BC: 40 }), DEFAULTS)).startsWith("no room"));
});

Deno.test("exits on 1-min candles: target, SL, same-minute → SL, 15:15 time exit, not triggered", () => {
  const plan = { sl: 100, target: 130, R: 15 };
  const target = [m("10:45", 110, 112, 109, 111), m("10:46", 111, 116, 110, 115), m("10:47", 115, 131, 114, 130)];
  eq(simulateExit("CE", 115, plan, target, "10:45", "11:00"), { entry: "10:46", exit: "10:47", price: 130, status: "TARGET" });
  const sl = [m("10:45", 110, 116, 109, 111), m("10:46", 111, 112, 99, 100)];
  eq(simulateExit("CE", 115, plan, sl, "10:45", "11:00")!.status, "SL");
  const both = [m("10:45", 110, 116, 109, 111), m("10:46", 111, 131, 99, 120)];
  eq(simulateExit("CE", 115, plan, both, "10:45", "11:00")!.status, "SL");
  const flat = [m("10:45", 110, 116, 109, 111), m("15:14", 118, 119, 117, 118)];
  eq(simulateExit("CE", 115, plan, flat, "10:45", "11:00"), { entry: "10:45", exit: "15:15", price: 118, status: "TIME_EXIT" });
  eq(simulateExit("CE", 115, plan, [m("10:45", 110, 114, 109, 111)], "10:45", "11:00"), null);
});

Deno.test("end-to-end on the CE fixture: all 4 variants evaluated on the same setup", () => {
  const cs = ceSeries();
  const day = "2026-11-25";
  const p = cs[cs.length - 1].c; // 24218
  const oneMin = [m("10:45", p, p + 7, p - 1, p + 6), m("10:46", p + 6, p + 70, p + 5, p + 69)];
  const dailies = { "2026-11-24": { t: "x", o: 0, h: 24120, l: 23800, c: 24100 } };
  const trades = runBacktest(cs, { [day]: oneMin }, dailies, day, day, DEFAULTS);
  eq(trades.map((t) => t.variant).sort(), ["A", "B", "C", "D"]);
  ok(trades.every((t) => t.b_time === "10:30" && t.trigger === 24224), JSON.stringify(trades));
  ok(trades.some((t) => t.status === "TARGET"), JSON.stringify(trades.map((t) => [t.variant, t.status, t.reason])));
});

import { evaluatePullback, simulateHalf } from "../functions/_shared/backtest.ts";
import { ema } from "../functions/_shared/strategy.ts";

Deno.test("pullback: 2 green, 1 red, green resume → setup; half at 1.5R then trail", () => {
  const k = (i: number, o: number, h: number, l: number, c: number): Candle => {
    const m = 9 * 60 + 15 + i * 15;
    return { t: `2026-11-25T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00+05:30`, o, h, l, c };
  };
  // long gentle uptrend for EMA warm-up (previous days are not needed for this pure test)
  const cs: Candle[] = [];
  for (let i = 0; i < 60; i++) cs.push({ t: `2026-11-24T09:15:00+05:30`, o: 24000 + i, h: 24003 + i, l: 23998 + i, c: 24001 + i });
  cs.push(k(0, 24062, 24080, 24060, 24078), k(1, 24078, 24095, 24075, 24093), k(2, 24093, 24094, 24070, 24074), k(3, 24074, 24100, 24072, 24098));
  const lv = ceLevels({ TC: 23900, BC: 23890, PDC: 23880 });
  const st = evaluatePullback(cs, ema(cs.map((c) => c.c), 20), ema(cs.map((c) => c.c), 50), lv, DEFAULTS);
  ok(st, "expected a setup");
  eq([st!.side, st!.trigger, st!.sl, st!.R, st!.reds, st!.bClose, st!.validUntil], ["CE", 24105, 24065, 40, 1, "10:15", "10:30"]);
  const om = [m("10:15", 24098, 24106, 24097, 24105), m("10:20", 24105, 24166, 24104, 24165), m("10:31", 24165, 24200, 24160, 24190), m("10:50", 24190, 24191, 24150, 24151)];
  const day15 = [k(4, 24098, 24170, 24097, 24165), k(5, 24165, 24200, 24160, 24190)];
  const ex = simulateHalf(st!, 1.5, om, day15, 5)!;
  // T1 = 24165 at 10:20; 10:30 candle closes 10:45 with low 24160 → stop 24155; 10:50 low 24150 → runner out at 24155
  eq([ex.t1Time, ex.exit, ex.runner, ex.status, ex.pts], ["10:20", "10:50", 24155, "TARGET", 55]);
});

import { simulateOrb } from "../functions/_shared/orb.ts";

Deno.test("ORB: half at 2R then runner exits on a 15-min close below EMA20; SL; time stop", () => {
  const k15 = (hhmm: string, c: number): Candle => ({ t: `2026-11-25T${hhmm}:00+05:30`, o: c, h: c + 5, l: c - 5, c });
  // entry 100 at 10:00, OR middle 90 → R 10, T1 120
  const day15 = [k15("10:00", 110), k15("10:15", 118), k15("10:30", 112)];
  const ema = new Map<string, number | null>([[day15[0].t, 100], [day15[1].t, 110], [day15[2].t, 115]]);
  const win = [m("10:00", 100, 105, 99, 104), m("10:10", 104, 121, 103, 120), m("10:40", 113, 114, 111, 112), m("10:45", 112, 113, 110, 111)];
  const ex = simulateOrb("CE", 100, 90, "10:00", win, day15, ema);
  // 10:30 candle closes 112 < EMA 115 at 10:45 → runner out at 112: 0.5×20 + 0.5×12 = 16 pts
  eq([ex.status, ex.exit, ex.runner, ex.pts, ex.t1Time], ["TARGET", "10:45", 112, 16, "10:10"]);
  eq(simulateOrb("CE", 100, 90, "10:00", [m("10:05", 100, 101, 89, 90)], day15, ema).status, "SL");
  const slow = simulateOrb("CE", 100, 90, "10:00", [m("10:05", 100, 103, 98, 102), m("10:45", 101, 102, 100, 101)], day15, ema);
  eq([slow.status, slow.exit, slow.pts], ["TIME_EXIT", "10:45", 1]);
});
