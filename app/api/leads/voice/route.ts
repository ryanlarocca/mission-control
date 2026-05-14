import { NextResponse } from "next/server"
import {
  FORWARD_TO,
  getCampaignSource,
  getLeadsClient,
  isAnonymousCaller,
  type LeadStatus,
  parseTwilioBody,
  sendTelegramAlert,
} from "@/lib/leads"

// TwiML voice webhook for LRG Homes Twilio numbers.
// Flow: log the lead row, then return Dial TwiML so Ryan's cell rings with
// the Twilio number as caller ID. The brief originally specified
// fire-and-forget for the Supabase insert + Telegram alert "so the caller
// hears ringing immediately" — but in Vercel serverless the function gets
// terminated when the response is flushed, so the insert silently dropped
// for some calls (Telegram fired, Supabase row missing). We now AWAIT the
// insert before responding. Adds ~150ms to TwiML latency, which is
// imperceptible to the caller. Telegram stays fire-and-forget after the
// response since it's not load-bearing for the data layer.

// `record="record-from-answer"` records both legs of the live call (silently —
// disclosure TwiML will be added later as a separate change). When the
// recording is ready Twilio fires `recordingStatusCallback`, which hits the
// same endpoint used for voicemails — that handler attaches recording_url +
// triggers Whisper + AI triage. The absolute URL is required because Twilio
// can't resolve relative URLs on a recordingStatusCallback.
const RECORDING_CALLBACK_URL =
  "https://mission-control-three-chi.vercel.app/api/leads/voice/recording"

function buildTwiml(callerId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="10" action="/api/leads/voice/no-answer" method="POST" callerId="${callerId}" record="record-from-answer" recordingStatusCallback="${RECORDING_CALLBACK_URL}" recordingStatusCallbackMethod="POST">
    <Number>${FORWARD_TO}</Number>
  </Dial>
</Response>`
}

export async function POST(request: Request) {
  let twilioNumber = FORWARD_TO
  let callerPhone = ""
  try {
    const body = await request.text()
    const params = parseTwilioBody(body)
    twilioNumber = params.get("To") || FORWARD_TO
    callerPhone = params.get("From") || ""
  } catch (e) {
    console.error("[voice] Failed to parse Twilio body:", e)
  }

  if (callerPhone) {
    const source = getCampaignSource(twilioNumber)
    // Landing-page Google Ads number gets its own source_type + drip path.
    // Everything else (MFM-A/B, outbound callback) stays on direct-mail.
    const isGoogleAds = twilioNumber === "+16506703914"
    // Blocked / withheld caller ID — every such call arrives as the same
    // placeholder ("Anonymous" etc.), so it's NOT a usable contact key.
    const isAnon = isAnonymousCaller(callerPhone)
    // AWAIT the insert — must complete before the function exits.
    try {
      const sb = getLeadsClient()

      // For a known number, look up the most recent inbound row for this
      // caller (no time window) so the new event row inherits the cluster's
      // identity: lifecycle status (parked nurture / contacted / active
      // leads stay in their lifecycle bucket), source / source_type (cluster
      // stays in its original campaign), and drip_campaign_type (the drip
      // engine queries on drip_campaign_type IS NOT NULL — a second row for
      // the same lead would double-fire touches).
      //
      // SKIP this for anonymous callers — they all share one placeholder
      // value, so inheriting would cross-contaminate unrelated people's
      // status / source / drip stamp.
      const { data: existingRows } = isAnon
        ? { data: null }
        : await sb
            .from("leads")
            .select("id, source, source_type, drip_campaign_type, status")
            .eq("caller_phone", callerPhone)
            .not("twilio_number", "is", null)
            .order("created_at", { ascending: false })
            .limit(1)
      const existingRow = existingRows?.[0] ?? null
      const inheritedStatus: LeadStatus =
        (existingRow?.status as LeadStatus | undefined) ?? "new"

      const insertRow: Record<string, unknown> = {
        source: existingRow?.source || source,
        source_type:
          existingRow?.source_type || (isGoogleAds ? "google_ads" : "direct_mail"),
        twilio_number: twilioNumber,
        caller_phone: callerPhone,
        lead_type: "call",
        status: inheritedStatus,
      }
      if (isAnon) {
        // Junk by default — most blocked-ID calls are spam, and you can't
        // text/call back a withheld number so there's no drip path. If they
        // leave a substantive voicemail, processRecordingBackground
        // un-junks it. No drip stamp; groupLeads keys this row by id so it
        // never merges with other anonymous calls.
        insertRow.is_junk = true
      } else if (!existingRow) {
        // Phase 7B: stamp drip campaign on intake. The engine's hourly
        // scan will pick up touch 0 (15-min missed-call message) when no
        // recording arrives within the buffer, and touch 1 onward at
        // each cadence step. Google Ads landing-page calls skip the
        // missed-call template and run the AI-drafted google_ads_form
        // cadence from touch 1.
        insertRow.drip_campaign_type = isGoogleAds ? "google_ads_form" : "direct_mail_call"
        insertRow.drip_touch_number = 0
        insertRow.last_drip_sent_at = new Date().toISOString()
      } else if (existingRow.drip_campaign_type) {
        // Carry the cluster's drip campaign forward without resetting the
        // clock — the original intake row owns drip_touch_number /
        // last_drip_sent_at; this row is event history only.
        insertRow.drip_campaign_type = existingRow.drip_campaign_type
      }

      const { error } = await sb.from("leads").insert(insertRow)
      if (error) console.error("[voice] Supabase insert failed:", error)
    } catch (e) {
      console.error("[voice] Supabase insert threw:", e)
    }
    // Telegram stays fire-and-forget — sendTelegramAlert is best-effort.
    void sendTelegramAlert(`📞 New lead call — <b>${source}</b> — ${callerPhone}`)
  }

  return new NextResponse(buildTwiml(twilioNumber), {
    headers: { "Content-Type": "text/xml" },
  })
}

export async function GET() {
  // GET fallback — no Twilio body, just return the dial TwiML
  return new NextResponse(buildTwiml(FORWARD_TO), {
    headers: { "Content-Type": "text/xml" },
  })
}
