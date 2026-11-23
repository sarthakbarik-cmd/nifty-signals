import { buildDayReport } from "../functions/_shared/candles.ts";
import { buildChartSvg } from "../functions/_shared/chart.ts";
import type { LevelsDoc } from "../functions/_shared/jobs.ts";
import { computeLevels, selectExpiries } from "../functions/_shared/levels.ts";
import { biasOf, cprWidthLine, dayLabel, eveningReport, morningPlan, nearest } from "../functions/_shared/messages.ts";
import { sendTelegramPhoto } from "../functions/_shared/notify.ts";
import { eq, makeDay, ok } from "./helpers.ts";

// Real Mon 23 Nov 2026 levels (from Fri 20 Nov: H 25808.8, L 25345.2, C 25800.6) + real OI.
const LV: LevelsDoc & { maxCallOI: number; maxPutOI: number } = {
  ...computeLevels({ h: 25808.8, l: 25345.2, c: 25800.6 }, 20), based_on: "2026-11-20", maxCallOI: 26000, maxPutOI: 25000,
};
const INST = selectExpiries([{ expiry: "2026-11-23", lot_size: 65 }, { expiry: "2026-12-01", lot_size: 65 }], "2026-11-23", new Set(["2026-11-24"]));

Deno.test("real Monday levels match the stored ones", () => {
  eq([LV.P, LV.BC, LV.TC, LV.R1, LV.S1, LV.cpr_width], [25651.53, 25577, 25726.07, 25957.87, 25494.27, 149.07]);
});

Deno.test("day labels", () => {
  eq([dayLabel("2026-11-23"), dayLabel("2026-12-01")], ["Mon 23 Nov", "Tue 1 Dec"]);
});

Deno.test("bias: above CPR bull, below bear, inside CPR or near PDC none", () => {
  eq(biasOf(LV, 25854.65).bias, "bull");
  eq(biasOf(LV, 25400).bias, "bear");
  eq(biasOf(LV, 25650).bias, "none");                 // inside CPR
  eq(biasOf(LV, 25790), { bias: "none", where: "near the previous close" }); // PDC ± 20
});

Deno.test("nearest levels above/below price, plain names, PDC/pivot excluded", () => {
  const nb = nearest(LV, 25854.65, "Friday");
  eq(nb.above, "25,958 R1 · 26,000 biggest call OI · 26,115 R2");
  eq(nb.below, "25,809 Friday's high · 25,726 CPR top · 25,577 CPR bottom");
});

Deno.test("CPR width wording with the 0.25% / 0.5% cut-offs", () => {
  ok(cprWidthLine(LV).startsWith("📏 CPR is wide (149.07 pts, 0.58%) — often a sideways day."));
  ok(cprWidthLine({ ...LV, cpr_width: 40 }).includes("narrow"));
  ok(cprWidthLine({ ...LV, cpr_width: 100 }).includes("normal width"));
});

Deno.test("morning plan: approved layout with real numbers, fits a Telegram caption", () => {
  const { text, bias } = morningPlan("2026-11-23", LV, 25854.65, INST);
  eq(bias, "bull");
  for (const s of [
    "📊 NIFTY plan — Mon 23 Nov   (Nifty 25,855 at 09:20)",
    "🟢 Bias: BULLISH — price is above the CPR zone.",
    "Only CALL (CE) signals today.",
    "• 25,577 – 25,726  (CPR zone)",
    "• 25,781 – 25,821  (near Friday's close)",
    "📅 Options: use 1 Dec expiry (today is expiry day) · lot size 65",
  ]) ok(text.includes(s), `missing: ${s}\n---\n${text}`);
  ok(text.length <= 1024, `caption too long: ${text.length}`);
});

Deno.test("morning plan: no-trade and bearish wording", () => {
  ok(morningPlan("2026-11-23", LV, 25650, INST).text.includes("⚪ NO TRADE right now — Nifty is inside the CPR zone."));
  ok(morningPlan("2026-11-23", LV, 25400, null).text.includes("Only PUT (PE) signals today."));
});

Deno.test("evening report: data line, holiday note, next-day levels", () => {
  const { c1, c15, daily } = makeDay("2026-11-23");
  const report = buildDayReport("2026-11-23", c1, c15, daily);
  const next = { ...computeLevels(daily, 20), based_on: "2026-11-23" };
  const text = eveningReport(report, "2026-11-25", next, new Set(["2026-11-24"]));
  ok(text.startsWith("✅ Today's data saved (all candles complete)"), text);
  ok(text.includes("🗓️ Next trading day: Wed 25 Nov  (Tue 24 Nov: market holiday)"), text);
  ok(text.includes("Bias will be decided at 09:20 Wed from the live price."));
  ok(text.includes("today's high") || text.includes("today's low"));
  ok(eveningReport({ ...report, status: "error", issues: [{ severity: "error", code: "x", msg: "15m: 3 missing" }] }, null, null, new Set())
    .includes("❌ Today's data has problems"));
});

Deno.test("chart SVG (real Fri 20 Nov candles): badge, zones, now line, labels, off-chart list", async () => {
  const candles = JSON.parse(await Deno.readTextFile(new URL("./fixtures/nifty_15m_2026-11-20.json", import.meta.url)));
  const { svg, shown, offChart } = buildChartSvg({
    title: "NIFTY plan · Mon 23 Nov", subtitle: "Candles: Fri 20 Nov", badge: { text: "BULLISH · CE only", tone: "bull" },
    candles, levels: LV, prevName: "Fri", now: { price: 25854.65 },
  });
  for (const s of ["BULLISH · CE only", "CPR zone · no trade", "Now 25,855", "Hollow candle = up", "Off chart: Put OI (biggest) 25,000"]) {
    ok(svg.includes(s), s);
  }
  eq(offChart, ["Put OI (biggest)"]); // same as the approved sample
  eq(shown.length, 11);
  ok(svg.startsWith("<svg") && svg.endsWith("</svg>"));
});

Deno.test("chart always keeps CPR and previous-day lines, even on a very quiet day", () => {
  const { c15 } = makeDay("2026-11-20"); // ~9-point range, far from the levels
  const { shown } = buildChartSvg({
    title: "t", subtitle: "s", badge: { text: "x", tone: "info" }, candles: c15, levels: LV, prevName: "Fri", now: null,
  });
  for (const k of ["CPR top", "Pivot", "CPR bottom", "Fri high", "Fri close", "Fri low"]) ok(shown.includes(k), k);
});

// ---- Telegram: photo + caption + button, with fallbacks
function fakeFetch(statuses: number[]) {
  const calls: { url: string; body: unknown }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body });
    return new Response("{}", { status: statuses.shift() ?? 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

Deno.test("telegram: photo with caption and dashboard button", async () => {
  const { f, calls } = fakeFetch([200]);
  ok(await sendTelegramPhoto("T", "1", "hello", new Uint8Array([1, 2]), "https://trade.shopodisha.in/", f));
  eq(calls.length, 1);
  ok(calls[0].url.endsWith("/sendPhoto"));
  const form = calls[0].body as FormData;
  eq([form.get("chat_id"), form.get("caption")], ["1", "hello"]);
  ok(String(form.get("reply_markup")).includes("Open dashboard"));
});

Deno.test("telegram: falls back to text if no image, if photo fails, or if caption too long", async () => {
  const a = fakeFetch([200]);
  await sendTelegramPhoto("T", "1", "hi", null, null, a.f);
  ok(a.calls.length === 1 && a.calls[0].url.endsWith("/sendMessage"));

  const b = fakeFetch([500, 200]);
  await sendTelegramPhoto("T", "1", "hi", new Uint8Array([1]), null, b.f);
  ok(b.calls.length === 2 && b.calls[1].url.endsWith("/sendMessage"));

  const c = fakeFetch([200, 200]);
  await sendTelegramPhoto("T", "1", "x".repeat(1100), new Uint8Array([1]), null, c.f);
  ok(c.calls.length === 2 && (c.calls[0].body as FormData).get("caption") === null && c.calls[1].url.endsWith("/sendMessage"));
});
