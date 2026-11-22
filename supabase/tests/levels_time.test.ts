import { computeLevels, maxOiStrikes, selectExpiries } from "../functions/_shared/levels.ts";
import {
  candleDate, candleSlot, daysBetween, isTradingDay, nextTradingDay, prevTradingDay, sessionSlots, upstoxTokenExpiry,
} from "../functions/_shared/time.ts";
import { eq, ok, throws } from "./helpers.ts";

// ------------------------------------------------------------------ levels (spec §5)
Deno.test("levels match a hand calculation", () => {
  // H 24635.85, L 24473.25, C 24568.65 — by hand:
  // P  = 73677.75 / 3 = 24559.25 ; BC = 49109.10 / 2 = 24554.55 ; TC = 49118.50 − 24554.55 = 24563.95
  // R1 = 49118.50 − 24473.25 = 24645.25 ; S1 = 49118.50 − 24635.85 = 24482.65
  // R2 = 24559.25 + 162.60 = 24721.85 ; S2 = 24559.25 − 162.60 = 24396.65
  const lv = computeLevels({ h: 24635.85, l: 24473.25, c: 24568.65 }, 20);
  eq([lv.P, lv.BC, lv.TC], [24559.25, 24554.55, 24563.95]);
  eq([lv.R1, lv.S1, lv.R2, lv.S2], [24645.25, 24482.65, 24721.85, 24396.65]);
  eq([lv.PDH, lv.PDL, lv.PDC, lv.cpr_width], [24635.85, 24473.25, 24568.65, 9.4]);
  eq(lv.no_trade, { cpr_low: 24554.55, cpr_high: 24563.95, pdc_band: 20, pdc_low: 24548.65, pdc_high: 24588.65 });
});

Deno.test("BC/TC swapped when close is in the lower half", () => {
  const lv = computeLevels({ h: 100, l: 80, c: 82 }, 5); // P 87.33, BC 90, TC 84.67 -> swap
  eq([lv.BC, lv.TC], [84.67, 90]);
  ok(lv.BC <= lv.P && lv.P <= lv.TC);
  eq([lv.no_trade.cpr_low, lv.no_trade.pdc_high], [84.67, 87]);
});

// ------------------------------------------------------------------ OI
const chain = (rows: [number, number, number][], spot = 24550) =>
  rows.map(([k, c, p]) => ({ strike_price: k, underlying_spot_price: spot, call_options: { market_data: { oi: c } }, put_options: { market_data: { oi: p } } }));

Deno.test("max OI strikes with tie-break nearest spot", () => {
  const r = maxOiStrikes(chain([[24400, 5, 900], [24500, 300, 900], [24600, 800, 10], [24700, 800, 0]]));
  eq([r.maxCallOI, r.maxPutOI, r.oi_spot], [24600, 24500, 24550]);
  eq(r.call_oi_top[0], { strike: 24600, oi: 800 });
});

Deno.test("max OI rejects empty / zero-OI chains", () => {
  throws(() => maxOiStrikes([]));
  throws(() => maxOiStrikes(chain([[24500, 0, 0]])));
});

// ------------------------------------------------------------------ expiry rule (spec §7)
const CONTRACTS = [["2026-11-17", 75], ["2026-11-24", 75], ["2026-12-01", 75], ["2026-12-29", 65]].map(([expiry, lot_size]) => ({ expiry: String(expiry), lot_size: Number(lot_size) }));

for (const [today, hol, trade, rolled, why] of [
  ["2026-11-20", [], "2026-11-24", false, "Fri: normal"],
  ["2026-11-23", [], "2026-12-01", true, "Mon: day before Tue expiry"],
  ["2026-11-24", [], "2026-12-01", true, "Tue: expiry day"],
  ["2026-11-20", ["2026-11-23"], "2026-12-01", true, "Mon holiday -> Fri is the day before"],
] as [string, string[], string, boolean, string][]) {
  Deno.test(`trade expiry rule — ${why}`, () => {
    const c = selectExpiries(CONTRACTS, today, new Set(hol));
    eq([c.current_expiry, c.trade_expiry, c.rolled_to_next, c.lot_size], ["2026-11-24", trade, rolled, 75]);
  });
}

Deno.test("lot size follows the trade expiry; no future expiries throws", () => {
  eq(selectExpiries(CONTRACTS, "2026-12-28", new Set()).lot_size, 65);
  throws(() => selectExpiries(CONTRACTS, "2027-01-05", new Set()));
});

// ------------------------------------------------------------------ time
Deno.test("session slots", () => {
  const s15 = sessionSlots(15), s1 = sessionSlots(1);
  eq([s15.length, s15[0], s15[24], s1.length, s1[374]], [25, "09:15", "15:15", 375, "15:29"]);
});

Deno.test("trading days, next/prev with weekends and holidays", () => {
  ok(isTradingDay("2026-11-20", new Set()) && !isTradingDay("2026-11-21", new Set()));
  ok(!isTradingDay("2026-11-20", new Set(["2026-11-20"])));
  eq(nextTradingDay("2026-11-20", new Set()), "2026-11-23");
  eq(nextTradingDay("2026-11-20", new Set(["2026-11-23"])), "2026-11-24");
  eq(prevTradingDay("2026-11-24", new Set(["2026-11-23"])), "2026-11-20");
  eq(daysBetween("2026-11-01", "2026-11-30").length, 30);
  eq(daysBetween("2026-11-02", "2026-11-01"), []);
});

Deno.test("Upstox token expiry is the next 03:30 IST", () => {
  eq(upstoxTokenExpiry(new Date("2026-11-20T08:55:00+05:30")).toISOString(), new Date("2026-11-21T03:30:00+05:30").toISOString());
  eq(upstoxTokenExpiry(new Date("2026-11-20T02:00:00+05:30")).toISOString(), new Date("2026-11-20T03:30:00+05:30").toISOString());
  eq(upstoxTokenExpiry(new Date("2026-11-20T03:00:00Z")).toISOString(), new Date("2026-11-21T03:30:00+05:30").toISOString());
});

Deno.test("candle slot/date in IST", () => {
  eq([candleSlot("2026-11-20T09:15:00+05:30"), candleDate("2026-11-20T15:29:00+05:30"), candleSlot("2026-11-20T03:45:00+00:00")],
    ["09:15", "2026-11-20", "09:15"]);
});
