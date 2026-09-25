// Inbox Agent — Gmail access for ryan@lrghomes.com via the service account's
// domain-wide delegation (gmail.modify is the only Gmail scope on the grant;
// it covers read + label). Same JWT pattern as scripts/campaign-gmail.mjs.
import { google } from "googleapis"
import { MAILBOX, warn } from "./env.mjs"

const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]

export async function gmailClient(mailbox = MAILBOX) {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!keyJson) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set")
  const credentials = JSON.parse(keyJson)
  const auth = new google.auth.JWT({ email: credentials.client_email, key: credentials.private_key, scopes: GMAIL_SCOPES, subject: mailbox })
  await auth.authorize()
  return google.gmail({ version: "v1", auth })
}

/** All message ids matching `q` (paginated), newest first as Gmail returns them. */
export async function listMessageIds(gmail, q, max = 200) {
  const ids = []
  let pageToken
  do {
    const { data } = await gmail.users.messages.list({ userId: "me", q, maxResults: Math.min(100, max - ids.length), pageToken })
    for (const m of data.messages || []) ids.push(m.id)
    pageToken = data.nextPageToken || undefined
  } while (pageToken && ids.length < max)
  return ids
}

function header(headers, name) {
  const h = (headers || []).find((x) => x.name?.toLowerCase() === name.toLowerCase())
  return h?.value || ""
}
function b64(data) {
  if (!data) return ""
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8")
}
export function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
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
export function parseAddress(s) {
  const m = /<([^>]+)>/.exec(s || "")
  const email = (m ? m[1] : s || "").trim().toLowerCase()
  const name = m ? (s || "").slice(0, m.index).replace(/["']/g, "").trim() : ""
  return { email, name }
}

/** Walk the MIME tree: text (plain preferred, html fallback) + attachment parts. */
function walk(part, acc) {
  if (!part) return
  const mime = part.mimeType || ""
  const filename = part.filename || ""
  const attId = part.body?.attachmentId
  if (filename && attId) {
    const disposition = header(part.headers, "Content-Disposition")
    const contentId = header(part.headers, "Content-ID")
    acc.attachments.push({
      partId: part.partId,
      attachmentId: attId,
      filename,
      mime,
      size: part.body?.size || 0,
      inline: /^inline/i.test(disposition) || !!contentId,
    })
  } else if (mime === "text/plain" && part.body?.data && !acc.plain) {
    acc.plain = b64(part.body.data)
  } else if (mime === "text/html" && part.body?.data && !acc.html) {
    acc.html = b64(part.body.data)
  }
  for (const p of part.parts || []) walk(p, acc)
}

export async function getMessage(gmail, id) {
  const { data } = await gmail.users.messages.get({ userId: "me", id, format: "full" })
  const headers = data.payload?.headers || []
  const acc = { plain: "", html: "", attachments: [] }
  walk(data.payload, acc)
  const from = parseAddress(header(headers, "From"))
  const text = (acc.plain || htmlToText(acc.html)).trim()
  return {
    id: data.id,
    threadId: data.threadId,
    labelIds: data.labelIds || [],
    internalDate: data.internalDate ? new Date(Number(data.internalDate)).toISOString() : null,
    from,
    to: header(headers, "To"),
    cc: header(headers, "Cc"),
    subject: header(headers, "Subject"),
    messageId: header(headers, "Message-ID"),
    inReplyTo: header(headers, "In-Reply-To"),
    snippet: data.snippet || "",
    text,
    attachments: acc.attachments,
  }
}

export async function getAttachmentBytes(gmail, messageId, attachmentId) {
  const { data } = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId })
  return Buffer.from(String(data.data || "").replace(/-/g, "+").replace(/_/g, "/"), "base64")
}

const labelCache = new Map()
export async function ensureLabel(gmail, name) {
  if (labelCache.has(name)) return labelCache.get(name)
  const { data } = await gmail.users.labels.list({ userId: "me" })
  const found = (data.labels || []).find((l) => l.name === name)
  if (found) {
    labelCache.set(name, found.id)
    return found.id
  }
  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
  })
  labelCache.set(name, created.data.id)
  return created.data.id
}

export async function addLabel(gmail, messageId, labelName) {
  try {
    const labelId = await ensureLabel(gmail, labelName)
    await gmail.users.messages.modify({ userId: "me", id: messageId, requestBody: { addLabelIds: [labelId] } })
  } catch (e) {
    warn(`label ${labelName} on ${messageId} failed:`, e?.response?.data?.error?.message || e.message)
  }
}

/** Thread ids Ryan replied on recently (for closing open loops). */
export async function sentThreadsSince(gmail, days = 3) {
  const ids = await listMessageIds(gmail, `in:sent newer_than:${days}d`, 300)
  const map = new Map() // threadId → latest sent internalDate ISO
  for (const id of ids) {
    const { data } = await gmail.users.messages.get({ userId: "me", id, format: "minimal" })
    const when = data.internalDate ? new Date(Number(data.internalDate)).toISOString() : null
    const prev = map.get(data.threadId)
    if (!prev || (when && when > prev)) map.set(data.threadId, when)
  }
  return map
}
