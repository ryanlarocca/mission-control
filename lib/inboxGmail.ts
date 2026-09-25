import type { gmail_v1 } from "googleapis"
import { getGmailClient } from "@/lib/leads"

// Inbox Agent — Gmail reads from Vercel (typed Telegram commands and
// questions need the thread right now, not on the worker's next pass).
// Same DWD client as the lead-ingest route; gmail.modify covers read.

export const INBOX_MAILBOX = process.env.INBOX_AGENT_MAILBOX || "ryan@lrghomes.com"

export interface InboxMessage {
  id: string
  threadId: string
  date: string | null
  from: string
  to: string
  subject: string
  text: string
  attachments: Array<{ attachmentId: string; filename: string; mime: string; size: number }>
  link: string
}

function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => (h.name || "").toLowerCase() === name.toLowerCase())?.value || ""
}
function b64(data?: string | null): string {
  if (!data) return ""
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8")
}
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
function walk(part: gmail_v1.Schema$MessagePart | undefined, acc: { plain: string; html: string; attachments: InboxMessage["attachments"] }) {
  if (!part) return
  const mime = part.mimeType || ""
  if (part.filename && part.body?.attachmentId) {
    const inline = /^inline/i.test(header(part.headers, "Content-Disposition")) || !!header(part.headers, "Content-ID")
    if (!inline || !/^image\//.test(mime)) acc.attachments.push({ attachmentId: part.body.attachmentId, filename: part.filename, mime, size: part.body.size || 0 })
  } else if (mime === "text/plain" && part.body?.data && !acc.plain) acc.plain = b64(part.body.data)
  else if (mime === "text/html" && part.body?.data && !acc.html) acc.html = b64(part.body.data)
  for (const p of part.parts || []) walk(p, acc)
}
function toMessage(data: gmail_v1.Schema$Message): InboxMessage {
  const headers = data.payload?.headers || []
  const acc = { plain: "", html: "", attachments: [] as InboxMessage["attachments"] }
  walk(data.payload, acc)
  return {
    id: data.id || "",
    threadId: data.threadId || "",
    date: data.internalDate ? new Date(Number(data.internalDate)).toISOString() : null,
    from: header(headers, "From"),
    to: header(headers, "To"),
    subject: header(headers, "Subject"),
    text: (acc.plain || htmlToText(acc.html)).trim(),
    attachments: acc.attachments,
    link: `https://mail.google.com/mail/u/0/#all/${data.id}`,
  }
}

export async function fetchInboxMessage(id: string): Promise<InboxMessage> {
  const gmail = getGmailClient(INBOX_MAILBOX)
  const { data } = await gmail.users.messages.get({ userId: "me", id, format: "full" })
  return toMessage(data)
}

export async function fetchInboxThread(threadId: string): Promise<InboxMessage[]> {
  const gmail = getGmailClient(INBOX_MAILBOX)
  const { data } = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" })
  return (data.messages || []).map(toMessage)
}

export async function fetchAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
  const gmail = getGmailClient(INBOX_MAILBOX)
  const { data } = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId })
  return Buffer.from(String(data.data || "").replace(/-/g, "+").replace(/_/g, "/"), "base64")
}

/** Gmail search → light rows (subject/from/date/snippet/link), newest first. */
export async function searchInbox(q: string, max = 8): Promise<Array<{ id: string; threadId: string; date: string | null; from: string; subject: string; snippet: string; attachments: string[]; link: string }>> {
  const gmail = getGmailClient(INBOX_MAILBOX)
  const { data } = await gmail.users.messages.list({ userId: "me", q, maxResults: max })
  const out = []
  for (const m of data.messages || []) {
    const { data: full } = await gmail.users.messages.get({ userId: "me", id: m.id!, format: "full" })
    const msg = toMessage(full)
    out.push({ id: msg.id, threadId: msg.threadId, date: msg.date, from: msg.from, subject: msg.subject, snippet: (full.snippet || "").slice(0, 140), attachments: msg.attachments.map((a) => a.filename), link: msg.link })
  }
  return out
}

/** Thread rendered for a model: oldest first, quoted replies stripped, capped. */
export function renderThread(msgs: InboxMessage[], maxChars = 14000): string {
  const parts = msgs
    .slice()
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""))
    .map((m) => {
      const body = m.text
        .split(/\n(?=On .{5,80} wrote:|From: |-----Original Message-----|--- original message ---)/i)[0]
        .replace(/^>.*$/gm, "")
        .trim()
      return `--- ${m.date?.slice(0, 16) || "?"} · ${m.from}${m.attachments.length ? ` · attachments: ${m.attachments.map((a) => a.filename).join(", ")}` : ""}\n${body.slice(0, 4000)}`
    })
  let out = parts.join("\n\n")
  if (out.length > maxChars) out = "…" + out.slice(-maxChars)
  return out
}
