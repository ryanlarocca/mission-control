import { NextResponse } from "next/server"
import { google, gmail_v1 } from "googleapis"

// Pub/Sub push ack timeout is 10s by default; Gmail history.list + message.get
// + Haiku triage + Supabase insert can blow past Vercel's 10s default. Bump it.
export const maxDuration = 30
import {
  EMAIL_CAMPAIGN_MAP,
  getEmailCampaign,
  getLeadsClient,
  sendTelegramAlert,
  triageEmailLead,
} from "@/lib/leads"

// Gmail Push → Pub/Sub → this route. Pub/Sub HTTP push delivers an
// envelope of the form:
//   { message: { data: "<base64>", messageId, publishTime, ... }, subscription }
// where `data` is a base64-encoded JSON blob `{ emailAddress, historyId }`
// emitted by Gmail's watch.
//
// Pub/Sub treats anything other than 2xx as failure and retries with
// backoff. We process inline (await) instead of waitUntil — observed in
// production that waitUntil silently drops the work and produces no logs,
// matching the project-wide rule "always await load-bearing writes in
// Vercel route handlers." Push subscription deadline is 10s by default;
// maxDuration=30 above gives us headroom for Gmail+Haiku+Supabase+Telegram.
//
// Auth: this endpoint is whitelisted in middleware.ts because Pub/Sub
// hits it without a session cookie. Pub/Sub itself can be configured
// with an OIDC token verifier on top — we don't gate on that here so
// the script can wire it up incrementally.

interface PubSubEnvelope {
  message?: {
    data?: string
    messageId?: string
    publishTime?: string
    attributes?: Record<string, string>
  }
  subscription?: string
}

interface GmailNotification {
  emailAddress?: string
  historyId?: number | string
}

// Direct POST from Apps Script — simpler than Pub/Sub, no org-policy issues.
// Payload: { secret, mailbox, from, subject, body, date }
interface AppsScriptPayload {
  secret?: string
  mailbox?: string
  from?: string
  subject?: string
  body?: string
  date?: string
}

export async function POST(request: Request) {
  let rawBody: any
  try {
    rawBody = await request.json()
  } catch (e) {
    console.error("[email] Failed to parse request body:", e)
    return NextResponse.json({ ok: true })
  }

  // Route 1: Apps Script direct POST (has `mailbox` + `secret` fields)
  if (rawBody?.mailbox && rawBody?.secret) {
    return handleAppsScript(rawBody as AppsScriptPayload)
  }

  // Route 2: Pub/Sub envelope (legacy — kept for future use)
  const envelope = rawBody as PubSubEnvelope
  const dataB64 = envelope?.message?.data
  if (!dataB64) {
    console.warn("[email] Envelope missing message.data; ignoring")
    return NextResponse.json({ ok: true })
  }

  let notification: GmailNotification
  try {
    const decoded = Buffer.from(dataB64, "base64").toString("utf-8")
    notification = JSON.parse(decoded) as GmailNotification
  } catch (e) {
    console.error("[email] Failed to decode notification data:", e)
    return NextResponse.json({ ok: true })
  }

  const emailAddress = (notification.emailAddress || "").toLowerCase()
  const historyId = notification.historyId
  if (!emailAddress || !historyId) {
    console.warn(`[email] Notification missing fields — emailAddress:${!!emailAddress} historyId:${!!historyId}`)
    return NextResponse.json({ ok: true })
  }

  if (!EMAIL_CAMPAIGN_MAP[emailAddress]) {
    console.warn(`[email] Notification for unmapped address: ${emailAddress}`)
    return NextResponse.json({ ok: true })
  }

  const campaign = getEmailCampaign(emailAddress)
  console.log(`[email] Pub/Sub notification — ${emailAddress} (${campaign.source}) historyId:${historyId}`)

  await processEmailNotification({ emailAddress, historyId: String(historyId), campaign })
  return NextResponse.json({ ok: true })
}

async function handleAppsScript(payload: AppsScriptPayload): Promise<NextResponse> {
  const expectedSecret = process.env.EMAIL_WEBHOOK_SECRET
  if (!expectedSecret || payload.secret !== expectedSecret) {
    console.warn("[email] Apps Script request with invalid secret")
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }

  const mailbox = (payload.mailbox || "").toLowerCase()
  if (!EMAIL_CAMPAIGN_MAP[mailbox]) {
    console.warn(`[email] Apps Script payload for unmapped mailbox: ${mailbox}`)
    return NextResponse.json({ ok: true })
  }

  const campaign = getEmailCampaign(mailbox)
  const fromRaw = payload.from || ""
  const subject = payload.subject || "(no subject)"
  const bodyText = stripQuoted(payload.body || "")

  const { name, email: senderEmail } = parseFromHeader(fromRaw)
  if (!senderEmail) {
    console.warn(`[email] Apps Script payload missing sender email: ${fromRaw}`)
    return NextResponse.json({ ok: true })
  }

  // Don't ingest mail from the mailbox owner
  if (senderEmail === mailbox) {
    console.log(`[email] Skipping — sender is mailbox owner`)
    return NextResponse.json({ ok: true })
  }

  const phone = extractPhoneFromText(bodyText)
  const messageText = `${subject}\n\n${bodyText}`.slice(0, 2000)

  // Dedup: check for same sender + similar message in the last hour
  const sb = getLeadsClient()
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { data: existing } = await sb
    .from("leads")
    .select("id, message")
    .eq("lead_type", "email")
    .eq("email", senderEmail)
    .gte("created_at", oneHourAgo)
    .limit(5)
  if (existing && existing.some((r) => (r.message || "").slice(0, 200) === messageText.slice(0, 200))) {
    console.log(`[email] Skipping duplicate from ${senderEmail}`)
    return NextResponse.json({ ok: true, deduplicated: true })
  }

  // Haiku triage — non-fatal
  const triage = await triageEmailLead(subject, bodyText)

  const { data: inserted, error: insertErr } = await sb
    .from("leads")
    .insert({
      lead_type: "email",
      source_type: campaign.source_type,
      source: campaign.source,
      twilio_number: null,
      caller_phone: phone,
      name,
      email: senderEmail,
      message: messageText,
      ai_notes: triage?.summary ?? null,
      suggested_reply: triage?.suggestedReply ?? null,
      status: triage?.status ?? "new",
    })
    .select("id")
    .single()

  if (insertErr) {
    console.error(`[email] Insert failed:`, insertErr)
    return NextResponse.json({ ok: false, error: "insert_failed" }, { status: 500 })
  }

  console.log(`[email] Inserted email lead ${inserted?.id} from ${senderEmail} (${campaign.source})`)

  const lines = [
    "📧 New email lead",
    `[${formatCampaignLabel(campaign.source)}]`,
    `👤 ${name || "(no name)"}`,
    `📧 ${senderEmail}`,
  ]
  if (phone) lines.push(`📞 ${formatPhoneForAlert(phone)}`)
  if (triage) {
    lines.push(`🤖 AI: <b>${triage.status.toUpperCase()}</b> — ${escapeHtml(triage.summary)}`)
  }
  await sendTelegramAlert(lines.join("\n"))

  return NextResponse.json({ ok: true, leadId: inserted?.id })
}

async function processEmailNotification(args: {
  emailAddress: string
  historyId: string
  campaign: { source: string; source_type: string }
}): Promise<void> {
  const { emailAddress, historyId, campaign } = args
  try {
    const gmail = getGmailClient(emailAddress)
    const messageIds = await fetchRecentInboxMessageIds(gmail)
    if (messageIds.length === 0) {
      console.log(`[email] No recent inbox messages for ${emailAddress} (notif historyId=${historyId})`)
      return
    }
    console.log(`[email] Scanning ${messageIds.length} recent message(s) for ${emailAddress}`)
    for (const messageId of messageIds) {
      try {
        await processSingleMessage({ gmail, messageId, emailAddress, campaign })
      } catch (e) {
        console.error(`[email] Failed to process message ${messageId}:`, e)
      }
    }
  } catch (e) {
    console.error("[email] Background processing threw:", e)
  }
}

async function processSingleMessage(args: {
  gmail: gmail_v1.Gmail
  messageId: string
  emailAddress: string
  campaign: { source: string; source_type: string }
}): Promise<void> {
  const { gmail, messageId, emailAddress, campaign } = args

  // Fetch the full message payload so we have headers + body.
  const { data: message } = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  })

  // Skip Gmail "CHAT" or items we don't want surfaced as leads.
  const labelIds = message.labelIds || []
  if (!labelIds.includes("INBOX")) {
    console.log(`[email] Skipping ${messageId} — not in INBOX`)
    return
  }

  const headers = message.payload?.headers
  const fromHeader = getHeader(headers, "From")
  const subject = getHeader(headers, "Subject") || "(no subject)"
  const { name, email: senderEmail } = parseFromHeader(fromHeader)
  if (!senderEmail) {
    console.warn(`[email] ${messageId} missing usable From header: ${fromHeader}`)
    return
  }
  // Don't ingest mail we sent to ourselves (e.g. Ryan testing).
  if (senderEmail === emailAddress) {
    console.log(`[email] Skipping ${messageId} — sender is mailbox owner`)
    return
  }

  const bodyText = extractPlainBody(message.payload)
  const phone = extractPhoneFromText(bodyText)

  // Idempotency: Pub/Sub redeliveries can repeat the same gmail messageId.
  // We dedupe by checking for an existing email-lead row from this sender
  // with matching message text within the last hour. If one exists, skip.
  const sb = getLeadsClient()
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { data: existing } = await sb
    .from("leads")
    .select("id, message")
    .eq("lead_type", "email")
    .eq("email", senderEmail)
    .gte("created_at", oneHourAgo)
    .limit(5)
  const messageText = `${subject}\n\n${bodyText}`.slice(0, 2000)
  if (existing && existing.some((r) => (r.message || "").slice(0, 200) === messageText.slice(0, 200))) {
    console.log(`[email] Skipping duplicate of ${messageId} from ${senderEmail}`)
    return
  }

  // Triage with Haiku — non-fatal; null leaves the lead as "new" and Ryan
  // sees it untouched.
  const triage = await triageEmailLead(subject, bodyText)

  const { data: inserted, error: insertErr } = await sb
    .from("leads")
    .insert({
      lead_type: "email",
      source_type: campaign.source_type,
      source: campaign.source,
      twilio_number: null,
      caller_phone: phone,
      name,
      email: senderEmail,
      message: messageText,
      ai_notes: triage?.summary ?? null,
      suggested_reply: triage?.suggestedReply ?? null,
      status: triage?.status ?? "new",
      // Persist the Gmail threadId so the Leads-tab card can pull the full
      // back-and-forth via /api/leads/sync-email when Ryan expands it. Falls
      // back to null when the message has no thread (rare — Gmail always
      // assigns one for inbound mail).
      gmail_thread_id: message.threadId || null,
    })
    .select("id")
    .single()
  if (insertErr) {
    console.error(`[email] Insert failed for ${messageId}:`, insertErr)
    return
  }
  console.log(`[email] Inserted email lead ${inserted?.id} from ${senderEmail} (${campaign.source})`)

  const lines = [
    "📧 New email lead",
    `[${formatCampaignLabel(campaign.source)}]`,
    `👤 ${name || "(no name)"}`,
    `📧 ${senderEmail}`,
  ]
  if (phone) lines.push(`📞 ${formatPhoneForAlert(phone)}`)
  if (triage) {
    lines.push(`🤖 AI: <b>${triage.status.toUpperCase()}</b> — ${escapeHtml(triage.summary)}`)
  }
  await sendTelegramAlert(lines.join("\n"))
}

// ─── Gmail helpers (inline; lib/leads.ts owns lead-shape helpers) ──────────

function getGmailClient(userEmail: string): gmail_v1.Gmail {
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!key) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set")
  const credentials = JSON.parse(key)
  // JWT with `subject` impersonates the mailbox owner via Google Workspace
  // domain-wide delegation. Without DWD configured on the lrghomes.com
  // tenant, Google rejects the token exchange — see scripts/setup-gmail-watch.js
  // for the manual setup steps.
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    // DWD on the lrghomes.com tenant is authorized for gmail.modify only.
    // gmail.readonly returns 401 unauthorized_client. gmail.modify includes
    // the read perms we need.
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    subject: userEmail,
  })
  return google.gmail({ version: "v1", auth })
}

// List inbox messages received within the last hour, newest first. We can't
// use Gmail's `history.list` keyed by the Pub/Sub-supplied historyId — that
// API returns events strictly *after* startHistoryId, but the notification's
// historyId is already the post-event watermark, so it always returns 0
// (verified in production). Scanning recent inbox messages every notification
// is stateless and cheap; processSingleMessage's per-sender dedup handles the
// re-delivery case.
async function fetchRecentInboxMessageIds(
  gmail: gmail_v1.Gmail
): Promise<string[]> {
  try {
    const { data } = await gmail.users.messages.list({
      userId: "me",
      q: "in:inbox newer_than:1h",
      maxResults: 25,
    })
    return (data.messages || []).map((m) => m.id || "").filter(Boolean)
  } catch (e) {
    console.error(`[email] messages.list failed:`, e)
    return []
  }
}

function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string
): string {
  if (!headers) return ""
  const lower = name.toLowerCase()
  for (const h of headers) {
    if ((h.name || "").toLowerCase() === lower) return h.value || ""
  }
  return ""
}

function parseFromHeader(value: string): { name: string | null; email: string | null } {
  if (!value) return { name: null, email: null }
  const m = value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/)
  if (m) {
    const name = m[1].trim() || null
    const email = m[2].trim().toLowerCase() || null
    return { name, email }
  }
  const bare = value.trim().toLowerCase()
  if (/^[^\s@]+@[^\s@]+$/.test(bare)) return { name: null, email: bare }
  return { name: null, email: null }
}

function extractPlainBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return ""
  const plain = findPart(payload, "text/plain")
  if (plain) return stripQuoted(decodePart(plain))
  const html = findPart(payload, "text/html")
  if (html) return stripQuoted(stripHtml(decodePart(html)))
  if (payload.body?.data) return stripQuoted(decodeBase64Url(payload.body.data))
  return ""
}

function findPart(
  part: gmail_v1.Schema$MessagePart,
  mime: string
): gmail_v1.Schema$MessagePart | null {
  if (part.mimeType === mime && part.body?.data) return part
  if (part.parts) {
    for (const child of part.parts) {
      const found = findPart(child, mime)
      if (found) return found
    }
  }
  return null
}

function decodePart(part: gmail_v1.Schema$MessagePart): string {
  if (!part.body?.data) return ""
  return decodeBase64Url(part.body.data)
}

function decodeBase64Url(data: string): string {
  try {
    const normalized = data.replace(/-/g, "+").replace(/_/g, "/")
    return Buffer.from(normalized, "base64").toString("utf-8")
  } catch {
    return ""
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim()
}

// Drop replied-to history so the AI sees only the new content.
function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  for (const line of lines) {
    if (/^On .+ wrote:\s*$/i.test(line.trim())) break
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(line.trim())) break
    if (line.trim().startsWith(">")) continue
    out.push(line)
  }
  return out.join("\n").trim()
}

function extractPhoneFromText(text: string): string | null {
  if (!text) return null
  const re = /(?:\+?1[\s.\-]*)?\(?(\d{3})\)?[\s.\-]*(\d{3})[\s.\-]*(\d{4})/
  const m = re.exec(text)
  if (!m) return null
  return `${m[1]}${m[2]}${m[3]}`
}

function formatPhoneForAlert(digits: string): string {
  if (digits.length !== 10) return digits
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"))
}

// Telegram alert label — pretty up the bare campaign code so the message
// reads "[Campaign A]" rather than "[MFM-A]".
function formatCampaignLabel(source: string): string {
  if (source === "MFM-A") return "Campaign A"
  if (source === "MFM-B") return "Campaign B"
  return source
}
