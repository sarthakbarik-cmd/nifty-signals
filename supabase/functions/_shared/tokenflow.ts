// Upstox "Access Token Request" flow (official, beta): the app asks Upstox for a token, the
// owner taps Approve in the Upstox app / WhatsApp, and Upstox POSTs the token to our
// notifier URL. Upstox does NOT authenticate that webhook, so every token is checked:
//   1. a request from us must be pending (not expired) and client_id must be our API key;
//   2. the token must work (live profile call to Upstox);
//   3. the account must be the owner's (user_id matches the one from earlier logins).
import { upstoxTokenExpiry } from "./time.ts";
import { BASE_URL, UpstoxError } from "./upstox.ts";

type Fetch = typeof fetch;

export interface TokenRequestState {
  status: "pending" | "approved" | "rejected_payload" | "failed";
  requested_at: string;
  authorization_expiry: string | null; // ISO
  by: "schedule" | "dashboard" | "reminder";
  approved_at?: string;
  note?: string;
}

export interface TokenStore {
  getConfig<T = unknown>(key: string): Promise<T | null>;
  setConfig(key: string, value: unknown): Promise<void>;
  getValidToken(): Promise<string | null>;
  saveToken(token: string, expiresAt: Date, profile: { user_name?: string; user_id?: string }): Promise<void>;
  log(job: string, level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>): Promise<void>;
}

/** POST /v3/login/auth/token/request/{client_id} — triggers the approval notification. */
export async function requestAccessToken(apiKey: string, apiSecret: string, f: Fetch = fetch) {
  const resp = await f(`${BASE_URL}/v3/login/auth/token/request/${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_secret: apiSecret }),
  });
  const text = await resp.text();
  let body: any = {};
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  if (resp.status !== 200 || body.status !== "success") {
    const err = body?.errors?.[0];
    const hint = err?.errorCode === "UDAPI1123" ? " (Notifier URL is not set in the Upstox app settings)" : "";
    throw new UpstoxError(`Token request failed: HTTP ${resp.status} ${err?.errorCode ?? ""} ${err?.message ?? text.slice(0, 200)}${hint}`.trim(), resp.status);
  }
  return body.data as { authorization_expiry: string; notifier_url: string };
}

const msToIso = (v: unknown): string | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 1e12 ? new Date(n).toISOString() : null;
};

/** Ask Upstox to notify the owner. Skips if a valid token already exists. */
export async function startTokenRequest(
  store: TokenStore, apiKey: string | undefined, apiSecret: string | undefined, by: TokenRequestState["by"],
  f: Fetch = fetch, now = new Date(),
): Promise<{ sent: boolean; reason: string; expires?: string | null }> {
  if (await store.getValidToken()) return { sent: false, reason: "already logged in" };
  if (!apiKey || !apiSecret) return { sent: false, reason: "UPSTOX_API_KEY / UPSTOX_API_SECRET not set" };
  const data = await requestAccessToken(apiKey, apiSecret, f);
  const state: TokenRequestState = {
    status: "pending", requested_at: now.toISOString(), authorization_expiry: msToIso(data.authorization_expiry), by,
  };
  await store.setConfig("token_request", state);
  await store.log("token_request", "info", `Approval request sent to Upstox app/WhatsApp (${by})`, { expires: state.authorization_expiry });
  return { sent: true, reason: "sent", expires: state.authorization_expiry };
}

export interface NotifierPayload {
  client_id: string; user_id: string; access_token: string; token_type?: string;
  expires_at?: string; issued_at?: string; message_type: string;
}

export function parseNotifier(p: unknown, expectedClientId: string): { ok: true; payload: NotifierPayload } | { ok: false; reason: string } {
  if (!p || typeof p !== "object") return { ok: false, reason: "body is not JSON" };
  const b = p as Record<string, unknown>;
  if (b.message_type !== "access_token") return { ok: false, reason: `unexpected message_type ${String(b.message_type)}` };
  for (const k of ["client_id", "user_id", "access_token"]) {
    if (typeof b[k] !== "string" || !(b[k] as string).length) return { ok: false, reason: `missing ${k}` };
  }
  if (b.client_id !== expectedClientId) return { ok: false, reason: "client_id does not match our API key" };
  return { ok: true, payload: b as unknown as NotifierPayload };
}

/**
 * Accept a token delivered to the notifier URL — only if all three checks pass.
 * `profile` performs a live Upstox call with the delivered token.
 */
export async function acceptNotifier(
  store: TokenStore, body: unknown, apiKey: string | undefined,
  profile: (token: string) => Promise<{ user_id?: string; user_name?: string }>, now = new Date(),
): Promise<{ accepted: boolean; reason: string; expires?: Date; hadPending: boolean }> {
  let hadPending = false; // only alert the owner about rejections while one of our requests was waiting
  const reject = async (reason: string) => {
    await store.log("upstox_notifier", "warn", `Ignored a token delivery: ${reason}`);
    return { accepted: false, reason, hadPending };
  };
  if (!apiKey) return reject("UPSTOX_API_KEY not set");
  const parsed = parseNotifier(body, apiKey);
  if (!parsed.ok) return reject(parsed.reason);
  const p = parsed.payload;

  // 1. a request from us must be pending and unexpired
  const req = await store.getConfig<TokenRequestState>("token_request");
  if (!req || req.status !== "pending") return reject("no approval request is pending");
  if (req.authorization_expiry && new Date(req.authorization_expiry).getTime() < now.getTime()) return reject("the pending request has expired");
  hadPending = true;

  // 3a. known owner account (from earlier logins)
  const known = (await store.getConfig<{ user_id?: string }>("upstox_status"))?.user_id;
  if (known && known !== p.user_id) return reject("token is for a different Upstox account");

  // 2. the token must work, and belong to the same user
  let prof: { user_id?: string; user_name?: string };
  try {
    prof = await profile(p.access_token);
  } catch (e) {
    return reject(`token failed a live check with Upstox (${(e as Error).message.slice(0, 120)})`);
  }
  if (prof.user_id && prof.user_id !== p.user_id) return reject("token's account does not match the delivery");

  const fromPayload = Number(p.expires_at);
  const expires = Number.isFinite(fromPayload) && fromPayload > now.getTime() ? new Date(fromPayload) : upstoxTokenExpiry(now);
  await store.saveToken(p.access_token, expires, { user_id: p.user_id, user_name: prof.user_name });
  await store.setConfig("token_request", { ...req, status: "approved", approved_at: now.toISOString() });
  await store.log("upstox_notifier", "info", "Upstox token received via app approval", { expires_at: expires.toISOString() });
  return { accepted: true, reason: "ok", expires, hadPending };
}
