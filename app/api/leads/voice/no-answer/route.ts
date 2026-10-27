import { NextResponse } from "next/server"
import { waitUntil } from "@vercel/functions"
import {
  CAMPAIGN_MAP,
  SOURCE_OVERRIDE_NUMBERS,
  getLeadsClient,
  isOwnedNumber,
  parseTwilioBody,
  sendTelegramAlert,
} from "@/lib/leads"
import { isAnonymousCaller } from "@/lib/anonymous"
import { PROD_BASE } from "@/lib/relationship-calls"
import {
  anonymousJackieCallsToday,
  decideArm,
  getJackieFlip,
  isKnownCaller,
  jackieDialTwiml,
  leadVoicemailTwiml,
  type ArmDecision,
} from "@/lib/jackie"

// Called when the original Dial leg ends (Ryan answered, declined, or
// didn't pick up). DialCallStatus = "completed" means he answered and the
// call is done — just hang up. Otherwise, play the voicemail greeting and
// record (Record's synchronous `action` → /api/leads/voice/recording; the
// async recordingStatusCallback was not firing reliably, and without an
// action Twilio would re-post here and loop).
//
// Jackie coin flip (NOO Q4 lines, 2026-10-27, lib/jackie.ts): while the flip
// is on, a first-time caller Ryan didn't answer goes to Jackie or voicemail
// 50/50, and every call on those lines gets its arm stamped for the
// scoreboard. Any failure in the flip falls back to today's voicemail.

const HANGUP_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup />
</Response>`

function xml(body: string): NextResponse {
  return new NextResponse(body, { headers: { "Content-Type": "text/xml" } })
}

export async function POST(request: Request) {
  let dialStatus = ""
  let callerPhone = ""
  let twilioNumber = ""
  let dialDuration = 0
  try {
    const body = await request.text()
    const params = parseTwilioBody(body)
    dialStatus = params.get("DialCallStatus") || ""
    callerPhone = params.get("From") || params.get("Caller") || ""
    twilioNumber = params.get("To") || params.get("Called") || ""
    dialDuration = Number(params.get("DialCallDuration") || 0) || 0
  } catch (e) {
    console.error("[no-answer] Failed to parse Twilio body:", e)
  }
  // Press-1 screen (NOO Q4 lines, /api/leads/voice/screen): the voice route
  // passes the intake row. Twilio says "completed" whenever anything picked
  // up Ryan's leg — his carrier voicemail included — so a screened call only
  // counts as answered if he pressed a key (ryan_picked_up_at).
  const url = new URL(request.url)
  const screened = url.searchParams.get("screened") === "1"
  const passedLeadId = url.searchParams.get("leadId")
  let answered = dialStatus === "completed"
  if (!callerPhone || isOwnedNumber(callerPhone)) return xml(answered ? HANGUP_TWIML : leadVoicemailTwiml())

  const sb = getLeadsClient()

  // This call's intake row (written by /api/leads/voice at call start). An
  // answered call can run long before this fires, hence the 4 h window.
  let leadId: string | null = passedLeadId && /^[0-9a-f-]{36}$/i.test(passedLeadId) ? passedLeadId : null
  if (!leadId) {
    try {
      const windowStart = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()
      let lookup = sb
        .from("leads")
        .select("id")
        .eq("caller_phone", callerPhone)
        .gte("created_at", windowStart)
        .order("created_at", { ascending: false })
        .limit(1)
      if (twilioNumber) lookup = lookup.eq("twilio_number", twilioNumber)
      const { data, error } = await lookup
      if (error) console.error("[no-answer] Lookup failed:", error)
      leadId = data?.[0]?.id ?? null
      if (!leadId) console.warn(`[no-answer] No recent lead for ${callerPhone}`)
    } catch (e) {
      console.error("[no-answer] Lookup threw:", e)
    }
  }
  if (screened && answered && leadId) {
    const { data, error } = await sb.from("leads").select("ryan_picked_up_at").eq("id", leadId).maybeSingle()
    if (error) console.error("[no-answer] pick-up stamp read failed:", error.message)
    // Read failure → trust Twilio (today's behaviour) rather than guess.
    else if (!data?.ryan_picked_up_at) {
      answered = false
      console.log(`[no-answer] ${callerPhone}: leg picked up without a key press (carrier voicemail) — treating as missed`)
    }
  }

  // Coin flip — NOO Q4 lines only, only while the switch is on.
  let decision: ArmDecision | null = null
  let anonymous = false
  if (leadId && SOURCE_OVERRIDE_NUMBERS.has(twilioNumber)) {
    try {
      const flip = await getJackieFlip(sb)
      // Test numbers (force_numbers) reach Jackie even with the flip off, so
      // Ryan can try the real mailer-line path before switching it on.
      const forced = (flip.force_numbers ?? []).includes(callerPhone)
      if (flip.on || forced) {
        anonymous = isAnonymousCaller(callerPhone)
        const [known, anonToday] = await Promise.all([
          anonymous || forced ? Promise.resolve(false) : isKnownCaller(sb, callerPhone, leadId),
          anonymous && !answered ? anonymousJackieCallsToday(sb) : Promise.resolve(0),
        ])
        decision = decideArm({ answered, known, anonymous, anonymousJackieToday: anonToday, forced, coin: Math.random() })
      }
    } catch (e) {
      console.error("[no-answer] Jackie flip failed; voicemail as usual:", e)
      await sendTelegramAlert(`⚠️ Jackie coin flip errored for ${callerPhone} — sent to voicemail as usual. ${e instanceof Error ? e.message : String(e)}`.slice(0, 600))
    }
  }

  // Row writes run via waitUntil so Vercel keeps the function alive until
  // they commit (a bare void promise is dropped when the TwiML returns).
  const update: Record<string, unknown> = {}
  if (answered) {
    if (dialDuration > 0) update.call_duration_sec = dialDuration
  } else {
    // Reached voicemail (or Jackie) — the recording callback finds the row
    // by this type.
    update.lead_type = "voicemail"
  }
  if (decision?.arm) update.call_arm = decision.arm
  if (decision?.jackie) {
    update.jackie_call = {
      started_at: new Date().toISOString(),
      anonymous,
      forced: decision.arm === null,
      reason: decision.reason,
    }
  }
  if (leadId && Object.keys(update).length > 0) {
    const id = leadId
    waitUntil((async () => {
      const { error } = await sb.from("leads").update(update).eq("id", id)
      if (error) console.error("[no-answer] Update failed:", error)
    })())
  }

  if (answered) return xml(HANGUP_TWIML)

  if (decision?.jackie && leadId) {
    const line = CAMPAIGN_MAP[twilioNumber] ?? twilioNumber
    await sendTelegramAlert(`🤖 Jackie is taking a call on <b>${line}</b> — ${callerPhone}${decision.arm === null ? " (test number, not scored)" : ""}. Card + summary when she's done.`)
    const q = `leadId=${encodeURIComponent(leadId)}`
    return xml(jackieDialTwiml({
      tags: { line, leadId },
      action: `${PROD_BASE}/api/leads/voice/jackie-done?${q}`,
      recordingCallback: `${PROD_BASE}/api/leads/voice/recording?jackie=1&${q}`,
    }))
  }
  return xml(leadVoicemailTwiml())
}

export async function GET() {
  return xml(leadVoicemailTwiml())
}
