#!/usr/bin/env node
// Re-post the attachments of one agent reply to the campaign Telegram chat.
//   node --env-file=.env.local scripts/campaign-forward-attachments.mjs <mailbox> <gmailMessageId> [caption]
// Ops tool for replies that were alerted before attachment forwarding
// existed (2026-10-02: Grail Nitsch's 707 Hyde St flyer). The live path is
// lib/campaignInbox.ts forwardAttachments(); this mirrors it with the engine's
// Gmail client so it runs on the Mac mini without a Next.js runtime.
import { gmailClientFor } from "./campaign-gmail.mjs"

const [mailbox, gmailId, captionArg] = process.argv.slice(2)
if (!mailbox || !gmailId) { console.error("usage: campaign-forward-attachments.mjs <mailbox> <gmailMessageId> [caption]"); process.exit(2) }
const token = process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
const chat = process.env.TELEGRAM_CHAT_ID
if (!token || !chat) { console.error("CAMPAIGN_BOT_TOKEN / TELEGRAM_CHAT_ID missing"); process.exit(2) }

const gmail = await gmailClientFor(mailbox)
const { data: msg } = await gmail.users.messages.get({ userId: "me", id: gmailId, format: "full" })
const from = (msg.payload?.headers ?? []).find((h) => h.name?.toLowerCase() === "from")?.value ?? mailbox
const files = []
const walk = (p) => { if (!p) return; if (p.filename && p.body?.attachmentId) files.push({ filename: p.filename, mime: p.mimeType || "application/octet-stream", id: p.body.attachmentId, size: p.body.size ?? 0 }); for (const c of p.parts ?? []) walk(c) }
walk(msg.payload)
console.log(`${files.length} attachment(s) on ${gmailId} from ${from}`)
for (const f of files) {
  if (f.size > 0 && f.size < 4096 && /^image\//i.test(f.mime)) { console.log(`skip signature image ${f.filename}`); continue }
  const { data } = await gmail.users.messages.attachments.get({ userId: "me", messageId: gmailId, id: f.id })
  const bytes = Buffer.from(String(data.data ?? "").replace(/-/g, "+").replace(/_/g, "/"), "base64")
  const isImage = /^image\/(jpeg|png|gif|webp)$/i.test(f.mime) && bytes.length < 10 * 1024 * 1024
  const form = new FormData()
  form.append("chat_id", chat)
  form.append(isImage ? "photo" : "document", new Blob([new Uint8Array(bytes)], { type: f.mime }), f.filename)
  form.append("caption", (captionArg ?? `📎 ${f.filename} — from ${from.replace(/<.*>/, "").trim()}`).slice(0, 1000))
  const res = await fetch(`https://api.telegram.org/bot${token}/${isImage ? "sendPhoto" : "sendDocument"}`, { method: "POST", body: form })
  const json = await res.json()
  console.log(`${json.ok ? "✓" : "✗"} ${f.filename} (${f.mime}, ${(bytes.length / 1024).toFixed(0)} KB)${json.ok ? "" : ` — ${json.description}`}`)
}
