import { NextRequest, NextResponse } from "next/server"
import { getGmailClient, getLeadsClient } from "@/lib/leads"

// Phase 7C — Part 6: send a manual email to a lead from the lead card.
//
// Distinct from /api/leads/email-reply — that endpoint is for replying
// inside an existing Gmail thread (uses gmail_thread_id + In-Reply-To
// headers). This endpoint sends a *fresh* email, choosing the sending
// mailbox by the same priority as the drip engine:
//   1. lead came in via email   → reply from that mailbox (preserves thread)
//   2. lead.source_type=google_ads → info@lrghomes.com
//   3. fallback                  → DRIP_DEFAULT_MAILBOX or ryan@lrghomes.com
//
// Records an outbound `lead_type=email` row so the timeline shows it.
function buildRawEmail(args: {
  to: string
  from: string
  subject: string
  body: string
}): string {
  const lines = [
    `To: ${args.to}`,
    `From: ${args.from}`,
    `Subject: ${args.subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    args.body,
  ]
  return Buffer.from(lines.join("\r\n")).toString("base64url")
}

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  let body: { subject?: unknown; body?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const subject = typeof body.subject === "string" ? body.subject.trim() : ""
  const text = typeof body.body === "string" ? body.body.trim() : ""
  if (!subject) return NextResponse.json({ error: "subject required" }, { status: 400 })
  if (!text) return NextResponse.json({ error: "body required" }, { status: 400 })

  try {
    const sb = getLeadsClient()
    const { data: lead, error } = await sb
      .from("leads")
      .select("id, email, twilio_number, source, source_type, name, property_address, caller_phone, gmail_thread_id, is_dnc")
      .eq("id", id)
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!lead) return NextResponse.json({ error: "lead not found" }, { status: 404 })
    if (lead.is_dnc) {
      return NextResponse.json({ error: "lead is DNC" }, { status: 409 })
    }
    if (!lead.email) {
      return NextResponse.json({ error: "lead has no email address" }, { status: 400 })
    }

    const tn = String(lead.twilio_number || "")
    const fromMailbox = tn.startsWith("email:")
      ? tn.slice("email:".length)
      : lead.source_type === "google_ads"
      ? "info@lrghomes.com"
      : process.env.DRIP_DEFAULT_MAILBOX || "ryan@lrghomes.com"

    const gmail = getGmailClient(fromMailbox)
    const raw = buildRawEmail({ to: lead.email, from: fromMailbox, subject, body: text })
    const requestBody: { raw: string; threadId?: string } = { raw }
    if (lead.gmail_thread_id) requestBody.threadId = lead.gmail_thread_id
    const { data } = await gmail.users.messages.send({ userId: "me", requestBody })

    // Record an outbound row so the timeline shows the send.
    const { error: insErr } = await sb.from("leads").insert({
      source: lead.source,
      source_type: lead.source_type,
      twilio_number: null,
      caller_phone: lead.caller_phone,
      lead_type: "email",
      message: `${subject}\n\n${text}`,
      status: "contacted",
      name: lead.name,
      email: lead.email,
      property_address: lead.property_address,
      gmail_thread_id: lead.gmail_thread_id || null,
    })
    if (insErr) console.warn(`[send-email] event row insert failed for ${id}:`, insErr.message)

    return NextResponse.json({ ok: true, mailbox: fromMailbox, messageId: data.id || null })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[send-email] threw:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
