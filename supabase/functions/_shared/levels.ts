// Previous-day levels (spec §5), OI strikes and expiry selection (spec §7). Pure.
import { prevTradingDay } from "./time.ts";

const r2 = (x: number) => Math.round(x * 100) / 100;

export interface Levels {
  P: number; BC: number; TC: number; R1: number; S1: number; R2: number; S2: number;
  PDH: number; PDL: number; PDC: number; cpr_width: number;
  no_trade: { cpr_low: number; cpr_high: number; pdc_band: number; pdc_low: number; pdc_high: number };
}

/**
 * Levels for the NEXT session from one day's daily candle {h, l, c}.
 * P = (H+L+C)/3, BC = (H+L)/2, TC = 2P−BC (swapped if BC > TC),
 * R1 = 2P−L, S1 = 2P−H, R2 = P+(H−L), S2 = P−(H−L).
 * No-trade zone = inside CPR, or within ±band of PDC. Rounded to 2 decimals only at the end.
 */
export function computeLevels(daily: { h: number; l: number; c: number }, band: number): Levels {
  const h = Number(daily.h), l = Number(daily.l), c = Number(daily.c);
  const p = (h + l + c) / 3;
  let bc = (h + l) / 2;
  let tc = 2 * p - bc;
  if (bc > tc) [bc, tc] = [tc, bc];
  return {
    P: r2(p), BC: r2(bc), TC: r2(tc),
    R1: r2(2 * p - l), S1: r2(2 * p - h), R2: r2(p + (h - l)), S2: r2(p - (h - l)),
    PDH: r2(h), PDL: r2(l), PDC: r2(c), cpr_width: r2(tc - bc),
    no_trade: { cpr_low: r2(bc), cpr_high: r2(tc), pdc_band: Number(band), pdc_low: r2(c - band), pdc_high: r2(c + band) },
  };
}

export interface ChainLeg {
  instrument_key?: string;
  market_data?: { oi?: number; ltp?: number };
  option_greeks?: { delta?: number };
}
export interface ChainRow {
  strike_price: number;
  underlying_spot_price?: number;
  call_options?: ChainLeg;
  put_options?: ChainLeg;
}

export interface OiLevels {
  maxCallOI: number; maxCallOI_oi: number; maxPutOI: number; maxPutOI_oi: number;
  call_oi_top: { strike: number; oi: number }[]; put_oi_top: { strike: number; oi: number }[];
  oi_spot: number;
}

/** Strike with the highest call OI (resistance) and put OI (support). Ties -> nearest to spot. */
export function maxOiStrikes(chain: ChainRow[], topN = 3): OiLevels {
  if (!chain.length) throw new Error("empty option chain");
  const spot = Number(chain[0].underlying_spot_price ?? 0);
  const side = (key: "call_options" | "put_options") =>
    chain
      .map((r) => [Number(r.strike_price), Number(r[key]?.market_data?.oi ?? 0)] as [number, number])
      .sort((a, b) => b[1] - a[1] || Math.abs(a[0] - spot) - Math.abs(b[0] - spot));
  const calls = side("call_options"), puts = side("put_options");
  if (calls[0][1] === 0 || puts[0][1] === 0) throw new Error("option chain has no open interest");
  return {
    maxCallOI: calls[0][0], maxCallOI_oi: calls[0][1], maxPutOI: puts[0][0], maxPutOI_oi: puts[0][1],
    call_oi_top: calls.slice(0, topN).map(([strike, oi]) => ({ strike, oi })),
    put_oi_top: puts.slice(0, topN).map(([strike, oi]) => ({ strike, oi })),
    oi_spot: spot,
  };
}

export interface ExpiryCache {
  expiries: string[]; current_expiry: string; next_expiry: string | null; trade_expiry: string;
  rolled_to_next: boolean; lot_size: number; lot_sizes: Record<string, number>; for_date: string;
}

/**
 * Spec §7: trade the current weekly expiry, except on expiry day and the trading day
 * before it, when the next weekly expiry is used. Monthly expiries count as that week's
 * expiry. Lot size and expiries come from Upstox; nothing is hardcoded.
 */
export function selectExpiries(
  contracts: { expiry?: string; lot_size?: number }[], today: string, holidays: Set<string>,
): ExpiryCache {
  const lotSizes: Record<string, number> = {};
  for (const c of contracts) {
    const exp = String(c.expiry ?? "").slice(0, 10);
    if (exp && exp >= today && !(exp in lotSizes) && c.lot_size) lotSizes[exp] = Number(c.lot_size);
  }
  const expiries = Object.keys(lotSizes).sort();
  if (!expiries.length) throw new Error("no current or future expiries in option contracts");
  const current = expiries[0];
  const next = expiries[1] ?? null;
  const roll = today === current || today === prevTradingDay(current, holidays);
  const trade = roll && next ? next : current;
  const first8 = expiries.slice(0, 8);
  return {
    expiries: first8, current_expiry: current, next_expiry: next, trade_expiry: trade,
    rolled_to_next: Boolean(roll && next), lot_size: lotSizes[trade],
    lot_sizes: Object.fromEntries(first8.map((e) => [e, lotSizes[e]])), for_date: today,
  };
}
