import { NextRequest, NextResponse } from "next/server"
import { FORWARD_TO, getLeadsClient } from "@/lib/leads"
import { sendCampaignAlert } from "@/lib/campaignAlerts"

// Agents line (650) 910-4007 — inbound call webhook (Phase 5b of
// briefs/EMAIL_DRIP_CAMPAIGN_2026-07-17.md).
//
// Locked decisions: NO whisper — the call relays straight to Ryan's cell
// showing the agents-line number as caller ID (Ryan saves the line as a
// phone contact), and context arrives via Telegram as it rings. Live calls
// are metadata-only — NO recording (CA two-party consent). Voicemail (which
// is consented by nature) is recorded on no-answer via /voice/status.

export const dynamic = "force-dynamic"

const AGENTS_LINE = "+16509104007"

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

async function lookupContact(digits10: string) {
  const sb = getLeadsClient()
  const { data } = await sb
    .from("campaign_contacts")
    .select("id, name, email, touch_number")
    .or(`phone.eq.${digits10},alt_phones.cs.{${digits10}}`)
    .limit(1)
  return data?.[0] ?? null
}

export async function POST(request: NextRequest) {
  let from = ""
  try {
    const params = new URLSearchParams(await request.text())
    from = params.get("From") || ""
  } catch {
    // fall through with empty caller — still relay the call
  }
  const digits = from.replace(/\D/g, "").slice(-10)

  // Fire-and-await the ring alert (void'd sends get killed on Vercel — the
  // June 11 lesson), but never let alert failure break call routing.
  try {
    const sb = getLeadsClient()
    const contact = digits.length === 10 ? await lookupContact(digits) : null
    if (contact) {
      await sendCampaignAlert(sb, 
        `📞 <b>Agents line ringing</b> — <b>${contact.name ?? from}</b> ${fmtPhone(digits)} (after T${contact.touch_number}) — relaying to your cell`
      )
    } else {
      const cnam = await lookupCallerName(digits)
      await sendCampaignAlert(sb, `📞 <b>Agents line ringing</b> — ${cnam ? `<b>${cnam}</b> ` : ""}${fmtPhone(digits) || from} — not in campaign list — relaying to your cell`)
    }
  } catch (e) {
    console.error("[campaign-voice] ring alert failed:", e)
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="20" action="/api/campaign/voice/status" method="POST" callerId="${AGENTS_LINE}">
    <Number>${FORWARD_TO}</Number>
  </Dial>
</Response>`
  return new NextResponse(twiml, { headers: { "Content-Type": "text/xml" } })
}
