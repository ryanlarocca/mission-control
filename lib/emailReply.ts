// Send a threaded email reply to an inbound email lead from the mailbox that
// received it. Extracted from app/api/leads/email-reply/route.ts (2026-09-24)
// so the Telegram planner draft can send the same way the card does. The
// route is now a thin auth-gated wrapper around sendThreadedEmailReply.
//
// Mailbox derivation: inbound email lead rows carry
//   twilio_number = "email:<receiving-mailbox>"
// Threading: threadId on the Gmail send + real RFC 2822 In-Reply-To /
// References headers pulled from the existing thread (metadata-only call).

import { getGmailClient, getLeadsClient, encodeEmailHeader, registerManualTouch } from "@/lib/leads"
import { markDraftSent } from "@/lib/reply/record"

export interface EmailReplyResult {
  ok: boolean
  status: number
  error?: string
  details?: string
  sentMessageId?: string | null
  leadId?: string
  logError?: string
}

export async function sendThreadedEmailReply(args: { leadId: string; text: string; draftId?: string | null }): Promise<EmailReplyResult> {
  const leadId = (args.leadId || "").trim()
  const text = (args.text || "").trim()
  const draftId = (args.draftId || "").trim()
  if (!leadId) return { ok: false, status: 400, error: "leadId is required" }
  if (!text) return { ok: false, status: 400, error: "message is required" }

  const sb = getLeadsClient()
  const { data: lead, error: lookupErr } = await sb
    .from("leads")
    .select("id, email, twilio_number, gmail_thread_id, source, source_type, message, caller_phone, is_dnc")
    .eq("id", leadId)
    .maybeSingle()
  if (lookupErr) {
    console.error("[email-reply] Lead lookup failed:", lookupErr)
    return { ok: false, status: 500, error: "Lookup failed" }
  }
  if (!lead) return { ok: false, status: 404, error: "Lead not found" }
  if (lead.is_dnc) return { ok: false, status: 409, error: "lead is DNC" }
  if (!lead.email) return { ok: false, status: 400, error: "Lead has no email address to reply to" }
  const tn = String(lead.twilio_number || "")
  if (!tn.startsWith("email:")) return { ok: false, status: 400, error: `Lead is not an email lead (twilio_number=${tn || "null"})` }
  const mailbox = tn.slice("email:".length).toLowerCase()
  if (!mailbox) return { ok: false, status: 400, error: "Could not derive sending mailbox" }

  const originalSubject = (lead.message || "").split(/\r?\n/, 1)[0].trim().replace(/^subject:\s*/i, "")
  const replySubject = originalSubject
    ? (/^re:\s/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`)
    : "Re: Your inquiry"

  const gmail = getGmailClient(mailbox)
  let inReplyTo: string | null = null
  let referencesChain: string[] = []
  if (lead.gmail_thread_id) {
    try {
      const { data: thread } = await gmail.users.threads.get({ userId: "me", id: lead.gmail_thread_id, format: "metadata", metadataHeaders: ["Message-Id"] })
      const msgIds: string[] = []
      for (const m of thread.messages || []) {
        const idHdr = (m.payload?.headers || []).find((h) => (h.name || "").toLowerCase() === "message-id")
        if (idHdr?.value) msgIds.push(idHdr.value.trim())
      }
      if (msgIds.length > 0) { inReplyTo = msgIds[msgIds.length - 1]; referencesChain = msgIds }
    } catch (e) {
      console.warn("[email-reply] thread metadata fetch failed:", e instanceof Error ? e.message : String(e))
    }
  }

  const raw = buildRawEmail({ to: lead.email, from: mailbox, subject: replySubject, body: text, inReplyTo, references: referencesChain })
  let sentMessageId: string | null = null
  try {
    const requestBody: { raw: string; threadId?: string } = { raw }
    if (lead.gmail_thread_id) requestBody.threadId = lead.gmail_thread_id
    const { data } = await gmail.users.messages.send({ userId: "me", requestBody })
    sentMessageId = data.id || null
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[email-reply] Gmail send failed:", msg)
    return { ok: false, status: 502, error: "Email send failed", details: msg }
  }

  if (draftId) await markDraftSent(draftId, { subject: null, body: text })

  const { data: inserted, error: insertErr } = await sb
    .from("leads")
    .insert({
      lead_type: "email", source_type: lead.source_type, source: lead.source, twilio_number: null,
      caller_phone: lead.caller_phone, name: null, email: lead.email, message: text, status: "contacted",
      gmail_thread_id: lead.gmail_thread_id,
    })
    .select("id")
    .single()
  if (insertErr) {
    console.error("[email-reply] Outbound row insert failed:", insertErr)
    return { ok: true, status: 200, sentMessageId, logError: insertErr.message }
  }

  try {
    const inboundQuery = sb.from("leads").select("id, status").not("twilio_number", "is", null).order("created_at", { ascending: false }).limit(1)
    const { data: intake } = lead.gmail_thread_id
      ? await inboundQuery.eq("gmail_thread_id", lead.gmail_thread_id)
      : lead.caller_phone
      ? await inboundQuery.eq("caller_phone", lead.caller_phone)
      : { data: null as { id: string; status: string }[] | null }
    const intakeRow = intake?.[0]
    if (intakeRow && intakeRow.status === "new") {
      const { error: promoteErr } = await sb.from("leads").update({ status: "contacted" }).eq("id", intakeRow.id)
      if (promoteErr) console.error("[email-reply] Status promote failed:", promoteErr)
    }
  } catch (e) {
    console.error("[email-reply] Status promote threw:", e)
  }

  try {
    await registerManualTouch(sb, { id: inserted?.id ?? lead.id, caller_phone: lead.caller_phone, email: lead.email })
  } catch (e) {
    console.warn("[email-reply] manual-touch cadence reset failed:", e instanceof Error ? e.message : String(e))
  }

  return { ok: true, status: 200, sentMessageId, leadId: inserted?.id }
}

interface BuildRawArgs {
  to: string
  from: string
  subject: string
  body: string
  inReplyTo?: string | null
  references?: string[]
}

// Construct an RFC 2822 message and encode as base64url for Gmail API send.
// Headers are CRLF-separated per RFC; body is plain text. Gmail rewrites the
// envelope sender to whatever the impersonated mailbox is, so the From header
// here is informational (it has to match the Workspace mailbox or Gmail
// rejects with 403 — we always pass the mailbox we're impersonating).
//
// `inReplyTo` should be the bracketed Message-Id of the message we're
// replying to (e.g. "<CAEa1234@mail.gmail.com>"), and `references` should
// be the full chain of Message-Ids in the thread (oldest → newest), so that
// every email client clusters this reply under the original conversation.
function buildRawEmail({ to, from, subject, body, inReplyTo, references }: BuildRawArgs): string {
  const lines = [
    `To: ${to}`,
    `From: ${from}`,
    // RFC 2047-encode — a raw em-dash / curly quote in the subject (common
    // when the original subject came from an AI draft) garbles otherwise.
    `Subject: ${encodeEmailHeader(subject)}`,
  ]
  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`)
  }
  if (references && references.length > 0) {
    lines.push(`References: ${references.join(" ")}`)
  } else if (inReplyTo) {
    lines.push(`References: ${inReplyTo}`)
  }
  lines.push(`MIME-Version: 1.0`)
  lines.push(`Content-Type: text/plain; charset=UTF-8`)
  lines.push(``)
  lines.push(body)
  return Buffer.from(lines.join("\r\n")).toString("base64url")
}
