// Edge Function `upstox-notifier` — Upstox POSTs the access token here after the owner taps
// Approve in the Upstox app / WhatsApp (Access Token Request flow). Upstox sends no signature,
// so tokenflow.acceptNotifier() checks: pending request + our client_id, a live Upstox call
// with the token, and that it is the owner's account. SIGNALS ONLY.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { sendTelegram } from "../_shared/notify.ts";
import { SupabaseStore } from "../_shared/store.ts";
import { istParts } from "../_shared/time.ts";
import { acceptNotifier } from "../_shared/tokenflow.ts";
import { UpstoxClient } from "../_shared/upstox.ts";

const reply = (body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply({ status: "ignored", reason: "POST only" });
  const store = new SupabaseStore();
  let body: unknown = null;
  try { body = await req.json(); } catch { /* handled as invalid below */ }

  const res = await acceptNotifier(store, body, Deno.env.get("UPSTOX_API_KEY"),
    (token) => new UpstoxClient(token).profile());

  const bot = Deno.env.get("TELEGRAM_BOT_TOKEN"), chat = Deno.env.get("TELEGRAM_CHAT_ID");
  const app = await store.app();
  if (res.accepted) {
    const e = istParts(res.expires!);
    await sendTelegram(bot, chat, `✅ Upstox approved from your phone. Token valid until ${e.date} ${e.hhmm} IST.`, app.dashboard_url);
    return reply({ status: "ok" });
  }
  if (res.hadPending) await sendTelegram(bot, chat, `⚠️ An Upstox token delivery was ignored (${res.reason}). If you just approved a request, log in from the dashboard instead.`, app.dashboard_url);
  return reply({ status: "ignored" });
});
