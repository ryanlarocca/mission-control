import type { gmail_v1 } from "googleapis"
import type { SupabaseClient } from "@supabase/supabase-js"
import { getGmailClient, getLeadsClient, sendTelegramAlert } from "@/lib/leads"
import { addSuppression } from "@/lib/suppression"

// info@lrghomes.com inbox pipeline for the agent email-drip campaign
// (Phases 4 + 5a of briefs/EMAIL_DRIP_CAMPAIGN_2026-07-17.md).
//
// info@ is Ryan's PRIMARY business mailbox — the campaign shares it. The
// privacy rule is absolute: a message must match the campaign (bounce of a
// campaign send, reply on a campaign thread, or sender in
// campaign_contacts) BEFORE any content is logged, stored, or sent to an
// AI. Non-matches are skipped with only the Gmail message id logged.
//
// Handled here:
//   bounces      → DSN parse; hard bounce (5.x.x) marks the contact
//                  'bounced'; two soft bounces (4.x.x) escalate to hard.
//   unsubscribes → "remove"-style replies auto-add master suppression
//                  (channel 'email'), mark 'unsubscribed', cancel queued
//                  sends. Telegram FYI — nothing for Ryan to do.
//   replies      → contact marked 'replied' (drip pauses), timeline event,
//                  queued sends cancelled, immediate Telegram alert
//                  (locked decision: every reply alerts, from day one).

export const CAMPAIGN_INBOX = "info@lrghomes.com"

const BOUNCE_SENDER_RE = /mailer-daemon@|postmaster@/i
const BOUNCE_SUBJECT_RE = /delivery status notification|undeliverable|delivery incomplete|failure notice|returned mail/i
const HARD_DSN_RE = /\b5\.\d+\.\d+\b|\b55[0-9]\b|does not exist|no such user|user unknown|address not found|account.{0,20}disabled/i
const SOFT_DSN_RE = /\b4\.\d+\.\d+\b|\b4[25][0-9]\b|mailbox full|over quota|temporar/i
const UNSUB_RE = /unsubscribe|take me off|remove me|opt me out|opt out|stop (emailing|sending|contacting)/i
// Bare opt-out as a whole message OR as the first line above a signature
// (the Katie-Piro case, 2026-07-20: "Remove" + sig block + Outlook quote).
const UNSUB_SHORT_RE = /^(please\s+)?(remove(d)?( me)?|unsubscribe|stop|no thanks?|opt (me )?out)[.!\s]*$/i
// Auto-replies must not pause the drip (out-of-office) — and dead-mailbox
// auto-replies are effectively bounces.
const AUTO_REPLY_RE = /out of (the )?office|away from (the )?office|automated (response|reply)|auto-?reply|on vacation|on leave until|limited access to email/i
const DEAD_MAILBOX_RE = /no longer (in use|monitored|active)|(mailbox|address|email) (is )?(closed|deactivated|discontinued)/i

interface CampaignContact {
  id: string
  name: string | null
  email: string | null
  alt_emails: string[]
  status: string
  touch_number: number
  soft_bounces: number
  gmail_thread_id: string | null
}

function getHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  const lower = name.toLowerCase()
  for (const h of headers ?? []) {
    if ((h.name || "").toLowerCase() === lower) return h.value || ""
  }
  return ""
}

function decodeBody(data: string | null | undefined): string {
  if (!data) return ""
  try {
    return Buffer.from(data, "base64").toString("utf-8")
  } catch {
    return ""
  }
}

/** Walk MIME parts for text/plain (falls back to any part with a body). */
function extractText(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return ""
  const chunks: string[] = []
  const walk = (part: gmail_v1.Schema$MessagePart, plainOnly: boolean) => {
    const mime = part.mimeType || ""
    if (part.body?.data && (!plainOnly || mime === "text/plain" || mime.startsWith("message/"))) {
      chunks.push(decodeBody(part.body.data))
    }
    for (const p of part.parts ?? []) walk(p, plainOnly)
  }
  walk(payload, true)
  if (chunks.length === 0) walk(payload, false)
  return chunks.join("\n")
}

function parseSenderEmail(fromHeader: string): string {
  const angled = /<([^>]+)>/.exec(fromHeader)
  const raw = (angled ? angled[1] : fromHeader).trim().toLowerCase()
  return raw.includes("@") ? raw : ""
}

/** Strip quoted-reply tails so the unsubscribe check sees only new text.
 * Handles Gmail ("On ... wrote:"), ">"-prefixed, and Outlook styles
 * ("________...", "-----Original Message-----", a bare "From: ..." header). */
function stripQuoted(body: string): string {
  const lines = body.split(/\r?\n/)
  const out: string[] = []
  for (const line of lines) {
    const t = line.trim()
    if (
      /^On .{5,80} wrote:$/.test(t) ||
      line.startsWith(">") ||
      /^_{8,}$/.test(t) ||
      /^-{3,}\s*Original Message\s*-{3,}$/i.test(t) ||
      /^From:\s.+@.+/i.test(t)
    ) break
    out.push(line)
  }
  return out.join("\n").trim()
}

async function alreadyProcessed(sb: SupabaseClient, gmailId: string): Promise<boolean> {
  const { data } = await sb
    .from("campaign_events")
    .select("id")
    .filter("raw->>gmail_id", "eq", gmailId)
    .limit(1)
  return (data ?? []).length > 0
}

async function findContactByEmail(sb: SupabaseClient, email: string): Promise<CampaignContact | null> {
  const { data } = await sb
    .from("campaign_contacts")
    .select("id, name, email, alt_emails, status, touch_number, soft_bounces, gmail_thread_id")
    .or(`email.eq.${email},alt_emails.cs.{${email}}`)
    .limit(1)
  return (data?.[0] as CampaignContact) ?? null
}

async function findContactByThread(sb: SupabaseClient, threadId: string): Promise<CampaignContact | null> {
  const { data } = await sb
    .from("campaign_contacts")
    .select("id, name, email, alt_emails, status, touch_number, soft_bounces, gmail_thread_id")
    .eq("gmail_thread_id", threadId)
    .limit(1)
  if (data?.[0]) return data[0] as CampaignContact
  const { data: send } = await sb
    .from("campaign_sends")
    .select("contact_id")
    .eq("gmail_thread_id", threadId)
    .limit(1)
  if (!send?.[0]) return null
  const { data: byId } = await sb
    .from("campaign_contacts")
    .select("id, name, email, alt_emails, status, touch_number, soft_bounces, gmail_thread_id")
    .eq("id", send[0].contact_id)
    .limit(1)
  return (byId?.[0] as CampaignContact) ?? null
}

async function cancelQueuedSends(sb: SupabaseClient, contactId: string, why: string): Promise<void> {
  await sb
    .from("campaign_sends")
    .update({ status: "skipped", error: why })
    .eq("contact_id", contactId)
    .in("status", ["draft", "approved"])
}

async function handleBounce(
  sb: SupabaseClient,
  args: { gmailId: string; subject: string; body: string; headers: gmail_v1.Schema$MessagePartHeader[] | undefined }
): Promise<void> {
  const { gmailId, subject, body, headers } = args
  // Failed recipient: X-Failed-Recipients header, else Final-Recipient DSN
  // line, else first email in the body that isn't ours.
  let failed = getHeader(headers, "X-Failed-Recipients").toLowerCase().trim()
  if (!failed) {
    const finalRec = /Final-Recipient:\s*rfc822;\s*([^\s;]+@[^\s;]+)/i.exec(body)
    if (finalRec) failed = finalRec[1].toLowerCase()
  }
  if (!failed) {
    const anyEmail = body.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi) ?? []
    failed = (anyEmail.map((e) => e.toLowerCase()).find((e) => !e.endsWith("@lrghomes.com") && !e.startsWith("mailer-daemon")) ?? "")
  }
  if (!failed) {
    console.warn(`[campaign-inbox] bounce ${gmailId}: could not extract failed recipient`)
    return
  }
  const contact = await findContactByEmail(sb, failed)
  if (!contact) {
    // Bounce for something that isn't a campaign send (Ryan's own mail) — not ours.
    console.log(`[campaign-inbox] bounce ${gmailId} for non-campaign address — skipping`)
    return
  }

  const probe = `${subject}\n${body}`
  const hard = HARD_DSN_RE.test(probe) || !SOFT_DSN_RE.test(probe) // unclassifiable → treat hard (safe: stop emailing)
  const nowIso = new Date().toISOString()
  if (hard || contact.soft_bounces + 1 >= 2) {
    await sb
      .from("campaign_contacts")
      .update({ status: "bounced", next_touch_at: null, updated_at: nowIso })
      .eq("id", contact.id)
    await cancelQueuedSends(sb, contact.id, "hard bounce")
  } else {
    await sb
      .from("campaign_contacts")
      .update({ soft_bounces: contact.soft_bounces + 1, updated_at: nowIso })
      .eq("id", contact.id)
  }
  await sb.from("campaign_events").insert({
    contact_id: contact.id,
    kind: "bounce",
    body: `${hard ? "hard" : "soft"} bounce for ${failed}`,
    raw: { gmail_id: gmailId, failed_recipient: failed, hard },
  })
  // No Telegram for bounces (2026-07-21): 18 bounce pings buried Asha's
  // reply alert on day one. Bounce handling is fully automated; counts are
  // on /email-campaign. Telegram stays signal-only: replies, texts, calls,
  // voicemails, unsubscribes.
}

async function handleContactMessage(
  sb: SupabaseClient,
  contact: CampaignContact,
  args: { gmailId: string; threadId: string | null; subject: string; body: string }
): Promise<void> {
  const { gmailId, threadId, subject, body } = args
  const fresh = stripQuoted(body)
  const nowIso = new Date().toISOString()

  const firstLine = fresh.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ""
  const isUnsub =
    UNSUB_SHORT_RE.test(fresh) || UNSUB_SHORT_RE.test(firstLine) || UNSUB_RE.test(fresh.slice(0, 400))
  if (isUnsub) {
    await addSuppression(sb, {
      email: contact.email,
      name: contact.name,
      reason: `replied "${fresh.slice(0, 80)}"`,
      source: "email_unsubscribe",
      source_ref: `campaign_contact:${contact.id}`,
      channel: "email",
      audience: "agent",
    })
    await sb
      .from("campaign_contacts")
      .update({ status: "unsubscribed", next_touch_at: null, updated_at: nowIso })
      .eq("id", contact.id)
    await cancelQueuedSends(sb, contact.id, "unsubscribed")
    await sb.from("campaign_events").insert({
      contact_id: contact.id,
      kind: "unsubscribe",
      body: fresh.slice(0, 500),
      raw: { gmail_id: gmailId, thread_id: threadId },
    })
    await sendTelegramAlert(`🚫 Campaign unsubscribe — <b>${contact.name ?? contact.email}</b> ("${fresh.slice(0, 60)}") — handled automatically, drip stopped`)
    return
  }

  // Dead-mailbox auto-responder ("this address is no longer in use") —
  // treat like a bounce: bad_email, stop emailing, FYI alert.
  if (DEAD_MAILBOX_RE.test(fresh)) {
    await sb
      .from("campaign_contacts")
      .update({ status: "bad_email", next_touch_at: null, updated_at: nowIso })
      .eq("id", contact.id)
    await cancelQueuedSends(sb, contact.id, "dead-mailbox auto-reply")
    await sb.from("campaign_events").insert({
      contact_id: contact.id,
      kind: "email_reply",
      body: fresh.slice(0, 500),
      triage: "dead_mailbox",
      raw: { gmail_id: gmailId, thread_id: threadId },
    })
    await sendTelegramAlert(`📪 Campaign: ${contact.name ?? contact.email} auto-replied that the mailbox is dead — marked bad_email`)
    return
  }

  // Out-of-office: log it, but do NOT pause the drip and do NOT wake Ryan —
  // the locked design says auto-replies are ignored.
  if (AUTO_REPLY_RE.test(fresh.slice(0, 300))) {
    await sb.from("campaign_events").insert({
      contact_id: contact.id,
      kind: "email_reply",
      body: fresh.slice(0, 500),
      triage: "auto_reply",
      raw: { gmail_id: gmailId, thread_id: threadId },
    })
    return
  }

  // Genuine reply: log + alert Ryan immediately. Ryan 2026-07-20: replies
  // do NOT pause the drip (next touch is ~2 weeks out; he curates manually
  // from the alerts). Only bounce/unsubscribe/removal stop the cadence.
  await sb.from("campaign_events").insert({
    contact_id: contact.id,
    kind: "email_reply",
    body: fresh.slice(0, 2000) || subject,
    raw: { gmail_id: gmailId, thread_id: threadId, subject },
  })
  const snippet = (fresh || subject).slice(0, 220)
  await sendTelegramAlert(
    `✉️ <b>AGENT REPLY</b> — <b>${contact.name ?? contact.email}</b> (after T${contact.touch_number})\n"${snippet}"\n\nDrip continues as scheduled. Reply from Gmail or /email-campaign.`
  )
}

/**
 * Process a Gmail Pub/Sub notification for info@. Scans the recent inbox
 * (same recent-window pattern the lead watcher uses), classifies each
 * message, and drops everything that isn't campaign-related before any
 * content handling.
 */
export async function processCampaignInbox(): Promise<void> {
  const sb = getLeadsClient()
  const gmail = getGmailClient(CAMPAIGN_INBOX)

  let ids: string[] = []
  try {
    const { data } = await gmail.users.messages.list({
      userId: "me",
      q: "in:inbox newer_than:1h",
      maxResults: 25,
    })
    ids = (data.messages ?? []).map((m) => m.id ?? "").filter(Boolean)
  } catch (e) {
    console.error("[campaign-inbox] messages.list failed:", e)
    return
  }

  for (const gmailId of ids) {
    try {
      if (await alreadyProcessed(sb, gmailId)) continue

      const { data: message } = await gmail.users.messages.get({ userId: "me", id: gmailId, format: "full" })
      const headers = message.payload?.headers
      const from = getHeader(headers, "From")
      const subject = getHeader(headers, "Subject")
      const sender = parseSenderEmail(from)
      const threadId = message.threadId ?? null

      if (!sender || sender.endsWith("@lrghomes.com")) continue

      const isBounce = BOUNCE_SENDER_RE.test(sender) || BOUNCE_SUBJECT_RE.test(subject)
      if (isBounce) {
        const body = extractText(message.payload)
        await handleBounce(sb, { gmailId, subject, body, headers })
        continue
      }

      // Campaign match: thread first (covers reply-from-a-different-address),
      // sender-email fallback. No match → skip, content untouched.
      let contact = threadId ? await findContactByThread(sb, threadId) : null
      if (!contact) contact = await findContactByEmail(sb, sender)
      if (!contact) {
        console.log(`[campaign-inbox] ${gmailId}: not campaign-related — skipping`)
        continue
      }
      const body = extractText(message.payload)
      await handleContactMessage(sb, contact, { gmailId, threadId, subject, body })
    } catch (e) {
      console.error(`[campaign-inbox] failed on ${gmailId}:`, e)
      await sendTelegramAlert(`⚠️ Campaign inbox processing failed on a message — check Vercel logs (${gmailId})`)
    }
  }
}
