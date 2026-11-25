// FII context for the 09:20 message (NSE participant-wise open interest). CONTEXT ONLY: the 12-month test
// found no next-day edge, so signals never use it.
import { dayLabel, dayShort } from "./messages.ts";

export interface PartRow {
  fut_idx_long: number; fut_idx_short: number;
  opt_idx_call_long: number; opt_idx_put_long: number; opt_idx_call_short: number; opt_idx_put_short: number;
}

export const fiiUrl = (date: string) =>
  `https://nsearchives.nseindia.com/content/nsccl/fao_participant_oi_${date.slice(8, 10)}${date.slice(5, 7)}${date.slice(0, 4)}.csv`;

/** NSE CSV → rows by client type (Client, DII, FII, Pro, TOTAL). */
export function parseParticipantOi(csv: string): Record<string, PartRow & { fut_stk_long: number; fut_stk_short: number }> {
  const out: Record<string, PartRow & { fut_stk_long: number; fut_stk_short: number }> = {};
  for (const line of csv.split(/\r?\n/)) {
    const f = line.split(",").map((x) => x.trim());
    if (!/^(Client|DII|FII|Pro|TOTAL)$/.test(f[0] ?? "")) continue;
    const n = (i: number) => Number(f[i]);
    out[f[0]] = { fut_idx_long: n(1), fut_idx_short: n(2), fut_stk_long: n(3), fut_stk_short: n(4),
      opt_idx_call_long: n(5), opt_idx_put_long: n(6), opt_idx_call_short: n(7), opt_idx_put_short: n(8) };
  }
  if (!out.FII || Object.values(out.FII).some((v) => !Number.isFinite(v))) throw new Error("FII row missing in NSE file");
  return out;
}

/** Fetch one day's file; null when NSE has none (holiday / not published yet). */
export async function fetchParticipantOi(date: string, f: typeof fetch = fetch) {
  const r = await f(fiiUrl(date), { headers: { "User-Agent": "Mozilla/5.0", Accept: "text/csv,*/*" } });
  const text = await r.text();
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`NSE HTTP ${r.status}`);
  return parseParticipantOi(text);
}

const n0 = (x: number) => Math.round(Math.abs(x)).toLocaleString("en-IN");
const lakh = (x: number) => `${(Math.abs(x) / 100000).toFixed(2)} lakh`;
const pct = (r: PartRow) => Math.round((r.fut_idx_long / (r.fut_idx_long + r.fut_idx_short)) * 100);

/** The approved 4-line block. `prev` = the trading day before `date` (optional). */
export function fiiLines(date: string, cur: PartRow, prevDate: string | null, prev: PartRow | null): string {
  const net = cur.fut_idx_long - cur.fut_idx_short;
  const lines = [`🏦 FII positions (${dayLabel(date)}, NSE)`];
  let fut = `• Index futures: ${pct(cur)}% long`;
  if (prev && prevDate) fut += ` (${dayShort(prevDate)}: ${pct(prev)}%)`;
  fut += `, net ${net < 0 ? "short" : "long"} ${n0(net)} contracts`;
  if (prev) {
    const d = net - (prev.fut_idx_long - prev.fut_idx_short);
    const grew = Math.sign(d) === Math.sign(net);
    if (d !== 0) fut += `, ${grew ? "increased" : "reduced"} by ${n0(d)}`;
  }
  lines.push(fut);
  const callNet = cur.opt_idx_call_long - cur.opt_idx_call_short;
  const putNet = cur.opt_idx_put_long - cur.opt_idx_put_short;
  const tilt = callNet - putNet; // bullish when long calls / short puts dominate
  lines.push(`• Index options: calls net ${callNet < 0 ? "sold" : "bought"} ${lakh(callNet)} · puts net ${putNet < 0 ? "sold" : "bought"} ${lakh(putNet)} → ${
    Math.abs(tilt) < 50000 ? "neutral" : tilt > 0 ? "bullish tilt" : "bearish tilt"}`);
  lines.push("ℹ️ For context only. Our 12-month test found FII data doesn't predict the next day.");
  return lines.join("\n");
}
