import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient, parseTwilioBody } from "@/lib/leads"
import { sendCampaignAlert } from "@/lib/campaignAlerts"
import { PROD_BASE, callOutcomeMessage } from "@/lib/relationship-calls"

// Agents line — post-<Dial> action.
//
// With a touchId (caller resolved to a Relationships card, 2026-10-01):
//   answered → the live recording is already on its way to
//              /api/crms/call/recording (transcript + summary → card notes +
//              campaign timeline). Stamp the touch + last_contacted_at, log
//              call_answered, Telegram follow-up.
//   missed   → stamp the touch, log call_missed, play Ryan's greeting and
//              record a voicemail whose <Record action> posts to the same
//              recording route with voicemail=1.
// Without a touchId (existing lead / resolver fallback): the pre-10-01
// path — metadata only, voicemail via the campaign recording route.

export const dynamic = "force-dynamic"

const GREETING_URL = `${PROD_BASE}/voicemail-greeting.mp3`
const LEGACY_RECORDING_CALLBACK = `${PROD_BASE}/api/campaign/voice/recording`
const EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response/>'

function xml(body: string): NextResponse {
  return new NextResponse(body, { headers: { "Content-Type": "text/xml" } })
}

function cardVoicemailTwiml(touchId: string, campaignContactId: string | null): string {
  const q = `?touchId=${encodeURIComponent(touchId)}&voicemail=1&line=agents${campaignContactId ? `&campaignContactId=${encodeURIComponent(campaignContactId)}` : ""}`
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${GREETING_URL}</Play>
  <Record maxLength="120" timeout="5" playBeep="true" transcribe="false" action="${PROD_BASE}/api/crms/call/recording${q}" method="POST" />
  <Say voice="alice">Thank you. Goodbye.</Say>
</Response>`
}

// Ryan's own recorded greeting (reused from the MFM mailer campaign — his
// call, 2026-07-23). Hosted in /public. If the asset ever fails to load,
// Twilio skips the <Play> and still records after the beep.
function legacyVoicemailTwiml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${GREETING_URL}</Play>
  <Record maxLength="120" playBeep="true" recordingStatusCallback="${LEGACY_RECORDING_CALLBACK}" recordingStatusCallbackMethod="POST" transcribe="true" transcribeCallback="${PROD_BASE}/api/campaign/voice/transcription"/>
</Response>`
}

export async function POST(request: NextRequest) {
  const touchId = request.nextUrl.searchParams.get("touchId")
  const campaignContactId = request.nextUrl.searchParams.get("campaignContactId")
  let params: URLSearchParams
  try {
    params = parseTwilioBody(await request.text())
  } catch {
    params = new URLSearchParams()
  }
  const from = params.get("From") || ""
  const digits = from.replace(/\D/g, "").slice(-10)
  const dialStatus = params.get("DialCallStatus") || ""
  const duration = Number(params.get("DialCallDuration") || 0)
  const callSid = params.get("CallSid") || null

  const sb = getLeadsClient()
  const { data } = await sb
    .from("campaign_contacts")
    .select("id, name, touch_number")
    .or(`phone.eq.${digits},alt_phones.cs.{${digits}}`)
    .limit(1)
  const contact = data?.[0] ?? null
  const contactId = contact?.id ?? campaignContactId ?? null
  const fmt = digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : from
  let who = contact?.name ? `${contact.name} ${fmt}` : fmt
  let relationshipId: string | null = null

  if (touchId) {
    const answered = dialStatus === "completed" && duration > 0
    const outcome = answered ? null : callOutcomeMessage(dialStatus)
    const message = answered
      ? "📲 Inbound call — connected, transcribing…"
      : `📨 Inbound call — went to voicemail${outcome ? ` (${outcome.replace(/^📵 /, "")})` : ""}`
    const { data: t, error } = await sb
      .from("relationship_touches")
      .update({ call_status: answered ? "completed" : "voicemail", call_duration_sec: duration || null, message })
      .eq("id", touchId)
      .is("transcript", null)
      .select("relationship_id")
      .single()
    if (error) console.error("[campaign-voice/status] touch stamp failed:", error.message)
    relationshipId = (t?.relationship_id as string | null) ?? null
    if (relationshipId) {
      const { data: rel } = await sb.from("relationships").select("name").eq("id", relationshipId).single()
      if (rel?.name && !contact?.name) who = `${rel.name} ${fmt}`
      if (answered) {
        const { error: lcErr } = await sb.from("relationships").update({ last_contacted_at: new Date().toISOString() }).eq("id", relationshipId)
        if (lcErr) console.error("[campaign-voice/status] last_contacted_at failed:", lcErr.message)
      }
    }
  }

  if (dialStatus === "completed" && duration > 0) {
    await sb.from("campaign_events").insert({
      contact_id: contactId,
      kind: "call_answered",
      caller_number: digits || null,
      duration_seconds: duration,
      body: `answered call, ${duration}s`,
      raw: { from, dial_status: dialStatus, call_sid: callSid, touch_id: touchId },
    })
    await sendCampaignAlert(sb,
      `📞 Talked to <b>${who}</b> — ${Math.floor(duration / 60)}m${duration % 60}s on the agents line.${touchId ? " Summary lands on their Relationships card + here in a minute." : " Timeline updated;"} Drip continues as scheduled.`
    )
    return xml(EMPTY)
  }

  // Missed — alert (a ring with no follow-up reads as 'went blank'), then
  // roll to voicemail. If they leave one, its own alert follows.
  await sb.from("campaign_events").insert({
    contact_id: contactId,
    kind: "call_missed",
    caller_number: digits || null,
    body: `missed call (${dialStatus})`,
    raw: { from, dial_status: dialStatus, call_sid: callSid, touch_id: touchId },
  })
  await sendCampaignAlert(sb,
    `📵 <b>Missed call on the agents line</b> — <b>${who}</b>${contact ? ` (after T${contact.touch_number})` : ""} — sent to voicemail; recording will follow if they leave one. Call back: ${fmt}`,
    { buttons: digits.length === 10 ? [{ text: "📞 Call back", data: `call:${digits}` }] : undefined }
  )
  return xml(touchId ? cardVoicemailTwiml(touchId, contactId) : legacyVoicemailTwiml())
}
