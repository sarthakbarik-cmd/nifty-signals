// Chart image for Telegram (pure: builds an SVG string; render.ts turns it into PNG).
// 15-min candles + the session's levels: CPR zone, PDC no-trade band, support/resistance
// lines with plain-language labels, optional "Now" price line and a bias badge.
import type { Candle } from "./candles.ts";
import type { LevelsDoc } from "./jobs.ts";

export interface ChartInput {
  title: string;                 // "NIFTY plan · Mon 23 Nov"
  subtitle: string;              // "Candles: Fri 20 Nov (15-min) · Levels for Mon 23 Nov · …"
  badge: { text: string; tone: "bull" | "bear" | "none" | "info" };
  candles: Candle[];
  levels: LevelsDoc & { maxCallOI?: number | null; maxPutOI?: number | null };
  prevName: string;              // "Fri" — the day the levels come from
  now?: { price: number } | null;
}

const C = {
  bg: "#ffffff", ink: "#1b1f24", muted: "#5d6673", grid: "#e6e9ed",
  up: "#1a7f37", down: "#cf222e", accent: "#1f6feb", warn: "#9a6700", now: "#6e40c9",
};
const fmt = (x: number) => Math.round(x).toLocaleString("en-IN");
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

type Kind = "res" | "sup" | "piv" | "ref";
export interface ChartLine { name: string; v: number; kind: Kind }

export function chartLines(lv: ChartInput["levels"], prevName: string): ChartLine[] {
  const out: ChartLine[] = [
    { name: "R2", v: lv.R2, kind: "res" }, { name: "R1", v: lv.R1, kind: "res" },
    { name: `${prevName} high`, v: lv.PDH, kind: "ref" }, { name: `${prevName} close`, v: lv.PDC, kind: "ref" },
    { name: "CPR top", v: lv.TC, kind: "piv" }, { name: "Pivot", v: lv.P, kind: "piv" }, { name: "CPR bottom", v: lv.BC, kind: "piv" },
    { name: "S1", v: lv.S1, kind: "sup" }, { name: `${prevName} low`, v: lv.PDL, kind: "ref" }, { name: "S2", v: lv.S2, kind: "sup" },
  ];
  if (lv.maxCallOI != null) out.push({ name: "Call OI (biggest)", v: lv.maxCallOI, kind: "res" });
  if (lv.maxPutOI != null) out.push({ name: "Put OI (biggest)", v: lv.maxPutOI, kind: "sup" });
  return out;
}

export function buildChartSvg(inp: ChartInput): { svg: string; shown: string[]; offChart: string[] } {
  const W = 1200, H = 760, padL = 70, padR = 270, padT = 110, padB = 110, plotR = W - padR;
  const lv = inp.levels, band = lv.no_trade.pdc_band;
  const prices = [...inp.candles.flatMap((c) => [c.h, c.l]), ...(inp.now ? [inp.now.price] : [])];
  let lo = prices.length ? Math.min(...prices) : lv.S1, hi = prices.length ? Math.max(...prices) : lv.R1;
  const span = Math.max(hi - lo, 60);
  const wLo = lo - 0.6 * span, wHi = hi + 0.6 * span;
  const all = chartLines(lv, inp.prevName);
  // CPR and previous-day high/low/close are always drawn; far R/S/OI levels may go off-chart.
  const shown = all.filter((x) => x.kind === "piv" || x.kind === "ref" || (x.v >= wLo && x.v <= wHi));
  const off = all.filter((x) => !shown.includes(x));
  for (const x of shown) { lo = Math.min(lo, x.v); hi = Math.max(hi, x.v); }
  lo = Math.min(lo, lv.no_trade.pdc_low, lv.BC); hi = Math.max(hi, lv.no_trade.pdc_high, lv.TC);
  const pad = (hi - lo) * 0.05; lo -= pad; hi += pad;
  const y = (v: number) => padT + ((hi - v) / (hi - lo)) * (H - padT - padB);

  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DejaVu Sans">`;
  s += `<rect width="${W}" height="${H}" fill="${C.bg}"/>`;
  s += `<text x="${padL}" y="46" font-size="30" font-weight="bold" fill="${C.ink}">${esc(inp.title)}</text>`;
  s += `<text x="${padL}" y="80" font-size="18" fill="${C.muted}">${esc(inp.subtitle)}</text>`;
  const tone = { bull: C.up, bear: C.down, none: C.muted, info: C.accent }[inp.badge.tone];
  const bwid = Math.max(220, inp.badge.text.length * 13 + 40);
  s += `<rect x="${W - 40 - bwid}" y="22" width="${bwid}" height="48" rx="24" fill="${tone}"/>`;
  s += `<text x="${W - 40 - bwid / 2}" y="54" font-size="21" font-weight="bold" fill="#fff" text-anchor="middle">${esc(inp.badge.text)}</text>`;

  for (let i = 0; i <= 5; i++) {
    const v = lo + ((hi - lo) * i) / 5;
    s += `<line x1="${padL}" x2="${plotR}" y1="${y(v)}" y2="${y(v)}" stroke="${C.grid}"/>`;
    s += `<text x="${padL - 10}" y="${y(v) + 6}" font-size="15" fill="${C.muted}" text-anchor="end">${fmt(v)}</text>`;
  }
  // zones
  const nt = lv.no_trade;
  s += `<rect x="${padL}" y="${y(nt.pdc_high)}" width="${plotR - padL}" height="${y(nt.pdc_low) - y(nt.pdc_high)}" fill="${C.warn}" fill-opacity="0.13"/>`;
  s += `<rect x="${padL}" y="${y(lv.TC)}" width="${plotR - padL}" height="${Math.max(2, y(lv.BC) - y(lv.TC))}" fill="${C.accent}" fill-opacity="0.14"/>`;
  s += `<text x="${padL + 8}" y="${y(lv.TC) + 20}" font-size="15" fill="${C.accent}" font-weight="bold">CPR zone · no trade</text>`;
  // level lines + labels (≥ 20 px apart)
  const col: Record<Kind, string> = { res: C.down, sup: C.up, piv: C.accent, ref: C.muted };
  const labs = shown.map((x) => ({ ...x, ly: y(x.v) })).sort((a, b) => a.ly - b.ly);
  for (let i = 1; i < labs.length; i++) if (labs[i].ly - labs[i - 1].ly < 20) labs[i].ly = labs[i - 1].ly + 20;
  for (const x of labs) {
    const dash = x.kind === "ref" ? `stroke-dasharray="7 5"` : x.name.includes("OI") ? `stroke-dasharray="2 5"` : "";
    s += `<line x1="${padL}" x2="${plotR}" y1="${y(x.v)}" y2="${y(x.v)}" stroke="${col[x.kind]}" stroke-width="${x.kind === "piv" ? 1.5 : 2.2}" ${dash}/>`;
    s += `<line x1="${plotR}" x2="${plotR + 10}" y1="${y(x.v)}" y2="${x.ly}" stroke="${C.grid}"/>`;
    s += `<text x="${plotR + 14}" y="${x.ly + 6}" font-size="16" fill="${C.ink}"><tspan fill="${col[x.kind]}" font-weight="bold">${esc(x.name)}</tspan>  ${fmt(x.v)}</text>`;
  }
  // candles (hollow = up, filled = down)
  const n = Math.max(inp.candles.length, 25);
  const step = (plotR - padL - (inp.now ? 60 : 10)) / n, bw = step * 0.6;
  inp.candles.forEach((c, i) => {
    const x = padL + i * step + step / 2;
    const up = c.c >= c.o, color = up ? C.up : C.down;
    const top = y(Math.max(c.o, c.c)), bot = y(Math.min(c.o, c.c));
    s += `<line x1="${x}" x2="${x}" y1="${y(c.h)}" y2="${y(c.l)}" stroke="${color}" stroke-width="2"/>`;
    s += `<rect x="${x - bw / 2}" y="${top}" width="${bw}" height="${Math.max(2, bot - top)}" rx="2" fill="${up ? C.bg : color}" stroke="${color}" stroke-width="2"/>`;
    if (i % 4 === 0) s += `<text x="${x}" y="${H - padB + 26}" font-size="15" fill="${C.muted}" text-anchor="middle">${c.t.slice(11, 16)}</text>`;
  });
  if (!inp.candles.length) {
    s += `<text x="${(padL + plotR) / 2}" y="${H / 2}" font-size="20" fill="${C.muted}" text-anchor="middle">No candles stored for this day</text>`;
  }
  // "Now" price line
  if (inp.now) {
    const ny = y(inp.now.price), nx = plotR - 52;
    s += `<line x1="${padL}" x2="${plotR}" y1="${ny}" y2="${ny}" stroke="${C.now}" stroke-width="2.5" stroke-dasharray="10 6"/>`;
    s += `<circle cx="${nx}" cy="${ny}" r="7" fill="${C.now}"/>`;
    s += `<rect x="${nx - 160}" y="${ny - 40}" width="150" height="30" rx="6" fill="${C.now}"/>`;
    s += `<text x="${nx - 85}" y="${ny - 19}" font-size="16" font-weight="bold" fill="#fff" text-anchor="middle">Now ${fmt(inp.now.price)}</text>`;
  }
  // legend
  const fy = H - 40;
  const item = (x: number, fill: string, t: string) =>
    `<rect x="${x}" y="${fy - 13}" width="22" height="14" rx="3" ${fill}/><text x="${x + 30}" y="${fy}" font-size="16" fill="${C.muted}">${esc(t)}</text>`;
  s += item(padL, `fill="${C.down}"`, "Resistance");
  s += item(padL + 150, `fill="${C.up}"`, "Support");
  s += item(padL + 270, `fill="${C.accent}" fill-opacity="0.35"`, "CPR zone");
  s += item(padL + 400, `fill="${C.warn}" fill-opacity="0.35"`, `Near ${inp.prevName} close (±${band})`);
  s += `<text x="${padL + 670}" y="${fy}" font-size="16" fill="${C.muted}">Hollow candle = up · filled = down</text>`;
  if (off.length) s += `<text x="${padL}" y="${fy + 26}" font-size="15" fill="${C.muted}">${esc(`Off chart: ${off.map((x) => `${x.name} ${fmt(x.v)}`).join("  ·  ")}`)}</text>`;
  s += `</svg>`;
  return { svg: s, shown: shown.map((x) => x.name), offChart: off.map((x) => x.name) };
}
