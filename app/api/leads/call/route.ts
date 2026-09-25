import { NextRequest, NextResponse } from "next/server"
import { FORWARD_TO, getLeadsClient, getTwilioNumber, isOwnedNumber, registerManualTouch, resolveReplyLine } from "@/lib/leads"
import { relationshipCallerId } from "@/lib/relationship-calls"

// Outbound call relay. Click "Call" on a lead card →
//   1. Insert an outbound `lead_type=call` row (twilio_number=null per the
//      outbound convention; status="contacted") so the timeline shows it
//      immediately.
//   2. POST to Twilio's REST API to dial Ryan's cell. The from-number is
//      the line the lead originally called/texted (resolveReplyLine) —
//      Ryan's cell shows which line the lead knows — falling back to the
//      `TWILIO_NUMBER` env when the lead has never contacted a line.
//   3. When Ryan answers, Twilio fetches the bridge URL (TwiML) which
//      `<Dial>`s the lead's number with record-from-answer and the SAME
//      line as callerId, so the lead sees the number on their postcard,
//      not a stranger (Ryan, 2026-09-22 — same rule as texts). Recording is
//      delivered back to /api/leads/call/recording?leadId=… which attaches
//      it to the row inserted in step 1.
//
// "My Cell" leads (use_personal_cell on the phone cluster, 2026-09-25):
//   the lead already knows Ryan personally, so the <Dial> leg presents
//   Ryan's own Twilio-verified cell as caller ID — the same number the
//   Relationships bridge uses — instead of a business line. Everything
//   else (ring Ryan first, record, transcribe, summarise onto the card)
//   is unchanged. Ryan: "apply the same plumbing to these leads when I
//   move them over to my cell."
//
// Bridge URL has to be publicly reachable — it's hardcoded to the prod
// alias same as the inbound voice routes do (RECORDING_CALLBACK_URL).
//
// We use fetch + Basic Auth for the Twilio REST call instead of pulling in
// the twilio SDK (consistent with how `fetchTwilioAudio` already works).

const PROD_BASE = "https://mission-control-three-chi.vercel.app"

function normalizeE164(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.startsWith("+") && /^\+\d{10,15}$/.test(trimmed)) return trimmed
  const digits = trimmed.replace(/\D/g, "")
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`
  return null
}

export async function POST(request: NextRequest) {
  let body: { phone?: string; source?: string | null } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const phoneInput = body.phone
  if (!phoneInput || typeof phoneInput !== "string") {
    return NextResponse.json({ error: "phone is required" }, { status: 400 })
  }
  const leadPhone = normalizeE164(phoneInput)
  if (!leadPhone) {
    return NextResponse.json({ error: `Invalid phone: ${phoneInput}` }, { status: 400 })
  }

  // Refuse to dial ourselves. A phantom lead row can carry one of our own
  // Twilio numbers as caller_phone (see isOwnedNumber), and clicking Call on
  // it rang LRG's own voicemail while logging more phantom rows on both legs
  // (2026-09-03). The webhook guards stop new ones being created; this stops
  // the 33 rows already in the table from being dialed.
  if (isOwnedNumber(leadPhone)) {
    return NextResponse.json(
      {
        error:
          `${leadPhone} is one of our own Twilio numbers, so this lead card is a phantom — ` +
          `the real contact number is in the message body. Not dialing.`,
      },
      { status: 400 }
    )
  }

  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !token) {
    return NextResponse.json(
      { error: "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set" },
      { status: 500 }
    )
  }
  let fromNumber: string
  try {
    fromNumber = getTwilioNumber()
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
  // Present the line the lead already knows. Voice caller ID has no A2P
  // registration requirement, so any line we own is usable as-is.
  try {
    const line = await resolveReplyLine(getLeadsClient(), leadPhone)
    if (line) fromNumber = line
  } catch (e) {
    console.error("[leads/call] reply-line lookup threw:", e)
  }

  // "My Cell" lead → present Ryan's verified cell to the lead. Checked by
  // phone cluster, same as sendLeadSms' transport pick. The first leg (ring
  // Ryan) still comes From the business line — Twilio can't dial his cell
  // From his own cell.
  let callerId = fromNumber
  try {
    const { data: pcRows } = await getLeadsClient()
      .from("leads")
      .select("id")
      .eq("caller_phone", leadPhone)
      .eq("use_personal_cell", true)
      .limit(1)
    if (pcRows && pcRows.length > 0) callerId = relationshipCallerId()
  } catch (e) {
    console.error("[leads/call] personal-cell check threw:", e)
  }

  // Insert the outbound call row first so we have a leadId to thread
  // through to the recording callback. twilio_number=null (outbound marker
  // per lib/leads.ts conventions); source is inherited from the group if
  // the UI passed it.
  let leadId: string | null = null
  try {
    const sb = getLeadsClient()
    const { data, error } = await sb
      .from("leads")
      .insert({
        source: body.source ?? null,
        twilio_number: null,
        caller_phone: leadPhone,
        lead_type: "call",
        status: "contacted",
      })
      .select("id")
      .single()
    if (error) {
      console.error("[leads/call] Insert failed:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    leadId = data?.id ?? null
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[leads/call] Insert threw:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  if (!leadId) {
    return NextResponse.json({ error: "Failed to create lead row" }, { status: 500 })
  }

  const bridgeUrl =
    `${PROD_BASE}/api/leads/call/bridge` +
    `?leadPhone=${encodeURIComponent(leadPhone)}` +
    `&leadId=${encodeURIComponent(leadId)}` +
    `&callerId=${encodeURIComponent(callerId)}`

  const auth = Buffer.from(`${sid}:${token}`).toString("base64")
  const form = new URLSearchParams({
    To: FORWARD_TO,
    From: fromNumber,
    Url: bridgeUrl,
    Method: "POST",
  })

  let callSid: string | null = null
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      }
    )
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      const errMsg = (json as { message?: string })?.message || `HTTP ${res.status}`
      console.error("[leads/call] Twilio call create failed:", errMsg, json)
      // Roll back the row so we don't leave a dangling outbound entry.
      try {
        const sb = getLeadsClient()
        await sb.from("leads").delete().eq("id", leadId)
      } catch (e) {
        console.error("[leads/call] Rollback delete threw:", e)
      }
      return NextResponse.json({ error: errMsg }, { status: 502 })
    }
    callSid = (json as { sid?: string })?.sid ?? null
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[leads/call] Twilio fetch threw:", msg)
    try {
      const sb = getLeadsClient()
      await sb.from("leads").delete().eq("id", leadId)
    } catch (rollbackErr) {
      console.error("[leads/call] Rollback delete threw:", rollbackErr)
    }
    return NextResponse.json({ error: msg }, { status: 502 })
  }

  // 2026-05-11 — mirror the send route's behavior: after a successful
  // outbound contact (Twilio accepted the call), promote the original
  // intake row from "new" → "contacted" so the group status the UI
  // derives reflects that Ryan reached out. Without this, the most
  // recent inbound row stayed "new" and groupLeads' statusSource
  // (`mostRecentInbound || mostRecent`) pinned the group to "new",
  // which made the New filter show leads Ryan had already called.
  try {
    const sb = getLeadsClient()
    const { data: intake } = await sb
      .from("leads")
      .select("id, status")
      .eq("caller_phone", leadPhone)
      .not("twilio_number", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
    const intakeRow = intake?.[0]
    if (intakeRow && intakeRow.status === "new") {
      const { error: promoteErr } = await sb
        .from("leads")
        .update({ status: "contacted" })
        .eq("id", intakeRow.id)
      if (promoteErr) console.error("[leads/call] Status promote failed:", promoteErr)
    }
  } catch (e) {
    // Best-effort — never fail the call response on a promote glitch.
    console.error("[leads/call] Status promote threw:", e)
  }

  // A placed outbound call is a manual touch — it stands in for the next
  // drip. Reset the cadence clock + skip any pending/approved drip on the
  // cluster so a contact Ryan just called isn't left pinned to the top of
  // the Follow Ups queue by a stale drip. Best-effort: the call already
  // went through; a missed reset just re-surfaces on the next engine pass.
  try {
    const sb = getLeadsClient()
    await registerManualTouch(sb, { id: leadId, caller_phone: leadPhone, email: null })
  } catch (e) {
    console.error("[leads/call] manual-touch cadence reset threw:", e)
  }

  return NextResponse.json({ success: true, callSid, leadId, from: fromNumber, callerId })
}
