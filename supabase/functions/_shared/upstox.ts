// Read-only Upstox API client.
// SIGNALS ONLY: never add any order / GTT / portfolio-changing endpoint here.
import type { Candle } from "./candles.ts";
import type { ChainRow } from "./levels.ts";

export const BASE_URL = "https://api.upstox.com";
export const NIFTY_INDEX_KEY = "NSE_INDEX|Nifty 50";

export class UpstoxError extends Error {
  constructor(message: string, public status?: number) { super(message); this.name = "UpstoxError"; }
}
/** Token missing, expired or rejected (401). The owner must log in again. */
export class UpstoxAuthError extends UpstoxError {
  constructor(message: string, status?: number) { super(message, status); this.name = "UpstoxAuthError"; }
}

type Fetch = typeof fetch;
const enc = (s: string) => encodeURIComponent(s);

export function buildAuthorizeUrl(apiKey: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ response_type: "code", client_id: apiKey, redirect_uri: redirectUri, state });
  return `${BASE_URL}/v2/login/authorization/dialog?${q}`;
}

export async function exchangeCode(
  code: string, apiKey: string, apiSecret: string, redirectUri: string, f: Fetch = fetch,
): Promise<{ access_token: string; user_name?: string; user_id?: string }> {
  const resp = await f(`${BASE_URL}/v2/login/authorization/token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: apiKey, client_secret: apiSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  const text = await resp.text();
  if (resp.status !== 200) throw new UpstoxError(`Token exchange failed: HTTP ${resp.status} ${text.slice(0, 300)}`, resp.status);
  const body = JSON.parse(text);
  if (!body.access_token) throw new UpstoxError(`Token exchange returned no access_token`);
  return body;
}

/** Upstox rows [ts, o, h, l, c, volume, oi] -> candles, oldest first. */
export function normalizeCandles(raw: unknown[][] | undefined): Candle[] {
  return (raw ?? [])
    .map((r) => ({
      t: String(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]),
      v: Number(r[5] ?? 0) || 0, oi: Number(r[6] ?? 0) || 0,
    }))
    .sort((a, b) => a.t.localeCompare(b.t));
}

export function nseTradingHolidays(rows: { date?: string; holiday_type?: string; closed_exchanges?: string[] }[]): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.holiday_type !== "TRADING_HOLIDAY") continue;
    const closed = new Set(r.closed_exchanges ?? []);
    if (closed.has("NSE") || closed.has("NFO")) out.add(String(r.date).slice(0, 10));
  }
  return [...out].sort();
}

/**
 * Retries once on network errors, 429 and 5xx (spec §3). 401 -> UpstoxAuthError immediately.
 */
export class UpstoxClient {
  constructor(
    public accessToken: string | null,
    private f: Fetch = fetch,
    private retries = 1,
    private retryWaitMs = 1500,
  ) {}

  private async get(path: string, auth = true, query?: Record<string, string>): Promise<any> {
    let url = `${BASE_URL}${path}`;
    if (query) url += "?" + Object.entries(query).map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (auth) {
      if (!this.accessToken) throw new UpstoxAuthError("No Upstox access token");
      headers.Authorization = `Bearer ${this.accessToken}`;
    }
    let last: UpstoxError | null = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, this.retryWaitMs));
      let resp: Response;
      try {
        resp = await this.f(url, { headers });
      } catch (e) {
        last = new UpstoxError(`Network error on GET ${path}: ${(e as Error).message}`);
        continue;
      }
      const text = await resp.text();
      if (resp.status === 401) throw new UpstoxAuthError(`Upstox rejected the token (401) on GET ${path}`, 401);
      if (resp.status === 429 || resp.status >= 500) {
        last = new UpstoxError(`HTTP ${resp.status} on GET ${path}: ${text.slice(0, 300)}`, resp.status);
        continue;
      }
      if (resp.status !== 200) throw new UpstoxError(`HTTP ${resp.status} on GET ${path}: ${text.slice(0, 300)}`, resp.status);
      const body = JSON.parse(text);
      if (body.status && body.status !== "success") throw new UpstoxError(`Upstox error on GET ${path}: ${text.slice(0, 300)}`, resp.status);
      return body;
    }
    throw last!;
  }

  async profile(): Promise<{ user_name?: string; user_id?: string }> { return (await this.get("/v2/user/profile")).data ?? {}; }

  /** Historical Candle V3. For 1–15 minute candles one request may span at most one month. */
  async historicalCandles(key: string, unit: string, interval: number, from: string, to: string): Promise<Candle[]> {
    return normalizeCandles((await this.get(`/v3/historical-candle/${enc(key)}/${unit}/${interval}/${to}/${from}`)).data?.candles);
  }

  /** Today's candles (current session). */
  async intradayCandles(key: string, unit: string, interval: number): Promise<Candle[]> {
    return normalizeCandles((await this.get(`/v3/historical-candle/intraday/${enc(key)}/${unit}/${interval}`)).data?.candles);
  }

  async optionContracts(key: string): Promise<{ expiry?: string; lot_size?: number }[]> {
    return (await this.get("/v2/option/contract", true, { instrument_key: key })).data ?? [];
  }

  async optionChain(key: string, expiry: string): Promise<ChainRow[]> {
    return (await this.get("/v2/option/chain", true, { instrument_key: key, expiry_date: expiry })).data ?? [];
  }

  async marketHolidays(): Promise<any[]> {
    return (await this.get("/v2/market/holidays", Boolean(this.accessToken))).data ?? [];
  }
}
