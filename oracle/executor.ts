// nifty-guard executor — runs on the Oracle server (fixed IP 130.210.3.221). Level-2 auto-protect "hands".
// Supabase (`trader` function) decides; this program only carries out:
//   Upstox: read positions · cancel pending F&O orders · EXIT existing F&O positions (never opens one)
//   Dhan:   read positions · set the day's P&L Exit (loss / profit / kill switch)
// It only makes OUTGOING HTTPS calls. Identity (random id + secret) is created on first start and stays on this server;
// the owner pairs it from the dashboard by matching the 6-character code.
const VERSION = "1.0.0";
const FN = "https://ukqwwlxerebcnhpqhmkm.supabase.co/functions/v1/trader";
const STATE_DIR = Deno.env.get("NG_STATE") ?? "/var/lib/nifty-guard";
const UPSTOX = "https://api.upstox.com";
const DHAN = "https://api.dhan.co/v2";

type Json = Record<string, any>;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));

async function identity(): Promise<{ id: string; secret: string; code: string }> {
  const f = `${STATE_DIR}/identity.json`;
  try { return JSON.parse(await Deno.readTextFile(f)); } catch { /* first start */ }
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const rnd = crypto.getRandomValues(new Uint8Array(6));
  const id = { id: crypto.randomUUID(), secret: hex(crypto.getRandomValues(new Uint8Array(32))), code: [...rnd].map((x) => alphabet[x % alphabet.length]).join("") };
  await Deno.mkdir(STATE_DIR, { recursive: true });
  await Deno.writeTextFile(f, JSON.stringify(id), { mode: 0o600 });
  return id;
}

async function post(body: Json): Promise<Json> {
  const r = await fetch(FN, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const t = await r.text();
  let j: Json = {};
  try { j = JSON.parse(t); } catch { /* not JSON */ }
  if (!r.ok) throw new Error(`trader ${r.status}: ${j.error ?? t.slice(0, 160)}`);
  return j;
}

async function publicIp(): Promise<string> {
  try { return (await (await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(5000) })).text()).trim(); } catch { return ""; }
}

// ---------------------------------------------------------------- Upstox
async function up(token: string, path: string, init: RequestInit = {}): Promise<Json> {
  const r = await fetch(UPSTOX + path, { ...init, headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  const t = await r.text();
  if (!r.ok) throw new Error(`Upstox ${r.status} ${path.split("?")[0]}: ${t.slice(0, 200)}`);
  return JSON.parse(t);
}
const isFo = (k: string) => k.startsWith("NSE_FO|") || k.startsWith("BSE_FO|");
const tick = (p: number) => Math.max(0.05, Math.round(p * 20) / 20);
const lastExit = new Map<string, number>(); // instrument → time of our last exit attempt (avoid stacking orders)

async function upstoxCancelFo(token: string, keys?: Set<string>, keepOwnExits = false) {
  const orders = ((await up(token, "/v2/order/retrieve-all")).data ?? []) as Json[];
  const open = orders.filter((o) => isFo(String(o.instrument_token)) && ["open", "trigger pending", "put order req received", "validation pending", "modify pending", "open pending"].includes(String(o.status).toLowerCase())
    && (!keys || keys.has(String(o.instrument_token))) && !(keepOwnExits && o.tag === "nifty-guard-exit"));
  for (const o of open) {
    try { await up(token, `/v2/order/cancel?order_id=${encodeURIComponent(o.order_id)}`, { method: "DELETE" }); } catch (e) { log("cancel failed", o.order_id, (e as Error).message); }
  }
  return open.length;
}

/** Exit given F&O positions with marketable LIMIT orders (sliced), after cancelling their pending orders. */
async function upstoxExit(token: string, positions: Json[], keys: string[]) {
  const now = Date.now();
  const targets = positions.filter((p) => keys.includes(String(p.instrument_token)) && Number(p.quantity) !== 0 && now - (lastExit.get(String(p.instrument_token)) ?? 0) > 20_000);
  if (!targets.length) return "nothing to exit (or exit already in progress)";
  await upstoxCancelFo(token, new Set(targets.map((p) => String(p.instrument_token))));
  const done: string[] = [];
  for (const p of targets) {
    const qty = Math.abs(Number(p.quantity)), sell = Number(p.quantity) > 0, ltp = Number(p.last_price) || 0;
    const price = tick(sell ? ltp * 0.95 : ltp * 1.05); // marketable limit, within exchange price bands
    const body = { quantity: qty, product: p.product ?? "I", validity: "DAY", price, tag: "nifty-guard-exit", instrument_token: p.instrument_token,
      order_type: "LIMIT", transaction_type: sell ? "SELL" : "BUY", disclosed_quantity: 0, trigger_price: 0, is_amo: false, slice: true };
    lastExit.set(String(p.instrument_token), now);
    await up(token, "/v3/order/place", { method: "POST", body: JSON.stringify(body) });
    done.push(`${p.trading_symbol ?? p.instrument_token} ${sell ? "SELL" : "BUY"} ${qty} @ ${price}`);
  }
  return done.join("; ");
}

// ---------------------------------------------------------------- Dhan
async function dhan(token: string, path: string, init: RequestInit = {}): Promise<Json> {
  const r = await fetch(DHAN + path, { ...init, headers: { Accept: "application/json", "Content-Type": "application/json", "access-token": token }, signal: AbortSignal.timeout(10_000) });
  const t = await r.text();
  if (!r.ok) throw new Error(`Dhan ${r.status} ${path}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : {};
}

// ---------------------------------------------------------------- main loop
async function main() {
  const me = await identity();
  const ip = await publicIp();
  log(`nifty-guard executor ${VERSION} · id ${me.id} · PAIRING CODE ${me.code} · ip ${ip}`);
  // pair
  for (;;) {
    try {
      const r = await post({ action: "exec_hello", id: me.id, secret_sha: await sha256(me.secret), code: me.code, ip, version: VERSION });
      if (r.status === "paired") break;
      log(`waiting for approval on the dashboard (code ${me.code}) — status ${r.status}`);
    } catch (e) { log("hello failed:", (e as Error).message); }
    await sleep(15_000);
  }
  log("paired ✔");
  let results: Json[] = [];
  let tokens: Json = {};
  for (;;) {
    let interval = 5_000;
    try {
      const body: Json = { action: "exec_sync", id: me.id, secret: me.secret, results };
      let upPositions: Json[] = [];
      if (tokens.upstox) {
        try { upPositions = ((await up(tokens.upstox, "/v2/portfolio/short-term-positions")).data ?? []) as Json[];
          body.upstox_positions = upPositions.map((p) => ({ instrument_token: p.instrument_token, quantity: p.quantity, pnl: p.pnl }));
        } catch (e) { body.upstox_error = (e as Error).message; }
      }
      if (tokens.dhan) {
        try { const d = await dhan(tokens.dhan.token, "/positions");
          body.dhan_positions = (Array.isArray(d) ? d : d.data ?? []).map((p: Json) => ({ realizedProfit: p.realizedProfit, unrealizedProfit: p.unrealizedProfit, netQty: p.netQty }));
        } catch (e) { body.dhan_error = (e as Error).message; }
      }
      const res = await post(body);
      results = [];
      tokens = res.tokens ?? {};
      interval = Number(res.interval_ms ?? 5_000);
      for (const a of (res.actions?.upstox ?? []) as Json[]) {
        try {
          const keys = a.type === "EXIT_ALL" ? upPositions.filter((p) => isFo(String(p.instrument_token)) && Number(p.quantity) !== 0).map((p) => String(p.instrument_token)) : a.keys as string[];
          // loss limit / floor: cancel EVERY pending F&O order first, so no entry order can open a new position
          const cancelled = a.type === "EXIT_ALL" ? await upstoxCancelFo(tokens.upstox, undefined, true) : 0;
          const detail = `${cancelled ? `cancelled ${cancelled} pending F&O order(s); ` : ""}${await upstoxExit(tokens.upstox, upPositions, keys)}`;
          results.push({ broker: "upstox", type: a.type, ok: true, detail });
          log("upstox", a.type, detail);
        } catch (e) { results.push({ broker: "upstox", type: a.type, ok: false, detail: (e as Error).message }); log("upstox action failed", (e as Error).message); }
      }
      for (const a of (res.actions?.dhan ?? []) as Json[]) {
        if (a.type !== "SET_PNL_EXIT") continue;
        try {
          const r = await dhan(tokens.dhan.token, "/pnlExit", { method: "POST", body: JSON.stringify({ dhanClientId: tokens.dhan.client_id,
            profitValue: a.profitValue, lossValue: a.lossValue, productType: a.productType, enableKillSwitch: a.enableKillSwitch }) });
          const ok = String(r.pnlExitStatus ?? "").toUpperCase() === "ACTIVE";
          results.push({ broker: "dhan", type: a.type, ok, detail: r.message ?? JSON.stringify(r).slice(0, 160) });
          log("dhan pnlExit", JSON.stringify(r));
        } catch (e) { results.push({ broker: "dhan", type: a.type, ok: false, detail: (e as Error).message }); log("dhan action failed", (e as Error).message); }
      }
      if (results.length) interval = 1_000; // report results quickly
    } catch (e) { log("sync failed:", (e as Error).message); interval = 10_000; }
    await sleep(interval);
  }
}

if (import.meta.main) main();
