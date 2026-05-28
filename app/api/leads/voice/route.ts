import { NextResponse } from "next/server"
import {
  FORWARD_TO,
  OUTBOUND_TWILIO_NUMBER,
  dedupeClusterStamps,
  getCampaignSource,
  getLeadsClient,
  type LeadStatus,
  lookupLeadName,
  parseTwilioBody,
  sendTelegramAlert,
} from "@/lib/leads"
import { isAnonymousCaller } from "@/lib/anonymous"
import { scoreLeadSpam, spamAlertLines, spamReviewColumns, type SpamScore } from "@/lib/lead-spam"

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
    // A callback to the outbound caller-ID number is a lead responding to
    // outreach Ryan already started by hand — not a fresh direct-mail
    // lead. It must NOT get a fresh drip stamp.
    const isOutboundCallback = twilioNumber === OUTBOUND_TWILIO_NUMBER
    // Blocked / withheld caller ID — every such call arrives as the same
    // placeholder ("Anonymous" etc.), so it's NOT a usable contact key.
    const isAnon = isAnonymousCaller(callerPhone)
    // Fake-lead score — assigned inside the try once `existingRow` is
    // known, and read again at the Telegram alert below (outside the try),
    // so it has to be declared out here.
    let spam: SpamScore | null = null
    // Lead name for the Telegram alert label — resolved inside the try once
    // we have a client; null for an unknown / anonymous caller.
    let leadName: string | null = null
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
      // Best-effort name for the alert — only for known callers with a prior row.
      if (!isAnon && existingRow) leadName = await lookupLeadName(sb, callerPhone)
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
        if (!isOutboundCallback) {
          // Phase 7B: stamp drip campaign on intake. The engine's hourly
          // scan picks up touch 0 (15-min missed-call message) for a
          // direct_mail_call lead — that touch is gated on
          // `drip_touch_number IS NULL`, so we stamp NULL here, not 0.
          // (0 means "touch #0 already done"; stamping 0 on intake
          // silently killed the missed-call opener for every lead.)
          // Google Ads landing-page calls skip touch #0 and run the
          // AI-drafted google_ads_form cadence from touch 1.
          insertRow.drip_campaign_type = isGoogleAds ? "google_ads_form" : "direct_mail_call"
          insertRow.drip_touch_number = null
          insertRow.last_drip_sent_at = new Date().toISOString()
        }
        // else: a first-ever contact via the outbound callback number —
        // insert a plain event row, no drip stamp.
      } else if (existingRow.drip_campaign_type) {
        // Carry the cluster's drip campaign forward without resetting the
        // clock — the original intake row owns drip_touch_number /
        // last_drip_sent_at; this row is event history only. The cluster
        // is de-duped after insert so the engine sees ONE driver row.
        insertRow.drip_campaign_type = existingRow.drip_campaign_type
      }

      // Score the caller's number for fake-lead red flags — Google Ads
      // leads only for now, fresh + non-anonymous calls only. (Anonymous
      // calls are already junked above; a known returning caller must not
      // be re-flagged.) A call carries only a phone at intake.
      if (isGoogleAds && !isAnon && !existingRow) {
        spam = scoreLeadSpam({ phone: callerPhone })
        if (spam.suspicious) Object.assign(insertRow, spamReviewColumns(spam))
      }

      const { data: insertedRow, error } = await sb
        .from("leads")
        .insert(insertRow)
        .select("id")
        .single()
      if (error) console.error("[voice] Supabase insert failed:", error)

      // Re-engagement carried the cluster's drip stamp onto this new event
      // row. Sweep the cluster so exactly ONE row drives the drip engine —
      // N stamped rows would queue N parallel touches. No-op when the
      // cluster has ≤1 stamped row.
      if (existingRow?.drip_campaign_type) {
        try {
          await dedupeClusterStamps(sb, { caller_phone: callerPhone, email: null })
        } catch (e) {
          console.warn("[voice] cluster dedupe failed:", e instanceof Error ? e.message : String(e))
        }
      }

      // Campaign attribution — best-effort.
      if (insertedRow?.id) {
        try {
          const { resolveCampaignId } = await import("@/lib/campaigns")
          const campaignId = await resolveCampaignId({
            source: (insertRow.source as string) ?? source,
            source_type: (insertRow.source_type as string) ?? (isGoogleAds ? "google_ads" : "direct_mail"),
            created_at: new Date(),
          })
          if (campaignId) {
            await sb.from("leads").update({ campaign_id: campaignId }).eq("id", insertedRow.id)
          }
        } catch (e) {
          console.warn("[voice] campaign attribution failed:", e instanceof Error ? e.message : String(e))
        }
      }
    } catch (e) {
      console.error("[voice] Supabase insert threw:", e)
    }
    // Await so Vercel doesn't kill the in-flight fetch when the response returns.
    const callWho = leadName ? `<b>${leadName}</b> — ${callerPhone}` : callerPhone
    const callAlert = [`📞 New lead call — <b>${source}</b> — ${callWho}`]
    // Append the fake-lead warning to the same note — no-op when clean.
    if (spam) callAlert.push(...spamAlertLines(spam))
    await sendTelegramAlert(callAlert.join("\n"))
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
