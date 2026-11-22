// Telegram alerts. Never throws: an alert failure must not break a job.
export async function sendTelegram(botToken: string | undefined, chatId: string | undefined, text: string): Promise<boolean> {
  if (!botToken || !chatId) {
    console.warn("Telegram not configured; message not sent:", text.slice(0, 200));
    return false;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (!r.ok) console.error("Telegram send failed:", r.status, (await r.text()).slice(0, 200));
    return r.ok;
  } catch (e) {
    console.error("Telegram send failed:", (e as Error).message);
    return false;
  }
}
