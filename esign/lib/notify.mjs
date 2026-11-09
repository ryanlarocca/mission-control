// Telegram notices to Ryan via the Marketing bot. Never throws.
import { env } from "./env.mjs"

/** `buttons`: [[{ text, data }]] — taps go to Mission Control's campaign-bot
 *  webhook (/api/campaign/telegram), e.g. the contract card's ↩️ Undo. */
export async function notify(text, { buttons } = {}) {
  const token = env.telegramToken()
  const chatId = env.telegramChatId()
  if (process.env.ESIGN_QUIET === "1") { console.log("[esign] QUIET notice:", text.replace(/<[^>]+>/g, "")); return true }
  if (!token || !chatId) {
    console.warn("[esign] telegram not configured; notice:", text.replace(/<[^>]+>/g, ""))
    return false
  }
  const markup = buttons?.length
    ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } }
    : {}
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...markup }),
    })
    const j = await res.json().catch(() => null)
    if (!j?.ok) {
      // HTML rejected → plain text.
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: text.replace(/<[^>]+>/g, ""), disable_web_page_preview: true, ...markup }),
      })
    }
    return true
  } catch (e) {
    console.error("[esign] telegram failed:", e?.message || e)
    return false
  }
}

export function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
