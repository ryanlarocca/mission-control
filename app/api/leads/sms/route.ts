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
    void (async () => {
      try {
        const sb = getLeadsClient()
        const { error } = await sb.from("leads").insert({
          source,
          twilio_number: to || null,
          caller_phone: from,
          lead_type: "sms",
          message: bodyText,
          status: "new",
        })
        if (error) console.error("[sms] Supabase insert failed:", error)
      } catch (e) {
        console.error("[sms] Supabase threw:", e)
      }
      const preview = bodyText.length > 300 ? bodyText.slice(0, 300) + "…" : bodyText
      const escaped = preview.replace(/[<>&]/g, c => c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;")
      await sendTelegramAlert(
        `💬 New lead text — <b>${source}</b> — ${from}\n"${escaped}"`
      )
    })()
  }

  return new NextResponse(EMPTY_TWIML, {
    headers: { "Content-Type": "text/xml" },
  })
}
