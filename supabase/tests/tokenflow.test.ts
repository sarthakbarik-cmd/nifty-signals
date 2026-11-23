import { acceptNotifier, parseNotifier, requestAccessToken, startTokenRequest, type TokenStore } from "../functions/_shared/tokenflow.ts";
import { UpstoxError } from "../functions/_shared/upstox.ts";
import { eq, ok, rejects } from "./helpers.ts";

const KEY = "app-key-123", SECRET = "s3cret";
const NOW = new Date("2026-11-25T08:45:00+05:30");

class FakeStore implements TokenStore {
  cfg = new Map<string, unknown>();
  token: { token: string; expires: Date; profile: unknown } | null = null;
  valid: string | null = null;
  logs: string[] = [];
  async getConfig<T>(k: string) { return (this.cfg.get(k) as T) ?? null; }
  async setConfig(k: string, v: unknown) { this.cfg.set(k, v); }
  async getValidToken() { return this.valid; }
  async saveToken(token: string, expires: Date, profile: unknown) { this.token = { token, expires, profile }; }
  async log(_j: string, level: string, m: string) { this.logs.push(`${level}: ${m}`); }
}

function fetchReturning(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const payload = (over: Record<string, unknown> = {}) => ({
  client_id: KEY, user_id: "AB1234", access_token: "tok-xyz", token_type: "Bearer",
  expires_at: String(new Date("2026-11-26T03:30:00+05:30").getTime()), issued_at: String(NOW.getTime()),
  message_type: "access_token", ...over,
});

function pendingStore(knownUser = "AB1234") {
  const s = new FakeStore();
  s.cfg.set("token_request", { status: "pending", requested_at: NOW.toISOString(), authorization_expiry: "2026-11-26T03:30:00+05:30", by: "schedule" });
  if (knownUser) s.cfg.set("upstox_status", { user_id: knownUser });
  return s;
}
const goodProfile = async () => ({ user_id: "AB1234", user_name: "OWNER" });

// ------------------------------------------------------------------ request
Deno.test("request: exact Upstox URL, JSON body with client_secret", async () => {
  const { f, calls } = fetchReturning(200, { status: "success", data: { authorization_expiry: "1795656600000", notifier_url: "https://x/upstox-notifier" } });
  const d = await requestAccessToken(KEY, SECRET, f);
  eq(calls[0].url, "https://api.upstox.com/v3/login/auth/token/request/app-key-123");
  eq(calls[0].init?.method, "POST");
  eq(JSON.parse(String(calls[0].init?.body)), { client_secret: SECRET });
  eq(d.notifier_url, "https://x/upstox-notifier");
});

Deno.test("request: missing notifier URL gives a clear error", async () => {
  const { f } = fetchReturning(400, { status: "error", errors: [{ errorCode: "UDAPI1123", message: "Invalid notifier url" }] });
  const e = await rejects(() => requestAccessToken(KEY, SECRET, f), UpstoxError) as Error;
  ok(e.message.includes("UDAPI1123") && e.message.includes("Notifier URL is not set"), e.message);
});

Deno.test("startTokenRequest: skips when already logged in, records a pending request otherwise", async () => {
  const s = new FakeStore();
  s.valid = "existing";
  eq((await startTokenRequest(s, KEY, SECRET, "schedule")).reason, "already logged in");

  const s2 = new FakeStore();
  const { f } = fetchReturning(200, { status: "success", data: { authorization_expiry: "1795656600000", notifier_url: "u" } });
  const r = await startTokenRequest(s2, KEY, SECRET, "schedule", f, NOW);
  ok(r.sent);
  const st = s2.cfg.get("token_request") as Record<string, unknown>;
  eq([st.status, st.by, st.authorization_expiry], ["pending", "schedule", new Date(1795656600000).toISOString()]);
});

// ------------------------------------------------------------------ webhook checks
Deno.test("payload parsing: message type, required fields, our client_id", () => {
  ok(parseNotifier(payload(), KEY).ok);
  eq((parseNotifier(payload({ message_type: "order" }), KEY) as any).reason, "unexpected message_type order");
  eq((parseNotifier(payload({ access_token: "" }), KEY) as any).reason, "missing access_token");
  eq((parseNotifier(payload({ client_id: "other" }), KEY) as any).reason, "client_id does not match our API key");
  eq((parseNotifier("nope", KEY) as any).reason, "body is not JSON");
});

Deno.test("accepts a genuine approval: saves token with Upstox's expiry, marks request approved", async () => {
  const s = pendingStore();
  const r = await acceptNotifier(s, payload(), KEY, goodProfile, NOW);
  ok(r.accepted, r.reason);
  eq(s.token!.token, "tok-xyz");
  eq(s.token!.expires.toISOString(), new Date("2026-11-26T03:30:00+05:30").toISOString());
  eq((s.cfg.get("token_request") as any).status, "approved");
});

Deno.test("rejects when no request of ours is pending (and doesn't alert)", async () => {
  const s = new FakeStore();
  const r = await acceptNotifier(s, payload(), KEY, goodProfile, NOW);
  ok(!r.accepted && r.reason === "no approval request is pending" && !r.hadPending);
  eq(s.token, null);
});

Deno.test("rejects an expired request", async () => {
  const s = pendingStore();
  (s.cfg.get("token_request") as any).authorization_expiry = "2026-11-25T03:30:00+05:30";
  eq((await acceptNotifier(s, payload(), KEY, goodProfile, NOW)).reason, "the pending request has expired");
});

Deno.test("rejects another person's account, a fake token, and a mismatched profile", async () => {
  const a = await acceptNotifier(pendingStore("ZZ9999"), payload(), KEY, goodProfile, NOW);
  eq([a.accepted, a.reason, a.hadPending], [false, "token is for a different Upstox account", true]);

  const fake = await acceptNotifier(pendingStore(), payload(), KEY, async () => { throw new UpstoxError("401", 401); }, NOW);
  ok(!fake.accepted && fake.reason.startsWith("token failed a live check"));

  const mism = await acceptNotifier(pendingStore(""), payload(), KEY, async () => ({ user_id: "XX0000" }), NOW);
  eq(mism.reason, "token's account does not match the delivery");
});

Deno.test("first-ever approval (no known user id yet) works after the live check", async () => {
  const s = pendingStore("");
  ok((await acceptNotifier(s, payload(), KEY, goodProfile, NOW)).accepted);
});

Deno.test("expiry falls back to 03:30 IST when Upstox's value is missing or in the past", async () => {
  const s = pendingStore();
  const r = await acceptNotifier(s, payload({ expires_at: "0" }), KEY, goodProfile, NOW);
  eq(r.expires!.toISOString(), new Date("2026-11-26T03:30:00+05:30").toISOString());
});
