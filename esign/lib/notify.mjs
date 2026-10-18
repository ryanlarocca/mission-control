// Telegram notices to Ryan via the Marketing bot. Never throws.
import { env } from "./env.mjs"

export async function notify(text) {
  const token = env.telegramToken()
  const chatId = env.telegramChatId()
  if (process.env.ESIGN_QUIET === "1") { console.log("[esign] QUIET notice:", text.replace(/<[^>]+>/g, "")); return true }
  if (!token || !chatId) {
    console.warn("[esign] telegram not configured; notice:", text.replace(/<[^>]+>/g, ""))
    return false
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    })
    const j = await res.json().catch(() => null)
    if (!j?.ok) {
      // HTML rejected → plain text.
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: text.replace(/<[^>]+>/g, ""), disable_web_page_preview: true }),
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
