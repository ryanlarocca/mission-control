import { NextResponse } from "next/server"
import {
  getCampaignSource,
  getLeadsClient,
  parseTwilioBody,
  sendTelegramAlert,
} from "@/lib/leads"

// Twilio fires this when a lead texts MFM-A or MFM-B. We log it and alert
// Ryan; no auto-reply for now.

const EMPTY_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response></Response>`

export async function POST(request: Request) {
  let from = ""
  let to = ""
  let bodyText = ""
  try {
    const raw = await request.text()
    const params = parseTwilioBody(raw)
    from = params.get("From") || ""
    to = params.get("To") || ""
    bodyText = params.get("Body") || ""
  } catch (e) {
    console.error("[sms] Failed to parse Twilio body:", e)
  }

  const source = getCampaignSource(to)

  if (from) {
    // AWAIT the insert — see comment in /api/leads/voice/route.ts on why
    // fire-and-forget fails in Vercel serverless. Telegram stays
    // fire-and-forget since it's best-effort.
    try {
      const sb = getLeadsClient()
      const { error } = await sb.from("leads").insert({
        source,
        source_type: "direct_mail",
        twilio_number: to || null,
        caller_phone: from,
        lead_type: "sms",
        message: bodyText,
        status: "new",
        // Phase 7B: stamp drip campaign on intake (48h entry delay).
        drip_campaign_type: "direct_mail_sms",
        drip_touch_number: 0,
        last_drip_sent_at: new Date().toISOString(),
      })
      if (error) console.error("[sms] Supabase insert failed:", error)
    } catch (e) {
      console.error("[sms] Supabase threw:", e)
    }
    const preview = bodyText.length > 300 ? bodyText.slice(0, 300) + "…" : bodyText
    const escaped = preview.replace(/[<>&]/g, c => c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;")
    void sendTelegramAlert(
      `💬 New lead text — <b>${source}</b> — ${from}\n"${escaped}"`
    )
  }

  return new NextResponse(EMPTY_TWIML, {
    headers: { "Content-Type": "text/xml" },
  })
}
