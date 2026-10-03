import type { gmail_v1 } from "googleapis"
import type { SupabaseClient } from "@supabase/supabase-js"
import { getGmailClient, getLeadsClient } from "@/lib/leads"
import { sendCampaignAlert, sendCampaignDocument } from "@/lib/campaignAlerts"
import { buildEmailMime, toGmailRaw } from "@/lib/emailMime"
import { addSuppression } from "@/lib/suppression"
import { completeText, extractJsonObject, hasLlmKey, HAIKU } from "@/lib/llm"
import {
  type AgentContact,
  type CampaignContactLite,
  logInboundEmailTouch,
  markRelationshipDoNotContact,
  resolveAgentContact,
} from "@/lib/agentsLineInbound"

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
//   replies      → timeline event + inbound email touch on the agent's
//                  Relationships card (created tier B if new — 2026-10-01),
//                  AI triage (deal / interested / question / not_now /
//                  remove / retired_or_wrong_person), immediate Telegram
//                  alert. The drip NEVER pauses on a reply (Ryan 2026-07-20,
//                  reaffirmed 2026-10-01); only remove-style replies stop it
//                  — those auto-DNC (Ryan 2026-10-01: fully automatic) and
//                  get ONE bare in-thread confirmation from the same mailbox
//                  (2026-10-02: a "remove" reply is a positive engagement
//                  signal vs the spam button; answering it closes the loop).
//   attachments  → every file on a genuine reply is posted to Telegram under
//                  the reply alert (2026-10-02: Grail's 707 Hyde flyer).

// Sender migration 2026-08-06 (info@ reputation burned — Ryan's call):
// ryansvr@ is the campaign's outbound gun going forward; info@ stays
// watched for replies to pre-migration threads and rests its reputation.
// BOTH are campaign inboxes: campaign-check-first, never lead ingest.
export const CAMPAIGN_INBOX = "info@lrghomes.com"
// (The consumer-Gmail sender of 2026-08-21 is gone — retired 2026-09-01,
// removed 2026-09-06. Its 7 sends' replies land in that mailbox unwatched.)
// + the September-rebuild senders (config/campaign-senders.json): replies
// follow Reply-To (info@) but BOUNCES return to the sending mailbox, so each
// new domain's mailbox must be a campaign inbox or its bounce rate is
// invisible to the per-sender health gates. Listing them here is inert until
// a Gmail watch exists — register with
//   node scripts/add-email-mailbox.mjs ryan@lrghomesbuys.com AGENT-DRIP-BUYS
//   node scripts/add-email-mailbox.mjs ryan@lrghomesoffers.com AGENT-DRIP-OFFERS
// (--dry-run first), then deploy.
export const CAMPAIGN_INBOXES = [
  "ryansvr@lrghomes.com",
  "info@lrghomes.com",
  "ryan@lrghomesbuys.com",
  "ryan@lrghomesoffers.com",
]
// Every domain we send from — our own mail is never a reply or a bounce, and
// never the "failed recipient" of a DSN.
const OWN_DOMAINS = ["lrghomes.com", "lrghomesbuys.com", "lrghomesoffers.com"]
const isOwnAddress = (email: string): boolean => OWN_DOMAINS.some((d) => email.endsWith(`@${d}`))

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
const DEAD_MAILBOX_RE = /no longer (in use|monitored|active)|not actively monitored|does not correspond to a valid address|(mailbox|address|email) (is )?(closed|deactivated|discontinued)/i

interface CampaignContact {
  id: string
  name: string | null
  email: string | null
  alt_emails: string[]
  phone: string | null
  relationship_id: string | null
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

/** HTML email → readable plain text. Apple Mail / Outlook replies often have
 * no text/plain part at all (Michael Orlando, 2026-07-29) — without this the
 * pipeline stored and alerted raw <html> markup. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br[^>]*>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** Walk MIME parts for text/plain (falls back to any part with a body;
 * HTML fallbacks are converted to plain text, never passed through raw). */
function extractText(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return ""
  const chunks: { mime: string; text: string }[] = []
  const walk = (part: gmail_v1.Schema$MessagePart, plainOnly: boolean) => {
    const mime = part.mimeType || ""
    if (part.body?.data && (!plainOnly || mime === "text/plain" || mime.startsWith("message/"))) {
      chunks.push({ mime, text: decodeBody(part.body.data) })
    }
    for (const p of part.parts ?? []) walk(p, plainOnly)
  }
  walk(payload, true)
  if (chunks.length === 0) walk(payload, false)
  return chunks
    .map((c) => (c.mime.includes("html") || /^\s*<(!doctype|html|body|div|meta)/i.test(c.text) ? htmlToText(c.text) : c.text))
    .join("\n")
}

/** Telegram parse_mode:HTML rejects raw <, >, & — agent signatures full of
 * "<mailto:...>" killed Asha Raghupathy's alert silently (2026-07-21). Every
 * user-written string interpolated into an alert goes through this. */
function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function parseSenderEmail(fromHeader: string): string {
  const angled = /<([^>]+)>/.exec(fromHeader)
  const raw = (angled ? angled[1] : fromHeader).trim().toLowerCase()
  return raw.includes("@") ? raw : ""
}

/** Strip quoted-reply tails so the unsubscribe check (and the alert) sees
 * only new text. Handles Gmail ("On ... wrote:", "---------- Forwarded
 * message ----------"), ">"-prefixed, Outlook ("________", "-----Original
 * Message-----"), and bare header blocks ("From:", "Date:", "Sent:",
 * "Subject:", "To:"). Gmail mobile's forward of our own email (Grail,
 * 2026-10-02) arrived with the From: line mangled to a bare "<addr>" tail,
 * so the Date:/Subject: lines are cut points too, and a dangling address
 * fragment just above the cut is dropped. */
function stripQuoted(body: string): string {
  const lines = body.split(/\r?\n/)
  const out: string[] = []
  for (const line of lines) {
    const t = line.trim()
    if (
      /^On .{5,160} wrote:$/.test(t) ||
      /wrote:$/.test(t) && /^On\b|\d{4}/.test(t) ||
      line.startsWith(">") ||
      /^_{8,}$/.test(t) ||
      /^-{3,}\s*(Original Message|Forwarded message)\s*-{3,}$/i.test(t) ||
      /^(From|Sent|Date|Subject|To|Cc):\s.+/i.test(t) && (/^(From|Sent|Date):/i.test(t) ? true : /^Subject:/i.test(t) || /^(To|Cc):\s*<?[^\s]+@/i.test(t))
    ) break
    out.push(line)
  }
  while (out.length && (/^[^\s<>]*@[^\s<>]+>?$/.test(out[out.length - 1].trim()) || out[out.length - 1].trim() === "")) out.pop()
  return out.join("\n").trim()
}

/** Files on an agent's reply (anything with a filename + attachment id). */
function listAttachments(payload: gmail_v1.Schema$MessagePart | undefined): Array<{ filename: string; mime: string; attachmentId: string; size: number }> {
  const out: Array<{ filename: string; mime: string; attachmentId: string; size: number }> = []
  const walk = (part: gmail_v1.Schema$MessagePart | undefined) => {
    if (!part) return
    if (part.filename && part.body?.attachmentId) {
      out.push({ filename: part.filename, mime: part.mimeType || "application/octet-stream", attachmentId: part.body.attachmentId, size: part.body.size ?? 0 })
    }
    for (const p of part.parts ?? []) walk(p)
  }
  walk(payload)
  return out
}

/** Post every attachment on a reply to Telegram under its alert. Never
 * throws — a bad file must not lose the reply. Inline signature images
 * (tiny) are skipped. */
async function forwardAttachments(
  sb: SupabaseClient,
  gmail: gmail_v1.Gmail,
  args: { gmailId: string; payload: gmail_v1.Schema$MessagePart | undefined; who: string; replyTo: number | null }
): Promise<number> {
  let posted = 0
  for (const a of listAttachments(args.payload)) {
    if (a.size > 0 && a.size < 4096 && /^image\//i.test(a.mime)) continue // signature logos
    try {
      const { data } = await gmail.users.messages.attachments.get({ userId: "me", messageId: args.gmailId, id: a.attachmentId })
      if (!data.data) continue
      const bytes = Buffer.from(data.data.replace(/-/g, "+").replace(/_/g, "/"), "base64")
      const ok = await sendCampaignDocument(sb, { filename: a.filename, mime: a.mime, bytes }, `📎 ${a.filename} — from ${args.who}`, { replyTo: args.replyTo })
      if (ok) posted++
    } catch (e) {
      console.error(`[campaign-inbox] attachment ${a.filename} on ${args.gmailId} failed:`, e instanceof Error ? e.message : String(e))
    }
  }
  return posted
}

/**
 * One bare in-thread "you're removed" reply from the mailbox the agent wrote
 * to (Ryan 2026-10-02). No signature block, no phone, no links, no opt-out
 * line — a confirmation, not another marketing email. Once per contact.
 * Returns true when sent. Never throws.
 */
async function sendRemoveConfirmation(
  sb: SupabaseClient,
  gmail: gmail_v1.Gmail,
  contact: CampaignContact,
  args: { gmailId: string; threadId: string | null; mailbox: string; sender: string }
): Promise<boolean> {
  try {
    if (!isOwnAddress(args.mailbox)) return false
    const { data: prior } = await sb
      .from("campaign_events")
      .select("id")
      .eq("contact_id", contact.id)
      .eq("kind", "email_out")
      .filter("raw->>via", "eq", "remove_confirmation")
      .limit(1)
    if (prior?.length) return false
    const { data: orig } = await gmail.users.messages.get({ userId: "me", id: args.gmailId, format: "metadata", metadataHeaders: ["Message-ID", "References", "From", "Subject"] })
    const h = Object.fromEntries((orig.payload?.headers ?? []).map((x) => [String(x.name).toLowerCase(), x.value ?? ""]))
    const to = args.sender || contact.email || ""
    if (!to) return false
    let subject = h["subject"] || "your reply"
    if (!/^re:/i.test(subject)) subject = `Re: ${subject}`
    const first = (contact.name ?? "").trim().split(/\s+/)[0] || ""
    const body = `${first ? `Hi ${first},\n\n` : ""}Done, you're removed from my list and won't hear from me again. Sorry for the noise.\n\nRyan LaRocca`
    const mime = buildEmailMime({
      from: `Ryan LaRocca <${args.mailbox}>`,
      to,
      subject,
      body,
      extraHeaders: [...(h["message-id"] ? [`In-Reply-To: ${h["message-id"]}`] : []), ...(h["message-id"] || h["references"] ? [`References: ${[h["references"], h["message-id"]].filter(Boolean).join(" ")}`] : [])],
    })
    await gmail.users.messages.send({ userId: "me", requestBody: { raw: toGmailRaw(mime), threadId: args.threadId ?? undefined } })
    await sb.from("campaign_events").insert({
      contact_id: contact.id,
      kind: "email_out",
      body: body.slice(0, 500),
      raw: { via: "remove_confirmation", thread_id: args.threadId, mailbox: args.mailbox, in_reply_to: args.gmailId },
    })
    return true
  } catch (e) {
    console.error(`[campaign-inbox] remove confirmation to ${contact.email} failed:`, e instanceof Error ? e.message : String(e))
    await sendCampaignAlert(sb, `⚠️ Remove confirmation to ${esc(contact.name ?? contact.email ?? "")} did not send (${esc(e instanceof Error ? e.message : String(e)).slice(0, 120)}) — they are still suppressed.`)
    return false
  }
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
    .select("id, name, email, alt_emails, phone, relationship_id, status, touch_number, soft_bounces, gmail_thread_id")
    .or(`email.eq.${email},alt_emails.cs.{${email}}`)
    .limit(1)
  return (data?.[0] as CampaignContact) ?? null
}

async function findContactByThread(sb: SupabaseClient, threadId: string): Promise<CampaignContact | null> {
  const { data } = await sb
    .from("campaign_contacts")
    .select("id, name, email, alt_emails, phone, relationship_id, status, touch_number, soft_bounces, gmail_thread_id")
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
    .select("id, name, email, alt_emails, phone, relationship_id, status, touch_number, soft_bounces, gmail_thread_id")
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
  args: { gmailId: string; subject: string; body: string; headers: gmail_v1.Schema$MessagePartHeader[] | undefined; mailbox: string }
): Promise<void> {
  const { gmailId, subject, body, headers, mailbox } = args
  // Failed recipient: X-Failed-Recipients header, else Final-Recipient DSN
  // line, else first email in the body that isn't ours.
  let failed = getHeader(headers, "X-Failed-Recipients").toLowerCase().trim()
  if (!failed) {
    const finalRec = /Final-Recipient:\s*rfc822;\s*([^\s;]+@[^\s;]+)/i.exec(body)
    if (finalRec) failed = finalRec[1].toLowerCase()
  }
  if (!failed) {
    const anyEmail = body.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi) ?? []
    failed = (anyEmail.map((e) => e.toLowerCase()).find((e) => !isOwnAddress(e) && !e.startsWith("mailer-daemon")) ?? "")
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
    raw: { gmail_id: gmailId, failed_recipient: failed, hard, mailbox },
  })
  // No Telegram for bounces (2026-07-21): 18 bounce pings buried Asha's
  // reply alert on day one. Bounce handling is fully automated; counts are
  // on /email-campaign. Telegram stays signal-only: replies, texts, calls,
  // voicemails, unsubscribes.
}

async function handleContactMessage(
  sb: SupabaseClient,
  gmail: gmail_v1.Gmail,
  contact: CampaignContact,
  args: { gmailId: string; threadId: string | null; subject: string; body: string; mailbox: string; sender: string; payload: gmail_v1.Schema$MessagePart | undefined }
): Promise<void> {
  const { gmailId, threadId, subject, body, mailbox, sender, payload } = args
  const fresh = stripQuoted(body)
  const nowIso = new Date().toISOString()

  const firstLine = fresh.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ""
  const isUnsub =
    UNSUB_SHORT_RE.test(fresh) || UNSUB_SHORT_RE.test(firstLine) || UNSUB_RE.test(fresh.slice(0, 400))
  if (isUnsub) {
    // Insert-as-gatekeeper FIRST (same pattern as genuine replies): this row
    // is what alreadyProcessed() checks. Without it, the message re-processed
    // on every Pub/Sub notification for its whole 1h scan-window life and
    // re-alerted each time (Tony Ventura / Nicole Wallace loop, 2026-07-28).
    const { error: unsubEvErr } = await sb.from("campaign_events").insert({
      contact_id: contact.id,
      kind: "email_reply",
      triage: "unsubscribe",
      body: fresh.slice(0, 500),
      raw: { gmail_id: gmailId, thread_id: threadId, mailbox },
    })
    if (unsubEvErr) {
      if (/duplicate key/i.test(unsubEvErr.message)) return // concurrent notification already handled it
      throw new Error(`unsubscribe event insert: ${unsubEvErr.message}`)
    }
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
    const card = await cardForReply(sb, contact, sender, fresh, subject, false)
    if (card) await markRelationshipDoNotContact(sb, card.id, `replied "${fresh.slice(0, 80)}" to the agent email campaign`)
    const confirmed = await sendRemoveConfirmation(sb, gmail, contact, { gmailId, threadId, mailbox, sender })
    await sendCampaignAlert(sb, `🚫 Campaign unsubscribe — <b>${esc(contact.name ?? contact.email ?? "")}</b> ("${esc(fresh.slice(0, 60))}") — handled automatically, drip stopped${card ? ", card marked do-not-contact" : ""}${confirmed ? `, confirmation sent from ${esc(mailbox)}` : ""}`)
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
      raw: { gmail_id: gmailId, thread_id: threadId, mailbox },
    })
    await sendCampaignAlert(sb, `📪 Campaign: ${esc(contact.name ?? contact.email ?? "")} auto-replied that the mailbox is dead — marked bad_email`)
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
      raw: { gmail_id: gmailId, thread_id: threadId, mailbox },
    })
    return
  }

  // Genuine reply: log + alert Ryan immediately. Ryan 2026-07-20: replies
  // do NOT pause the drip (next touch is ~2 weeks out; he curates manually
  // from the alerts). Only bounce/unsubscribe/removal stop the cadence.
  const { data: ev, error: evErr } = await sb
    .from("campaign_events")
    .insert({
      contact_id: contact.id,
      kind: "email_reply",
      body: fresh.slice(0, 2000) || subject,
      raw: { gmail_id: gmailId, thread_id: threadId, subject, mailbox },
    })
    .select("id")
    .single()
  if (evErr) {
    if (/duplicate key/i.test(evErr.message)) return // concurrent notification already handled it
    throw new Error(`reply event insert: ${evErr.message}`)
  }

  // The agent lands on a Relationships card (created tier B if nobody has
  // them) and the reply becomes an inbound email touch there (2026-10-01).
  const card = await cardForReply(sb, contact, sender, fresh, subject)

  // AI triage. Remove-style replies the regex missed ("I'm retired", "not
  // working with investors", "wrong Steve") auto-DNC — Ryan 2026-10-01:
  // fully automatic, no confirm step. Everything else just tags the alert.
  const triage = await triageAgentReply({ name: contact.name, subject, body: fresh })
  if (triage && (triage.label === "remove" || triage.label === "retired_or_wrong_person")) {
    const why = triage.label === "retired_or_wrong_person" ? "retired / wrong person" : "asked to be removed"
    await addSuppression(sb, {
      email: contact.email,
      name: contact.name,
      reason: `replied "${fresh.slice(0, 80)}" (AI: ${why})`,
      source: "email_unsubscribe",
      source_ref: `campaign_contact:${contact.id}:ai`,
      channel: "email",
      audience: "agent",
    })
    await sb
      .from("campaign_contacts")
      .update({ status: "unsubscribed", next_touch_at: null, updated_at: nowIso })
      .eq("id", contact.id)
    await cancelQueuedSends(sb, contact.id, `AI triage: ${why}`)
    if (ev?.id) await sb.from("campaign_events").update({ triage: "unsubscribe", ai_summary: triage.summary }).eq("id", ev.id)
    if (card) await markRelationshipDoNotContact(sb, card.id, `${why} — replied "${fresh.slice(0, 80)}"`)
    const confirmed = await sendRemoveConfirmation(sb, gmail, contact, { gmailId, threadId, mailbox, sender })
    await sendCampaignAlert(sb,
      `🚫 Campaign auto-DNC — <b>${esc(contact.name ?? contact.email ?? "")}</b> (${why}) — "${esc(fresh.slice(0, 160))}"\n\nDrip stopped, suppression added${card ? ", card marked do-not-contact" : ""}${confirmed ? `, confirmation sent from ${esc(mailbox)}` : ""}. Reads as: ${esc(triage.summary)}`
    )
    return
  }
  if (ev?.id && triage) {
    await sb.from("campaign_events").update({ triage: triage.label, ai_summary: triage.summary }).eq("id", ev.id)
  }

  // Full message in the alert (Ryan 2026-07-29: Pamela's cut off at 220
  // chars). Cap only for Telegram's 4096-char message limit, and say so.
  // The first line keeps the exact "AGENT REPLY — <name> (after T#)" shape
  // the Telegram webhook parses for reply-to-send and draft:.
  let alertBody = (fresh || subject).trim()
  const truncated = alertBody.length > 3200
  if (truncated) alertBody = alertBody.slice(0, 3200)
  const tag = triage ? TRIAGE_TAGS[triage.label] ?? "" : ""
  const cardLine = card
    ? card.isNew
      ? `🆕 New contact — added to Relationships (Agent, tier B).`
      : `📇 On their Relationships card${card.category ? ` (${esc(card.category)}${card.tier ? ` · ${esc(card.tier)}` : ""})` : ""}.`
    : ""
  const headline = [tag && `${tag}${triage?.address ? ` — ${esc(triage.address)}` : ""}`, cardLine].filter(Boolean).join("  ")
  const files = listAttachments(payload)
  const alertId = await sendCampaignAlert(sb,
    `✉️ <b>AGENT REPLY</b> — <b>${esc(contact.name ?? contact.email ?? "")}</b> (after T${contact.touch_number})${headline ? `\n${headline}` : ""}\n"${esc(alertBody)}"${truncated ? "\n… [message truncated — full email in Gmail]" : ""}${files.length ? `\n📎 ${files.length} attachment${files.length === 1 ? "" : "s"} below` : ""}\n\nDrip continues as scheduled. Reply to this message to send it as a threaded email from ${esc(mailbox)}, or "draft: your guidance" for a Claude draft first.`
  )
  if (files.length) await forwardAttachments(sb, gmail, { gmailId, payload, who: contact.name ?? contact.email ?? "agent", replyTo: alertId })
}

const TRIAGE_TAGS: Record<string, string> = {
  deal: "🏠 <b>DEAL</b>",
  interested: "🙋 <b>INTERESTED</b>",
  question: "❓ <b>QUESTION</b>",
  not_now: "⏳ <b>NOT NOW</b>",
  other: "",
}

type ReplyTriage = {
  label: "deal" | "interested" | "question" | "not_now" | "remove" | "retired_or_wrong_person" | "other"
  address: string | null
  summary: string
}

const TRIAGE_LABELS = new Set(["deal", "interested", "question", "not_now", "remove", "retired_or_wrong_person", "other"])

/** One Haiku call per genuine reply. Null when the key is missing or the
 * model fails — the alert then goes out untagged, never dropped. */
async function triageAgentReply(args: { name: string | null; subject: string; body: string }): Promise<ReplyTriage | null> {
  if (!hasLlmKey()) return null
  const text = args.body.trim().slice(0, 4000)
  if (!text) return null
  const prompt = `Ryan LaRocca (real estate investor, LRG Homes) emails real estate agents he knows, asking for listings — single-family and 2-15 unit multifamily in the Bay Area under $4M, as-is, quick close. An agent${args.name ? ` (${args.name})` : ""} replied. Classify the reply.

Labels:
- deal: they offer, mention or tease a specific property, listing, pocket listing or seller they could bring Ryan.
- interested: they want to talk, meet, keep in touch, or will keep him in mind — no specific property yet.
- question: they ask something about Ryan's buy box, proof of funds, process, commission, or who he is.
- not_now: friendly no for now ("nothing right now", "check back in spring", "all my listings are retail").
- remove: they want no more emails — any phrasing ("not working with investors", "please don't send these", "no thanks, not interested", "take me off").
- retired_or_wrong_person: they left real estate, retired, moved markets, or say Ryan has the wrong person.
- other: anything else (thanks only, forwarding to a colleague, unclear).

Be strict with remove and retired_or_wrong_person: only when the reply clearly means stop contacting me or I'm not the right person. A joke, a maybe, or "not right now" is not_now.

Reply with ONLY a JSON object: {"label": "<one label>", "address": "<property address or short property description if a deal, else null>", "summary": "<one sentence, plain, what they said and want>"}

SUBJECT: ${args.subject}
REPLY:
"${text}"`
  try {
    const out = await completeText({ model: HAIKU, prompt, maxTokens: 300, tag: "[campaign-inbox triage]" })
    const j = JSON.parse(extractJsonObject(out.text)) as { label?: unknown; address?: unknown; summary?: unknown }
    const label = typeof j.label === "string" && TRIAGE_LABELS.has(j.label) ? (j.label as ReplyTriage["label"]) : "other"
    const address = typeof j.address === "string" && j.address.trim() && j.address.trim().toLowerCase() !== "null" ? j.address.trim().slice(0, 160) : null
    const summary = typeof j.summary === "string" && j.summary.trim() ? j.summary.trim().slice(0, 300) : text.slice(0, 160)
    return { label, address, summary }
  } catch (e) {
    console.warn("[campaign-inbox] triage failed:", e instanceof Error ? e.message : String(e))
    return null
  }
}

/** Resolve the replying agent to a Relationships card and log the reply as
 * an inbound email touch. Never throws — the alert must go out regardless. */
async function cardForReply(
  sb: SupabaseClient,
  contact: CampaignContact,
  sender: string,
  body: string,
  subject: string,
  reactivate = true
): Promise<Extract<AgentContact, { kind: "relationship" }> | null> {
  try {
    const lite: CampaignContactLite = {
      id: contact.id,
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      relationship_id: contact.relationship_id,
      touch_number: contact.touch_number,
      status: contact.status,
    }
    const who = await resolveAgentContact(sb, { email: sender || contact.email, campaign: lite, channel: "email", reactivate })
    if (who.kind !== "relationship") return null
    await logInboundEmailTouch(sb, who, body, subject)
    return who
  } catch (e) {
    console.error("[campaign-inbox] card link failed:", e instanceof Error ? e.message : String(e))
    return null
  }
}

/**
 * Process a Gmail Pub/Sub notification for a campaign inbox. Scans the
 * recent inbox (same recent-window pattern the lead watcher uses),
 * classifies each message, and drops everything that isn't
 * campaign-related before any content handling. With no argument, scans
 * every campaign inbox (ryansvr@ new threads + info@ legacy threads).
 */
export async function processCampaignInbox(mailbox?: string): Promise<void> {
  const boxes = mailbox ? [mailbox] : CAMPAIGN_INBOXES
  for (const box of boxes) await processOneCampaignInbox(box)
}

async function processOneCampaignInbox(mailbox: string): Promise<void> {
  const sb = getLeadsClient()
  const gmail = getGmailClient(mailbox)

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

      // Our own mail (internal lrghomes.com, or a campaign mailbox's self-sent
      // copy, e.g. a redirected test) is never a reply or a bounce.
      if (!sender || isOwnAddress(sender) || CAMPAIGN_INBOXES.includes(sender.toLowerCase())) continue

      const isBounce = BOUNCE_SENDER_RE.test(sender) || BOUNCE_SUBJECT_RE.test(subject)
      if (isBounce) {
        const body = extractText(message.payload)
        await handleBounce(sb, { gmailId, subject, body, headers, mailbox })
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
      await handleContactMessage(sb, gmail, contact, { gmailId, threadId, subject, body, mailbox, sender, payload: message.payload })
    } catch (e) {
      console.error(`[campaign-inbox] failed on ${gmailId}:`, e)
      await sendCampaignAlert(sb, `⚠️ Campaign inbox processing failed on a message — check Vercel logs (${gmailId})`)
    }
  }
}
