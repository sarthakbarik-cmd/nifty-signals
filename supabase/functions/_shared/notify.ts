// Telegram alerts. Never throws: an alert failure must not break a job.
type Fetch = typeof fetch;
const CAPTION_MAX = 1024; // Telegram limit for photo captions

function keyboard(buttonUrl?: string | null) {
  return buttonUrl && /^https:\/\//.test(buttonUrl)
    ? { inline_keyboard: [[{ text: "Open dashboard", url: buttonUrl }]] }
    : undefined;
}

export async function sendTelegram(
  botToken: string | undefined, chatId: string | undefined, text: string, buttonUrl?: string | null, f: Fetch = fetch,
): Promise<boolean> {
  if (!botToken || !chatId) {
    console.warn("Telegram not configured; message not sent:", text.slice(0, 200));
    return false;
  }
  try {
    const r = await f(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true, reply_markup: keyboard(buttonUrl) }),
    });
    if (!r.ok) console.error("Telegram send failed:", r.status, (await r.text()).slice(0, 200));
    return r.ok;
  } catch (e) {
    console.error("Telegram send failed:", (e as Error).message);
    return false;
  }
}

/**
 * Chart + message. Sends the PNG with the text as its caption; if there's no image or the
 * text is too long for a caption, falls back to photo + separate text (or text only).
 */
export async function sendTelegramPhoto(
  botToken: string | undefined, chatId: string | undefined, text: string, png: Uint8Array | null,
  buttonUrl?: string | null, f: Fetch = fetch,
): Promise<boolean> {
  if (!botToken || !chatId) return sendTelegram(botToken, chatId, text, buttonUrl, f);
  if (!png) return sendTelegram(botToken, chatId, text, buttonUrl, f);
  const fits = text.length <= CAPTION_MAX;
  try {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("photo", new Blob([new Uint8Array(png)], { type: "image/png" }), "nifty.png");
    if (fits) {
      form.append("caption", text);
      const kb = keyboard(buttonUrl);
      if (kb) form.append("reply_markup", JSON.stringify(kb));
    }
    const r = await f(`https://api.telegram.org/bot${botToken}/sendPhoto`, { method: "POST", body: form });
    if (!r.ok) {
      console.error("Telegram photo failed:", r.status, (await r.text()).slice(0, 200));
      return sendTelegram(botToken, chatId, text, buttonUrl, f); // never lose the message
    }
    return fits ? true : sendTelegram(botToken, chatId, text, buttonUrl, f);
  } catch (e) {
    console.error("Telegram photo failed:", (e as Error).message);
    return sendTelegram(botToken, chatId, text, buttonUrl, f);
  }
}
