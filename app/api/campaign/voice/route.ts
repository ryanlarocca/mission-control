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
        `📞 <b>Agents line ringing</b> — <b>${contact.name ?? from}</b> (after T${contact.touch_number}) — relaying to your cell`
      )
    } else {
      await sendCampaignAlert(sb, `📞 Agents line ringing — unknown caller ${from} — relaying to your cell`)
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
