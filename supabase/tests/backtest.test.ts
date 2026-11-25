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
