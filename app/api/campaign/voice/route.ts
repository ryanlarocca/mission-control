import { NextRequest, NextResponse } from "next/server"
import { FORWARD_TO, getLeadsClient, isOwnedNumber, parseTwilioBody } from "@/lib/leads"
import { sendCampaignAlert } from "@/lib/campaignAlerts"
import { openInboundCallTouch } from "@/lib/office-inbound"
import { PROD_BASE } from "@/lib/relationship-calls"
import { AGENTS_LINE, describeAgent, findCampaignContactByPhone, resolveAgentContact } from "@/lib/agentsLineInbound"

// Agents line (650) 910-4007 — inbound call webhook (Phase 5b of
// briefs/EMAIL_DRIP_CAMPAIGN_2026-07-17.md; Relationships plumbing 2026-10-01).
//
// NO whisper — the call relays straight to Ryan's cell showing the
// agents-line number as caller ID, and context arrives via Telegram as it
// rings. Since 2026-10-01 the caller is resolved to a Relationships card
// (campaign list → Relationships → Leads → new card, same plumbing as the
// business-card office lines) and the live call is recorded from answer,
// transcribed and summarized onto the card — Ryan unlocked the original
// "metadata-only" decision after telling the agents verbally. Voicemail is
// recorded on no-answer via /voice/status.

export const dynamic = "force-dynamic"

function fmtPhone(digits10: string): string {
  return digits10.length === 10
    ? `(${digits10.slice(0, 3)}) ${digits10.slice(3, 6)}-${digits10.slice(6)}`
    : digits10
}

// Best-effort CNAM lookup for callers we don't know ($0.01/lookup, unknowns
// only). Twilio needs TwiML back fast, so failures/slowness just degrade to
// the bare number.
async function lookupCallerName(digits10: string): Promise<string | null> {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !token || digits10.length !== 10) return null
  try {
    const res = await fetch(
      `https://lookups.twilio.com/v2/PhoneNumbers/%2B1${digits10}?Fields=caller_name`,
      { headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` } }
    )
    if (!res.ok) return null
    const data = await res.json()
    return data?.caller_name?.caller_name ?? null
  } catch {
    return null
  }
}

function xml(body: string): NextResponse {
  return new NextResponse(body, { headers: { "Content-Type": "text/xml" } })
}

// Plain relay (no card): the pre-2026-10-01 behaviour, kept as the fallback
// when the caller is an existing seller lead or the resolver failed.
function plainDialTwiml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="20" action="/api/campaign/voice/status" method="POST" callerId="${AGENTS_LINE}">
    <Number>${FORWARD_TO}</Number>
  </Dial>
</Response>`
}

// Card relay: records from answer (→ /api/crms/call/recording, the same
// transcribe + summarize pipeline the office lines use) and threads the touch
// id through to the status + recording callbacks. campaignContactId lets the
// recording pipeline mirror the summary onto the campaign timeline.
function cardDialTwiml(touchId: string, campaignContactId: string | null): string {
  const q = `?touchId=${encodeURIComponent(touchId)}&line=agents${campaignContactId ? `&campaignContactId=${encodeURIComponent(campaignContactId)}` : ""}`
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="20" action="/api/campaign/voice/status${q}" method="POST" callerId="${AGENTS_LINE}" record="record-from-answer" recordingStatusCallback="${PROD_BASE}/api/crms/call/recording${q}" recordingStatusCallbackMethod="POST">
    <Number>${FORWARD_TO}</Number>
  </Dial>
</Response>`
}

export async function POST(request: NextRequest) {
  let from = ""
  let callSid: string | null = null
  try {
    const params = parseTwilioBody(await request.text())
    from = params.get("From") || ""
    callSid = params.get("CallSid") || null
  } catch {
    // fall through with empty caller — still relay the call
  }
  const digits = from.replace(/\D/g, "").slice(-10)
  const sb = getLeadsClient()

  // One of our own Twilio numbers dialing in (a system test) — relay, alert,
  // never create a card for ourselves.
  if (from && isOwnedNumber(from)) {
    await sendCampaignAlert(sb, `📞 <b>Agents line ringing</b> — from our own line ${fmtPhone(digits)} (system test) — relaying to your cell`)
    return xml(plainDialTwiml())
  }

  // Fire-and-await the ring alert (void'd sends get killed on Vercel — the
  // June 11 lesson), but never let alert failure break call routing.
  try {
    const campaign = digits.length === 10 ? await findCampaignContactByPhone(sb, digits) : null
    const who = digits.length === 10
      ? await resolveAgentContact(sb, { phone: from, campaign, channel: "call" })
      : { kind: "lead" as const }
    if (who.kind === "relationship") {
      const touchId = await openInboundCallTouch(sb, who, callSid, "agents line")
      await sendCampaignAlert(sb, `📞 <b>Agents line ringing</b> — ${describeAgent(who)} ${fmtPhone(digits)} — relaying to your cell`)
      if (touchId) return xml(cardDialTwiml(touchId, campaign?.id ?? null))
      console.error(`[campaign-voice] touch insert failed for ${from}; dialing without a card`)
      return xml(plainDialTwiml())
    }
    if (campaign) {
      await sendCampaignAlert(sb, `📞 <b>Agents line ringing</b> — <b>${campaign.name ?? from}</b> ${fmtPhone(digits)} (after T${campaign.touch_number}) — relaying to your cell`)
    } else {
      const cnam = await lookupCallerName(digits)
      await sendCampaignAlert(sb, `📞 <b>Agents line ringing</b> — ${cnam ? `<b>${cnam}</b> ` : ""}${fmtPhone(digits) || from} — ${who.kind === "lead" && digits.length === 10 ? "existing lead" : "not in campaign list"} — relaying to your cell`)
    }
  } catch (e) {
    console.error("[campaign-voice] ring alert failed:", e)
  }
  return xml(plainDialTwiml())
}
