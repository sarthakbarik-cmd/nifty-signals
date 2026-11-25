// Deterministic candle series for strategy tests (CE uptrend; PE = mirror around a pivot price).
import type { Candle } from "../functions/_shared/candles.ts";
import { computeLevels } from "../functions/_shared/levels.ts";
import type { LevelsDoc } from "../functions/_shared/jobs.ts";

const pad = (n: number) => String(n).padStart(2, "0");
const slot = (k: number) => { const m = 555 + 15 * k; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
const r = (x: number) => Math.round(x * 100) / 100;

/** 3 previous days of steady uptrend, then today: 2 up candles, 3-candle pullback to EMA20, then B. */
export function ceSeries(opts: { bGreenStrong?: boolean; deepPull?: number } = {}): Candle[] {
  const out: Candle[] = [];
  let p = 24000;
  for (const day of ["2026-11-20", "2026-11-23", "2026-11-24"]) {
    for (let k = 0; k < 25; k++) {
      const o = p, c = p + 3;
      out.push({ t: `${day}T${slot(k)}:00+05:30`, o, h: c + 2, l: o - 2, c });
      p = c;
    }
  }
  const day = "2026-11-25";
  const push = (k: number, o: number, h: number, l: number, c: number) => out.push({ t: `${day}T${slot(k)}:00+05:30`, o: r(o), h: r(h), l: r(l), c: r(c) });
  push(0, p, p + 8, p - 2, p + 6); p += 6;
  push(1, p, p + 6, p - 2, p + 4); p += 4;
  // pullback: 3 red candles drifting toward EMA20 (~ p - 30)
  const deep = opts.deepPull ?? 34;
  push(2, p, p + 2, p - 14, p - 12); p -= 12;
  push(3, p, p + 2, p - 14, p - 12); p -= 12;
  push(4, p, p + 3, p - (deep - 24), p - 6); p -= 6;
  // B: green, close in top third (or weak if bGreenStrong === false)
  if (opts.bGreenStrong === false) push(5, p, p + 20, p - 2, p + 4);
  else push(5, p, p + 14, p - 2, p + 13);
  return out;
}

/** Levels far from price so filters pass (CPR well below → CE bias, resistance far above → room). */
export function ceLevels(over: Partial<LevelsDoc & { maxCallOI: number; maxPutOI: number }> = {}): LevelsDoc & { maxCallOI: number; maxPutOI: number } {
  const lv = computeLevels({ h: 24120, l: 23800, c: 24100 }, 20);
  return { ...lv, TC: 24000, BC: 23980, P: 23990, R1: 24600, R2: 24800, PDH: 24500, PDC: 24100, S1: 23700, S2: 23500, PDL: 23800,
    no_trade: { ...lv.no_trade, pdc_low: 24080, pdc_high: 24120 }, based_on: "2026-11-24", maxCallOI: 25000, maxPutOI: 23500, ...over };
}

/** Mirror a series around `pivot` (uptrend → downtrend) for PE tests. */
export function mirror(cs: Candle[], pivot = 24000): Candle[] {
  return cs.map((c) => ({ t: c.t, o: r(2 * pivot - c.o), h: r(2 * pivot - c.l), l: r(2 * pivot - c.h), c: r(2 * pivot - c.c) }));
}
