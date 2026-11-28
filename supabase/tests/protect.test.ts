import { dhanDecide, type UpDay, upstoxDecide } from "../functions/_shared/protect.ts";
import { eq, ok } from "./helpers.ts";

const day = (): UpDay => ({ date: "2026-11-30", alerts: [], mode: "NORMAL" });
const P = (k: string, q: number, pnl: number) => ({ instrument_token: `NSE_FO|${k}`, quantity: q, pnl });

Deno.test("Upstox: nudges, then loss limit → exit all until flat → lock", () => {
  const d = day();
  eq(upstoxDecide(d, [P("1", 65, -1600)]).alerts, ["L50"]);
  let s = upstoxDecide(d, [P("1", 65, -3050)]);
  eq([s.alerts, s.actions, s.lockNow, d.mode], [["L80", "LOSS"], [{ type: "EXIT_ALL" }], false, "LOSS_EXIT"]);
  s = upstoxDecide(d, [P("1", 65, -3100)]); // still open: keep exiting, no repeat alert
  eq([s.alerts, s.actions], [[], [{ type: "EXIT_ALL" }]]);
  s = upstoxDecide(d, [P("1", 0, -3120)]);
  eq([s.actions, s.lockNow], [[], true]);
});

Deno.test("Upstox: target → open trade may run, new position exited, floor → exit all", () => {
  const d = day();
  let s = upstoxDecide(d, [P("1", 65, 1550)]);
  eq([s.alerts, s.actions, s.lockNow, d.mode], [["TARGET"], [], false, "TARGET_PROTECT"]);
  s = upstoxDecide(d, [P("1", 65, 1700), P("2", 65, -20)]); // new trade after target
  eq(s.actions, [{ type: "EXIT", keys: ["NSE_FO|2"] }]);
  ok(s.alerts.includes("NEW_AFTER_TARGET"));
  s = upstoxDecide(d, [P("1", 130, 1800)]); // adding to the same contract is also new
  eq(s.actions, [{ type: "EXIT", keys: ["NSE_FO|1"] }]);
  s = upstoxDecide(d, [P("1", 65, 990)]);
  eq([s.alerts, s.actions, d.mode], [["FLOOR"], [{ type: "EXIT_ALL" }], "FLOOR_EXIT"]);
  eq(upstoxDecide(d, [P("1", 0, 980)]).lockNow, true);
});

Deno.test("Upstox: target reached and you close yourself → lock immediately; re-entry after closing is exited", () => {
  const d = day();
  upstoxDecide(d, [P("1", 65, 1600)]);
  const s = upstoxDecide(d, [P("1", 0, 1600)]);
  eq([s.actions, s.lockNow], [[], true]);
  const d2 = day();
  upstoxDecide(d2, [P("1", 65, 1600)]);
  upstoxDecide(d2, [P("1", 0, 1600)]);
  eq(upstoxDecide(d2, [P("1", 65, 1590)]).actions, [{ type: "EXIT", keys: ["NSE_FO|1"] }]);
});

Deno.test("Upstox: equity positions count in P&L but are never exited; locked day does nothing", () => {
  const d = day();
  const s = upstoxDecide(d, [{ instrument_token: "NSE_EQ|INE1", quantity: 10, pnl: -3200 }]);
  eq([s.actions, s.lockNow], [[], true]);
  d.mode = "LOCKED";
  eq(upstoxDecide(d, [P("1", 65, -5000)]).actions, []);
});

Deno.test("Dhan: nudges only; P&L Exit is set once a day", () => {
  const d = { date: "2026-11-30", alerts: [] as string[] };
  const s = dhanDecide(d, [{ realizedProfit: -1000, unrealizedProfit: -700, netQty: 65 }]);
  eq([s.pnl, s.alerts, s.setPnlExit], [-1700, ["L50"], true]);
  eq(dhanDecide({ ...d, pnl_exit_set: true }, []).setPnlExit, false);
});
