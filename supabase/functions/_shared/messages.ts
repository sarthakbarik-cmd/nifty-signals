// Plain-language Telegram messages (pure). Approved layout, 23 Nov 2026.
import type { DayReport } from "./candles.ts";
import type { LevelsDoc } from "./jobs.ts";
import type { ExpiryCache } from "./levels.ts";
import { addDays, isTradingDay, weekday } from "./time.ts";

const fmt = (x: number) => Math.round(x).toLocaleString("en-IN");
const fmt2 = (x: number) => x.toLocaleString("en-IN", { maximumFractionDigits: 2 });
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-23" -> "Mon 23 Nov" */
export function dayLabel(d: string): string {
  const [, m, dd] = d.split("-").map(Number);
  return `${DAYS[weekday(d)]} ${dd} ${MONTHS[m - 1]}`;
}
export const dayShort = (d: string) => DAYS[weekday(d)];
export const dayLong = (d: string) => LONG[weekday(d)];

export type LevelsWithOi = LevelsDoc & { maxCallOI?: number | null; maxPutOI?: number | null };
export type Bias = "bull" | "bear" | "none";

export function biasOf(lv: LevelsDoc, price: number): { bias: Bias; where: string } {
  const nt = lv.no_trade;
  if (price >= lv.BC && price <= lv.TC) return { bias: "none", where: "inside the CPR zone" };
  if (price >= nt.pdc_low && price <= nt.pdc_high) return { bias: "none", where: "near the previous close" };
  return price > lv.TC ? { bias: "bull", where: "above the CPR zone" } : { bias: "bear", where: "below the CPR zone" };
}

export const BADGE: Record<Bias, string> = { bull: "BULLISH · CE only", bear: "BEARISH · PE only", none: "NO TRADE ZONE" };

/** Named support/resistance levels (stay-out levels — CPR pivot and PDC — are listed separately). */
function namedLevels(lv: LevelsWithOi, prevLong: string, prefix = `${prevLong}'s`): { name: string; v: number }[] {
  const out = [
    { name: "R1", v: lv.R1 }, { name: "R2", v: lv.R2 }, { name: "S1", v: lv.S1 }, { name: "S2", v: lv.S2 },
    { name: `${prefix} high`, v: lv.PDH }, { name: `${prefix} low`, v: lv.PDL },
    { name: "CPR top", v: lv.TC }, { name: "CPR bottom", v: lv.BC },
  ];
  if (lv.maxCallOI != null) out.push({ name: "biggest call OI", v: lv.maxCallOI });
  if (lv.maxPutOI != null) out.push({ name: "biggest put OI", v: lv.maxPutOI });
  return out;
}

export function nearest(lv: LevelsWithOi, price: number, prevLong: string, n = 3, prefix?: string) {
  const all = namedLevels(lv, prevLong, prefix);
  const above = all.filter((x) => x.v > price).sort((a, b) => a.v - b.v).slice(0, n);
  const below = all.filter((x) => x.v < price).sort((a, b) => b.v - a.v).slice(0, n);
  const line = (xs: { name: string; v: number }[]) => xs.length ? xs.map((x) => `${fmt(x.v)} ${x.name}`).join(" · ") : "none nearby";
  return { above: line(above), below: line(below) };
}

export function cprWidthLine(lv: LevelsDoc, narrowPct = 0.25, widePct = 0.5): string {
  const pct = (lv.cpr_width / lv.P) * 100;
  const p = `${fmt2(lv.cpr_width)} pts, ${pct.toFixed(2)}%`;
  if (pct < narrowPct) return `📏 CPR is narrow (${p}) — often a trending day.`;
  if (pct > widePct) return `📏 CPR is wide (${p}) — often a sideways day.`;
  return `📏 CPR is normal width (${p}).`;
}

function expiryLine(today: string, inst: ExpiryCache): string {
  const exp = dayLabel(inst.trade_expiry).slice(4); // "1 Dec"
  if (!inst.rolled_to_next) return `📅 Options: use ${exp} expiry · lot size ${inst.lot_size}`;
  const why = today === inst.current_expiry ? "today is expiry day" : "the next trading day is expiry day";
  return `📅 Options: use ${exp} expiry (${why}) · lot size ${inst.lot_size}`;
}

/** 09:20 plan message (caption for the chart). */
export function morningPlan(
  today: string, lv: LevelsWithOi, price: number, inst: ExpiryCache | null, cfg: { narrow?: number; wide?: number } = {},
): { text: string; bias: Bias } {
  const prev = dayLong(lv.based_on);
  const { bias, where } = biasOf(lv, price);
  const nt = lv.no_trade;
  const nb = nearest(lv, price, prev);
  const head = bias === "bull"
    ? `🟢 Bias: BULLISH — price is ${where}.\n   Only CALL (CE) signals today.`
    : bias === "bear"
      ? `🔴 Bias: BEARISH — price is ${where}.\n   Only PUT (PE) signals today.`
      : `⚪ NO TRADE right now — Nifty is ${where}.\n   Signals start only after it moves out of the no-trade zone.`;
  const lines = [
    `📊 NIFTY plan — ${dayLabel(today)}   (Nifty ${fmt(price)} at 09:20)`,
    "",
    head,
    "",
    `🚫 Stay out if Nifty is inside:`,
    `   • ${fmt(nt.cpr_low)} – ${fmt(nt.cpr_high)}  (CPR zone)`,
    `   • ${fmt(nt.pdc_low)} – ${fmt(nt.pdc_high)}  (near ${prev}'s close)`,
    "",
    `⬆️ Resistance above (may stall here):`,
    `   ${nb.above}`,
    `⬇️ Support below (may bounce here):`,
    `   ${nb.below}`,
    "",
    cprWidthLine(lv, cfg.narrow, cfg.wide),
  ];
  if (inst) lines.push("", expiryLine(today, inst));
  lines.push("", "ℹ️ Bias uses the 09:20 price; signals still check every 15-min candle.");
  return { text: lines.join("\n"), bias };
}

/** Holidays (weekdays without trading) between two trading days, e.g. ["Tue 24 Nov"]. */
function skippedHolidays(from: string, to: string, holidays: Set<string>): string[] {
  const out: string[] = [];
  for (let d = addDays(from, 1); d < to; d = addDays(d, 1)) if (weekday(d) < 5 && !isTradingDay(d, holidays)) out.push(dayLabel(d));
  return out;
}

/** 15:45 message: today's data check + the next trading day's levels. */
export function eveningReport(
  report: DayReport, next: string | null, lv: LevelsWithOi | null, holidays: Set<string>, cfg: { narrow?: number; wide?: number } = {},
): string {
  const today = report.date;
  const d = report.daily;
  const problems = report.issues.filter((i) => i.severity !== "info").map((i) => `   • ${i.msg}`);
  const head = report.status === "ok"
    ? `✅ Today's data saved (all candles complete)`
    : report.status === "warn"
      ? `⚠️ Today's data saved, with small differences:\n${problems.join("\n")}`
      : `❌ Today's data has problems:\n${problems.join("\n")}`;
  const lines = [head];
  if (d) lines.push(`   ${dayLabel(today)}: Open ${fmt(d.o)} · High ${fmt(d.h)} · Low ${fmt(d.l)} · Close ${fmt(d.c)}`);
  if (next && lv) {
    const skipped = skippedHolidays(today, next, holidays);
    const nt = lv.no_trade;
    const nb = nearest(lv, lv.PDC, "today", 3, "today's");
    lines.push(
      "",
      `🗓️ Next trading day: ${dayLabel(next)}${skipped.length ? `  (${skipped.join(", ")}: market holiday)` : ""}`,
      `   🚫 Stay out: ${fmt(nt.cpr_low)} – ${fmt(nt.cpr_high)} (CPR) · ${fmt(nt.pdc_low)} – ${fmt(nt.pdc_high)} (near today's close)`,
      `   ⬆️ Resistance: ${nb.above}`,
      `   ⬇️ Support: ${nb.below}`,
      `   ${cprWidthLine(lv, cfg.narrow, cfg.wide)}`,
      `   Bias will be decided at 09:20 ${dayShort(next)} from the live price.`,
    );
  } else {
    lines.push("", "❌ Next day's levels could NOT be computed (no daily candle). Fetch today on the Data tab.");
  }
  return lines.join("\n");
}
