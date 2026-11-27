import type { Candle } from "../functions/_shared/candles.ts";
import { atmStrike, closeAt, condorStrikes, minuteGrid, pickExpiry, simulateCondor } from "../functions/_shared/optbt.ts";
import { eq, ok } from "./helpers.ts";

const k = (d: string, hhmm: string, c: number): Candle => ({ t: `${d}T${hhmm}:00+05:30`, o: c, h: c, l: c, c });
const prev = (d: string) => ({ "2026-11-17": "2026-11-16", "2026-11-23": "2026-11-20", "2026-11-24": "2026-11-23" } as Record<string, string>)[d] ?? "x";

Deno.test("optbt: expiry roll, ATM, closeAt forward-fill", () => {
  const ex = ["2026-11-17", "2026-11-23", "2026-12-01"];
  eq([pickExpiry("2026-11-13", ex, prev), pickExpiry("2026-11-16", ex, prev), pickExpiry("2026-11-17", ex, prev), pickExpiry("2026-11-18", ex, prev)],
    ["2026-11-17", "2026-11-23", "2026-11-23", "2026-11-23"]);
  eq([atmStrike(25924), atmStrike(25926)], [25900, 25950]);
  const c = [k("2026-11-13", "10:00", 5), k("2026-11-13", "10:03", 7)];
  eq([closeAt(c, "2026-11-13", "10:02"), closeAt(c, "2026-11-13", "10:03"), closeAt(c, "2026-11-13", "09:59"), closeAt(c, "2026-11-16", "09:15")], [5, 7, null, 7]);
});

Deno.test("optbt: condor strikes from VIX expected move, rounded outward, 150-pt wings", () => {
  const s = condorStrikes(26000, 16, 4);
  ok(Math.abs(s.em - 26000 * 0.16 * Math.sqrt(4 / 365)) < 0.01);
  eq([s.sc, s.sp, s.lc, s.lp], [26450, 25550, 26600, 25400]);
});

Deno.test("optbt: condor target / stop / time exit on minute closes", () => {
  const D = "2026-11-20", X = "2026-11-23";
  const grid = minuteGrid(D, "15:00", [D, X], X);
  eq([grid[0], grid[grid.length - 1]], [[D, "15:01"], [X, "15:14"]]);
  const flat = (p: number) => [k(D, "15:00", p)];
  // credit = 30 + 30 − 10 − 10 = 40
  const win = simulateCondor({ sc: [k(D, "15:00", 30), k(X, "10:00", 15)], sp: [k(D, "15:00", 30), k(X, "10:00", 10)], lc: flat(10).concat([k(X, "10:00", 3)]), lp: flat(10).concat([k(X, "10:00", 3)]) }, D, "15:00", grid)!;
  eq([win.credit, win.status, win.exitCost, win.exitMin], [40, "TARGET", 19, "10:00"]);
  const lose = simulateCondor({ sc: [k(D, "15:00", 30), k(X, "11:00", 160)], sp: [k(D, "15:00", 30), k(X, "11:00", 2)], lc: flat(10).concat([k(X, "11:00", 40)]), lp: flat(10).concat([k(X, "11:00", 1)]) }, D, "15:00", grid)!;
  eq([lose.status, lose.exitCost], ["SL", 121]);
  const time = simulateCondor({ sc: flat(30), sp: flat(30), lc: flat(10), lp: flat(10) }, D, "15:00", grid)!;
  eq([time.status, time.exitCost, time.exitDay, time.exitMin], ["TIME_EXIT", 40, X, "15:14"]);
});
