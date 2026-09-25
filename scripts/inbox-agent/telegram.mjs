// Inbox Agent — Telegram sender (Marketing bot, same token fallback as every
// other alert). HTML parse mode with a plain-text retry, inline keyboards,
// and document upload for the rules file.
import { warn } from "./env.mjs"

function token() {
  return process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
}
function chatId() {
  return process.env.TELEGRAM_CHAT_ID
}

export function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

async function call(method, body) {
  const t = token()
  if (!t || !chatId()) {
    warn("telegram not configured (CAMPAIGN_BOT_TOKEN/TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)")
    return null
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${t}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId(), ...body }),
    })
    const json = await res.json()
    if (!json.ok) warn(`telegram ${method} rejected:`, json.description)
    return json
  } catch (e) {
    warn(`telegram ${method} failed:`, e.message)
    return null
  }
}

/** rows = [[{text,data}], ...]. Returns message_id or null. */
export async function tgSend(text, { rows = [], replyTo = null, html = true, dryRun = false } = {}) {
  if (dryRun) {
    console.log("---- TELEGRAM (dry run) ----\n" + text + (rows.length ? "\nbuttons: " + JSON.stringify(rows) : ""))
    return null
  }
  const reply_markup = rows.length ? { inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data }))) } : undefined
  const base = { text: text.slice(0, 4000), reply_markup, disable_web_page_preview: true }
  if (replyTo) Object.assign(base, { reply_to_message_id: replyTo, allow_sending_without_reply: true })
  let out = await call("sendMessage", html ? { ...base, parse_mode: "HTML" } : base)
  if (html && out && !out.ok) {
    out = await call("sendMessage", { ...base, text: base.text.replace(/<[^>]+>/g, "") })
  }
  return out?.result?.message_id ?? null
}

export async function tgClearButtons(messageId) {
  if (!messageId) return
  await call("editMessageReplyMarkup", { message_id: messageId, reply_markup: { inline_keyboard: [] } })
}

/** Upload a text/markdown file. Returns message_id or null. */
export async function tgSendDocument(filename, content, caption, { rows = [], dryRun = false } = {}) {
  if (dryRun) {
    console.log(`---- TELEGRAM DOCUMENT (dry run) ${filename} ----\n${caption}\n${content.slice(0, 2000)}…`)
    return null
  }
  const t = token()
  if (!t || !chatId()) return null
  const form = new FormData()
  form.append("chat_id", chatId())
  form.append("document", new Blob([content], { type: "text/markdown" }), filename)
  if (caption) form.append("caption", caption.slice(0, 1000))
  if (rows.length) {
    form.append("reply_markup", JSON.stringify({ inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data }))) }))
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${t}/sendDocument`, { method: "POST", body: form })
    const json = await res.json()
    if (!json.ok) warn("telegram sendDocument rejected:", json.description)
    return json?.result?.message_id ?? null
  } catch (e) {
    warn("telegram sendDocument failed:", e.message)
    return null
  }
}
