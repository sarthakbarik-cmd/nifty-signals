import { guardStep, practiceGate, practiceTick, type PTrade, trailSl } from "../functions/_shared/practice.ts";
import { eq, ok } from "./helpers.ts";

const T = (o: Partial<PTrade> = {}): PTrade => ({ date: "2026-11-30", status: "OPEN", qty: 65, entry_price: 100, sl_price: 90, target_price: 120,
  sl_pts: 10, tgt_pts: 20, trail: false, high_water: 100, ...o });

Deno.test("practice gate: max trades, loss lock, cooldown, worst-case budget", () => {
  const now = "2026-11-30T05:00:00Z";
  eq(practiceGate([], 650, now), null);
  ok(String(practiceGate([T({ status: "SL" }), T({ status: "TARGET" }), T({ status: "SL" })], 650, now)).startsWith("max 3"));
  ok(String(practiceGate([T({ status: "SL", pnl_rs: -3100, exit_at: "2026-11-30T03:00:00Z" })], 650, now)).startsWith("day locked"));
  ok(String(practiceGate([T({ status: "SL", pnl_rs: -710, exit_at: "2026-11-30T04:45:00Z" })], 650, now)).startsWith("cooldown"));
  eq(practiceGate([T({ status: "SL", pnl_rs: -710, exit_at: "2026-11-30T04:20:00Z" })], 650, now), null); // 40 min ago
  ok(String(practiceGate([T({ status: "SL", pnl_rs: -2000, exit_at: "2026-11-30T03:00:00Z" })], 1300, now)).includes("could take today's loss to ₹3300"));
});

Deno.test("trailing: +10 → entry, +15 → +5, then 10 behind the high", () => {
  const t = T({ trail: true });
  eq([trailSl(t, 105), trailSl(t, 110), trailSl(t, 115), trailSl(t, 118)], [90, 100, 105, 108]);
  eq(trailSl(T(), 118), 90); // trail off
});

Deno.test("practice tick: SL, target, ₹1,500 cap, trailing exit", () => {
  eq(practiceTick(T(), 89).exit!.status, "SL");
  eq(practiceTick(T(), 121).exit!.status, "TARGET");
  eq(practiceTick(T({ qty: 195, target_price: 200 }), 108).exit!.status, "CAP"); // 8 × 195 = ₹1,560
  const t = T({ trail: true, high_water: 118, sl_price: 108 });
  const x = practiceTick(t, 107);
  eq([x.exit!.status, x.exit!.price, x.exit!.pnl], ["TRAIL", 106.5, Math.round(6.5 * 65 - 60)]);
  eq(practiceTick(T(), 105).exit, null);
});

Deno.test("watcher: alerts once, lock only when flat", () => {
  const day = { date: "2026-11-30", alerts: [] as string[] };
  const cfg = { loss_limit: 3000, target: 1500 };
  let s = guardStep(day, [{ instrument_token: "NSE_FO|1", quantity: 65, pnl: -1600 }], cfg);
  eq([s.pnl, s.alerts, s.lockNow], [-1600, ["L50"], false]);
  s = guardStep(day, [{ instrument_token: "NSE_FO|1", quantity: 65, pnl: -3050 }], cfg);
  eq([s.alerts, s.lockNow, s.openFo], [["L80", "LOSS"], false, 1]);
  s = guardStep(day, [{ instrument_token: "NSE_FO|1", quantity: 0, pnl: -3100 }], cfg);
  eq([s.alerts, s.lockNow], [[], true]);
  const win = { date: "2026-11-30", alerts: [] as string[] };
  eq(guardStep(win, [{ instrument_token: "BSE_FO|9", quantity: 0, pnl: 1550 }], cfg).lockNow, true);
});
