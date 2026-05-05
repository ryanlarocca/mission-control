import { NextRequest, NextResponse } from "next/server"
import { getGmailClient, getLeadsClient } from "@/lib/leads"

// Send an email reply to an inbound lead from the mailbox that received it.
//
// Auth: gated by middleware via the mc_session cookie (do NOT add this path
// to PUBLIC_PATHS — the route reads + writes Supabase rows and sends mail
// from a Workspace mailbox; only the authenticated session should trigger
// it).
//
// Mailbox derivation: each inbound email lead row has
//   twilio_number = "email:<receiving-mailbox>"
// (set in app/api/leads/email/route.ts during the inbound insert). Stripping
// the "email:" prefix gives us the mailbox to send the reply from. The Gmail
// API's `subject:` JWT impersonation handles the rest.
//
// Threading: we set `threadId` on the Gmail send so the message lands in
// the same Gmail conversation. To make recipient clients (Outlook, Apple
// Mail, non-Gmail consumers) cluster the reply under the original, we also
// set `In-Reply-To:` and `References:` headers — using the *real* RFC 2822
// Message-Ids fetched from the existing thread (not the gmail thread-id,
// which isn't a Message-Id and doesn't match anything in the recipient's
// store). Costs one extra metadata-only `threads.get` call before send.

interface EmailReplyBody {
  leadId?: string
  message?: string
}

export async function POST(request: NextRequest) {
  let body: EmailReplyBody
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const leadId = (body?.leadId || "").trim()
  const text = (body?.message || "").trim()
  if (!leadId) return NextResponse.json({ error: "leadId is required" }, { status: 400 })
  if (!text) return NextResponse.json({ error: "message is required" }, { status: 400 })

  const sb = getLeadsClient()
  const { data: lead, error: lookupErr } = await sb
    .from("leads")
    .select("id, email, twilio_number, gmail_thread_id, source, source_type, message, caller_phone")
    .eq("id", leadId)
    .maybeSingle()
  if (lookupErr) {
    console.error("[email-reply] Lead lookup failed:", lookupErr)
    return NextResponse.json({ error: "Lookup failed" }, { status: 500 })
  }
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 })

  if (!lead.email) {
    return NextResponse.json({ error: "Lead has no email address to reply to" }, { status: 400 })
  }
  const tn = String(lead.twilio_number || "")
  if (!tn.startsWith("email:")) {
    return NextResponse.json(
      { error: `Lead is not an email lead (twilio_number=${tn || "null"})` },
      { status: 400 }
    )
  }
  const mailbox = tn.slice("email:".length).toLowerCase()
  if (!mailbox) {
    return NextResponse.json({ error: "Could not derive sending mailbox" }, { status: 400 })
  }

  // Subject: parse out the first line of the inbound message (which the
  // route stores as `<subject>\n\n<body>`). Fall back to a generic subject
  // if the message column is empty.
  const originalSubject = (lead.message || "").split(/\r?\n/, 1)[0].trim()
  const replySubject = originalSubject
    ? (/^re:\s/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`)
    : "Re: Your inquiry"

  // Send via Gmail API impersonating the mailbox owner. To make the reply
  // thread correctly in the recipient's email client (not just internally
  // in our Gmail thread), we need the real RFC 2822 `Message-Id` of the
  // original message — Gmail's thread-id is an internal identifier, not a
  // Message-Id, and putting `<threadId@mail.gmail.com>` in `In-Reply-To`
  // doesn't match anything in the recipient's store, so most clients open
  // the reply in a fresh thread.
  //
  // We do one extra Gmail API call up front: pull the thread's headers
  // (metadata-only — small payload), collect every Message-Id, use the
  // most recent for `In-Reply-To` and chain all of them in `References`.
  // ~200-500ms cost; properly threads in Gmail, Outlook, Apple Mail, etc.
  const gmail = getGmailClient(mailbox)
  let inReplyTo: string | null = null
  let referencesChain: string[] = []
  if (lead.gmail_thread_id) {
    try {
      const { data: thread } = await gmail.users.threads.get({
        userId: "me",
        id: lead.gmail_thread_id,
        format: "metadata",
        metadataHeaders: ["Message-Id"],
      })
      const msgIds: string[] = []
      for (const m of thread.messages || []) {
        const headers = m.payload?.headers || []
        const idHdr = headers.find((h) => (h.name || "").toLowerCase() === "message-id")
        if (idHdr?.value) msgIds.push(idHdr.value.trim())
      }
      if (msgIds.length > 0) {
        inReplyTo = msgIds[msgIds.length - 1]
        referencesChain = msgIds
      }
    } catch (e) {
      // Thread fetch is best-effort. If it fails the reply still goes out;
      // it just won't have proper RFC threading headers.
      console.warn("[email-reply] thread metadata fetch failed:", e instanceof Error ? e.message : String(e))
    }
  }

  const raw = buildRawEmail({
    to: lead.email,
    from: mailbox,
    subject: replySubject,
    body: text,
    inReplyTo,
    references: referencesChain,
  })

  let sentMessageId: string | null = null
  try {
    const requestBody: { raw: string; threadId?: string } = { raw }
    if (lead.gmail_thread_id) requestBody.threadId = lead.gmail_thread_id
    const { data } = await gmail.users.messages.send({
      userId: "me",
      requestBody,
    })
    sentMessageId = data.id || null
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[email-reply] Gmail send failed:", msg)
    return NextResponse.json({ error: "Email send failed", details: msg }, { status: 502 })
  }

  // Log the outbound row. twilio_number=null is the outbound convention
  // (per lib/leads.ts isOutbound). We thread on the same gmail_thread_id so
  // the Leads-tab card shows the reply alongside the original.
  const { data: inserted, error: insertErr } = await sb
    .from("leads")
    .insert({
      lead_type: "email",
      source_type: lead.source_type,
      source: lead.source,
      twilio_number: null,
      caller_phone: lead.caller_phone,
      name: null,
      email: lead.email,
      message: text,
      status: "contacted",
      gmail_thread_id: lead.gmail_thread_id,
    })
    .select("id")
    .single()

  if (insertErr) {
    // The mail went out — don't fail the request. Surface the log error.
    console.error("[email-reply] Outbound row insert failed:", insertErr)
    return NextResponse.json({
      ok: true,
      sentMessageId,
      logError: insertErr.message,
    })
  }

  return NextResponse.json({ ok: true, sentMessageId, leadId: inserted?.id })
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
    `Subject: ${subject}`,
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
