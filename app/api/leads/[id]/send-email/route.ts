import { NextRequest, NextResponse } from "next/server"
import { getGmailClient, getLeadsClient, getMailboxForSource, encodeEmailHeader, detectOfferFromText, applyDetectedOfferToCluster, registerManualTouch } from "@/lib/leads"

// Phase 7C — Part 6: send a manual email to a lead from the lead card.
//
// Distinct from /api/leads/email-reply — that endpoint is for replying
// inside an existing Gmail thread (uses gmail_thread_id + In-Reply-To
// headers). This endpoint sends a *fresh* email, choosing the sending
// mailbox by this priority:
//   1. lead came in via email      → reply from that mailbox (preserves thread)
//   2. campaign mailbox for source → MFM-A→ryansvg@, MFM-B→ryansvj@ — so the
//      lead always sees the same address tied to the mailer they responded to
//   3. lead.source_type=google_ads → info@lrghomes.com
//   4. fallback                    → DRIP_DEFAULT_MAILBOX or ryan@lrghomes.com
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
    `Subject: ${encodeEmailHeader(args.subject)}`,
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

  let body: { subject?: unknown; body?: unknown; to?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const subject = typeof body.subject === "string" ? body.subject.trim() : ""
  const text = typeof body.body === "string" ? body.body.trim() : ""
  // Optional recipient override — supplied by the Follow Ups composer when the
  // lead has no email on file yet. Lets Ryan email a phone-only lead by typing
  // an address; we use it as the recipient AND persist it to the lead below so
  // future touches know it.
  const toOverride =
    typeof body.to === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.to.trim())
      ? body.to.trim()
      : null
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

    // The id we're handed is the cluster's most-recent-inbound row, which
    // may not be the row that carries the email — e.g. Mike Cummings'
    // inbound voicemail row has no email, but the later outbound-call row
    // does (the analyzer pulled it off that transcript). So if the target
    // row has no email, fall through to any sibling in the cluster.
    let recipientEmail: string | null = lead.email ?? null
    if (!recipientEmail) {
      let sibQ = sb.from("leads").select("email").not("email", "is", null).limit(1)
      if (lead.caller_phone) sibQ = sibQ.eq("caller_phone", lead.caller_phone)
      else if (lead.gmail_thread_id) sibQ = sibQ.eq("gmail_thread_id", lead.gmail_thread_id)
      else sibQ = sibQ.eq("id", id) // no cluster key — this just re-checks the row
      const { data: sib } = await sibQ
      recipientEmail = (sib?.[0]?.email as string | undefined) ?? null
    }
    // Caller-supplied address is the last resort — but it's also a real signal
    // (Ryan typed it), so stamp it onto the target row for future touches.
    if (!recipientEmail && toOverride) {
      recipientEmail = toOverride
      const { error: stampErr } = await sb.from("leads").update({ email: toOverride }).eq("id", id)
      if (stampErr) console.warn(`[send-email] couldn't persist typed email on ${id}:`, stampErr.message)
    }
    if (!recipientEmail) {
      return NextResponse.json({ error: "lead has no email address" }, { status: 400 })
    }

    // Sending mailbox priority — see the header comment. A call/SMS lead
    // gets the mailbox tied to its campaign (MFM-A → ryansvg@, MFM-B →
    // ryansvj@) so it always corresponds to the mailer they responded to.
    const tn = String(lead.twilio_number || "")
    const campaignMailbox = getMailboxForSource(lead.source)
    const fromMailbox = tn.startsWith("email:")
      ? tn.slice("email:".length)
      : campaignMailbox
      ?? (lead.source_type === "google_ads"
        ? "info@lrghomes.com"
        : process.env.DRIP_DEFAULT_MAILBOX || "ryan@lrghomes.com")

    const gmail = getGmailClient(fromMailbox)
    const raw = buildRawEmail({ to: recipientEmail, from: fromMailbox, subject, body: text })
    const requestBody: { raw: string; threadId?: string } = { raw }
    if (lead.gmail_thread_id) requestBody.threadId = lead.gmail_thread_id
    const { data } = await gmail.users.messages.send({ userId: "me", requestBody })

    // Record an outbound row so the timeline shows the send.
    const { data: outboundRow, error: insErr } = await sb.from("leads").insert({
      source: lead.source,
      source_type: lead.source_type,
      twilio_number: null,
      caller_phone: lead.caller_phone,
      lead_type: "email",
      message: `${subject}\n\n${text}`,
      status: "contacted",
      name: lead.name,
      email: recipientEmail,
      property_address: lead.property_address,
      gmail_thread_id: lead.gmail_thread_id || null,
    }).select("id").single()
    if (insErr) console.warn(`[send-email] event row insert failed for ${id}:`, insErr.message)

    // Auto-detect any verbalized offer in this outbound email body and
    // stamp it on the cluster. Hands-off: only writes when the cluster
    // has no existing offer_amount. Detection runs ONLY on subject + body
    // — quoted/forwarded thread above is ignored by passing only `text`.
    if (outboundRow?.id) {
      try {
        const result = await detectOfferFromText(`${subject}\n\n${text}`, {
          channel: "email",
          lead_name: lead.name,
          property: lead.property_address,
        })
        if (result?.offer_verbalized && typeof result.offer_amount === "number") {
          const wrote = await applyDetectedOfferToCluster(sb, {
            leadId: outboundRow.id,
            caller_phone: lead.caller_phone,
            email: recipientEmail,
            gmail_thread_id: lead.gmail_thread_id || null,
            offer_amount: result.offer_amount,
          })
          if (wrote) console.log(`[send-email] auto-stamped offer $${result.offer_amount} on cluster of ${id}`)
        }
      } catch (e) {
        console.warn(`[send-email] offer detection failed for ${id}:`, e instanceof Error ? e.message : String(e))
      }
    }

    // Reset the drip cadence clock — same rationale as leads/send/route.ts.
    if (outboundRow?.id) {
      try {
        await registerManualTouch(sb, { id: outboundRow.id, caller_phone: lead.caller_phone, email: recipientEmail })
      } catch (e) {
        console.warn(`[send-email] cadence reset failed for ${id}:`, e instanceof Error ? e.message : String(e))
      }
    }

    // Mirror the SMS / call new→contacted promote on the cluster's inbound
    // row. Without this, the outbound row carries status="contacted" but the
    // group status (derived from mostRecentInbound) stays "new", so the lead
    // doesn't move out of the New filter after Ryan emails them.
    try {
      const inboundQuery = sb
        .from("leads")
        .select("id, status")
        .not("twilio_number", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
      // Email leads can have null caller_phone (e.g., Google Voice forwards
      // without a phone in the body). gmail_thread_id is the more reliable
      // cluster key for email; fall back to caller_phone if no thread.
      const { data: intake } = lead.gmail_thread_id
        ? await inboundQuery.eq("gmail_thread_id", lead.gmail_thread_id)
        : lead.caller_phone
        ? await inboundQuery.eq("caller_phone", lead.caller_phone)
        : { data: null as { id: string; status: string }[] | null }
      const intakeRow = intake?.[0]
      if (intakeRow && intakeRow.status === "new") {
        const { error: promoteErr } = await sb
          .from("leads")
          .update({ status: "contacted" })
          .eq("id", intakeRow.id)
        if (promoteErr) console.error("[send-email] Status promote failed:", promoteErr)
      }
    } catch (e) {
      console.error("[send-email] Status promote threw:", e)
    }

    return NextResponse.json({ ok: true, mailbox: fromMailbox, messageId: data.id || null })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[send-email] threw:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
