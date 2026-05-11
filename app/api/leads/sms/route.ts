import { NextResponse } from "next/server"
import {
  getCampaignSource,
  getLeadsClient,
  isDncMessage,
  isMobileHome,
  OUTBOUND_TWILIO_NUMBER,
  parseTwilioBody,
  sendTelegramAlert,
} from "@/lib/leads"

// Twilio fires this when a lead texts MFM-A, MFM-B, or the outbound caller-ID
// number. We log it and alert Ryan; no auto-reply for now.
//
// Phase 7C-may8 Bug 6: STOP / unsubscribe keywords flip is_dnc + status=dead
// on the matched intake row and skip the normal drip-eligible insert.
//
// Phase 7C-may8 Bug 1: inbound SMS to +16502043247 (the outbound caller-ID
// number) is treated as a callback against the existing lead, not a fresh
// intake — no drip-campaign stamp, no status reset.

const EMPTY_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response></Response>`

const DEDUP_WINDOW_DAYS = 30
const DNC_LOOKBACK_DAYS = 90

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
  const isDnc = isDncMessage(bodyText)
  const isOutboundCallback = to === OUTBOUND_TWILIO_NUMBER

  if (from) {
    try {
      const sb = getLeadsClient()

      if (isDnc) {
        // Find the most recent intake row for this number and flag it.
        // Search broadly (twilio_number IS NOT NULL) so we hit the original
        // intake regardless of which campaign delivered it.
        const since = new Date(Date.now() - DNC_LOOKBACK_DAYS * 86_400_000).toISOString()
        const { data: existing } = await sb
          .from("leads")
          .select("id")
          .eq("caller_phone", from)
          .not("twilio_number", "is", null)
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(1)
        const existingId = existing?.[0]?.id ?? null

        if (existingId) {
          const { error } = await sb
            .from("leads")
            .update({ is_dnc: true, status: "dead" })
            .eq("id", existingId)
          if (error) console.error("[sms] DNC update failed:", error)
        }

        // Still insert the inbound STOP row so the message shows up in the
        // timeline (the UI groups events by caller_phone). Mark it dead +
        // is_dnc and skip drip fields so the engine never picks it back up.
        const { error: insertErr } = await sb.from("leads").insert({
          source,
          source_type: "direct_mail",
          twilio_number: to || null,
          caller_phone: from,
          lead_type: "sms",
          message: bodyText,
          status: "dead",
          is_dnc: true,
        })
        if (insertErr) console.error("[sms] DNC insert failed:", insertErr)

        void sendTelegramAlert(`🚫 Lead DNC'd — <b>${source}</b> — ${from}`)

        return new NextResponse(EMPTY_TWIML, {
          headers: { "Content-Type": "text/xml" },
        })
      }

      // Non-DNC path. For the outbound callback case, we look up the
      // existing lead within the dedup window so we can: (a) skip the
      // drip-campaign stamp (the lead is already in a campaign), and (b)
      // skip the new-intake Telegram noise. The UI groups timeline events
      // by caller_phone, so just inserting an event row attaches it to
      // the existing card automatically.
      let existingLeadId: string | null = null
      if (isOutboundCallback) {
        const since = new Date(Date.now() - DEDUP_WINDOW_DAYS * 86_400_000).toISOString()
        const { data: existing } = await sb
          .from("leads")
          .select("id")
          .eq("caller_phone", from)
          .not("twilio_number", "is", null)
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(1)
        existingLeadId = existing?.[0]?.id ?? null
      }

      const isJunkAddr = isMobileHome(bodyText)

      const insertRow: Record<string, unknown> = {
        source,
        source_type: "direct_mail",
        twilio_number: to || null,
        caller_phone: from,
        lead_type: "sms",
        message: bodyText,
        status: "new",
      }
      if (isJunkAddr) insertRow.is_junk = true

      if (!existingLeadId) {
        // Fresh intake — stamp drip campaign for the engine to pick up.
        insertRow.drip_campaign_type = "direct_mail_sms"
        insertRow.drip_touch_number = 0
        insertRow.last_drip_sent_at = new Date().toISOString()
      }

      const { error } = await sb.from("leads").insert(insertRow)
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
