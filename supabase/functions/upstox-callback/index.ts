// Edge Function `upstox-callback` — Upstox OAuth redirect target (verify_jwt off: Upstox's
// redirect carries no Supabase JWT). Security comes from the one-time `state`, which only
// the owner can create (api action `login_url`). SIGNALS ONLY.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { sendTelegram } from "../_shared/notify.ts";
import { SupabaseStore } from "../_shared/store.ts";
import { istParts, upstoxTokenExpiry } from "../_shared/time.ts";
import { exchangeCode, UpstoxError } from "../_shared/upstox.ts";

// Edge Functions can't serve HTML on the default domain, so: redirect to the dashboard, or plain text.
const text = (msg: string, status: number) => new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

Deno.serve(async (req) => {
  const store = new SupabaseStore();
  const url = new URL(req.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const app = await store.app();
  const back = app.dashboard_url ? `\n\nBack to the dashboard: ${app.dashboard_url}` : "";

  if (url.searchParams.get("error")) {
    await store.log("upstox_callback", "warn", `Upstox returned error: ${url.searchParams.get("error")}`);
    return text(`Upstox login cancelled: ${url.searchParams.get("error")}${back}`, 400);
  }
  if (!code || !(await store.consumeOauthState(state))) {
    await store.log("upstox_callback", "warn", "Rejected callback: missing code or bad/expired state");
    return text(`Login link expired or invalid. Start again from the dashboard.${back}`, 400);
  }
  const key = Deno.env.get("UPSTOX_API_KEY"), secret = Deno.env.get("UPSTOX_API_SECRET");
  if (!key || !secret) return text("UPSTOX_API_KEY / UPSTOX_API_SECRET secrets are not set in Supabase.", 500);

  let body;
  try {
    body = await exchangeCode(code, key, secret, app.upstox_redirect_uri);
  } catch (e) {
    await store.log("upstox_callback", "error", (e as Error).message);
    return text(`Upstox login failed: token exchange failed (${e instanceof UpstoxError ? e.status : "error"}). See logs.${back}`, 502);
  }
  const expires = upstoxTokenExpiry(new Date());
  await store.saveToken(body.access_token, expires, body);
  await store.log("upstox_callback", "info", "Upstox token stored", { expires_at: expires.toISOString() });
  const e = istParts(expires);
  await sendTelegram(Deno.env.get("TELEGRAM_BOT_TOKEN"), Deno.env.get("TELEGRAM_CHAT_ID"), `✅ Upstox login OK. Token valid until ${e.date} ${e.hhmm} IST.`);

  if (app.dashboard_url) return new Response(null, { status: 302, headers: { Location: `${app.dashboard_url}?upstox=ok` } });
  return text(`✅ Upstox login OK. Token valid until ${e.date} ${e.hhmm} IST. You can close this tab.`, 200);
});
