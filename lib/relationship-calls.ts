// Relationships-tab click-to-call (2026-09-23). Ryan: "I actually would like
// to record these calls and add the transcription to CRMS — useful for notes
// on how calls went."
//
// Flow: /api/crms/call inserts a `call` touch and asks Twilio to ring Ryan's
// cell; when he answers, /api/crms/call/bridge <Dial>s the contact with
// Ryan's own (Twilio-verified) cell as caller ID and records from answer;
// /api/crms/call/status stamps the outcome; /api/crms/call/recording hands
// the audio to processRelationshipRecording below, which transcribes it,
// writes a CRMS-flavoured summary, appends the dated call line to the
// contact's notes (same format Log Call writes) and bumps the cadence.

import { getLeadsClient, fetchTwilioAudio, transcribeAudio, sendTelegramAlert, FORWARD_TO } from "./leads"
import { completeText, hasLlmKey, HAIKU } from "./llm"
import { isPlaceholderName } from "./office-inbound"
import { sendCampaignAlert } from "./campaignAlerts"
import { isValidCategory } from "./crms"

export const PROD_BASE = "https://mission-control-three-chi.vercel.app"

// The number the contact sees. Must be a Twilio Verified Caller ID (Ryan's
// cell +14085006293 is, checked 2026-09-23) — Twilio rejects the <Dial>
// otherwise. Env override for the day that changes.
export function relationshipCallerId(): string {
  return process.env.CRMS_CALL_CALLER_ID?.trim() || FORWARD_TO
}

export const CALL_OUTCOME_PREFIX = "📵 "
export const MIN_TRANSCRIBE_SEC = 15
// A voicemail is worth transcribing well under the live-call floor — "it's
// Kelly, call me back" is 4 seconds and exactly what Ryan needs on the card.
export const MIN_VOICEMAIL_TRANSCRIBE_SEC = 3

export type RelationshipCallKind = "outbound" | "inbound" | "voicemail"
// Which Twilio line the inbound call came in on: the business-card office
// lines, or the agents line (650) 910-4007 whose alerts ride the campaign bot
// and whose summaries mirror onto the campaign timeline (2026-10-01).
export type CallLine = "office" | "agents"

export function callOutcomeMessage(status: string): string | null {
  switch (status) {
    case "no-answer": return `${CALL_OUTCOME_PREFIX}No answer — rang out`
    case "busy": return `${CALL_OUTCOME_PREFIX}Busy`
    case "failed": return `${CALL_OUTCOME_PREFIX}Call failed — did not connect`
    case "canceled": return `${CALL_OUTCOME_PREFIX}Call canceled before it connected`
    default: return null
  }
}

function stamp(): string {
  return new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" })
}

// Log Call's note format — enrichment + the draft prompt already read it.
export async function appendCallNote(relationshipId: string, note: string): Promise<boolean> {
  const sb = getLeadsClient()
  const { data: cur } = await sb.from("relationships").select("notes").eq("id", relationshipId).single()
  const line = `[${stamp()} call] ${note.trim()}`
  const prev = String(cur?.notes ?? "").trim()
  const notes = prev ? `${prev}\n\n${line}` : line
  const { error } = await sb
    .from("relationships")
    .update({ notes, enriched_at: new Date().toISOString() })
    .eq("id", relationshipId)
  if (error) console.error("[crms/call] notes append failed:", error.message)
  return !error
}

async function summarizeRelationshipCall(name: string, category: string | null, transcript: string, kind: RelationshipCallKind = "outbound", line: CallLine = "office"): Promise<string | null> {
  if (!hasLlmKey()) return null
  const who = category ? `${name} (${category})` : name
  const lineDesc = line === "agents"
    ? `Ryan LaRocca's agents line — the number in his buyer-outreach emails to real estate agents (Ryan is a real estate investor, LRG Homes, buying single-family and 2-15 unit multifamily in the Bay Area). The caller is almost certainly a real estate agent responding to that email, often with a listing or a question about his buy box, not a seller lead`
    : `Ryan LaRocca's office line (Ryan is a real estate investor, LRG Homes). The caller is someone in his network or someone who has his business card — an agent, vendor, inspector, property manager, investor or friend, not a lead`
  const what =
    kind === "voicemail"
      ? `a voicemail ${who} left on ${lineDesc}`
      : kind === "inbound"
        ? `a phone call ${who} placed to ${lineDesc}`
        : `a phone call between Ryan LaRocca (a real estate investor, LRG Homes) and ${who}, someone in his network — an agent, vendor, property manager, investor or friend, not a lead`
  const prompt = `You are writing the CRM note for ${what}. Write the note Ryan will read the next time this person comes up in his outreach queue. Plain prose, no labels, no markdown, no bullets, no quotes.

Length scales with the call: a quick "call me back" is one sentence; a real conversation is one short paragraph (up to ~6 sentences). Never pad.

Capture, when present: what's going on in their life or business right now, any deal, property, referral or favor discussed (with specifics — addresses, prices, unit counts, rents), anything they asked Ryan for, anything Ryan promised, and the agreed next step or date. Anchor on how the call ended. If the recording is just a voicemail greeting or dead air, say so in a few words.

TRANSCRIPT:
"${transcript}"`
  try {
    const out = await completeText({ model: HAIKU, prompt, maxTokens: 600, tag: "[crms/call summarize]" })
    return out.text?.replace(/^["'`]+|["'`]+$/g, "").trim() || null
  } catch (e) {
    console.error("[crms/call] summarize failed:", e instanceof Error ? e.message : String(e))
    return null
  }
}

// For a contact we only know by phone number (created by the office-line
// resolver), pull the caller's name + best-fit category out of what they
// said. Null when they never identified themselves. Never overwrites a
// real name — the caller checks isPlaceholderName first.
async function identifyCallerFromTranscript(transcript: string): Promise<{ name: string | null; category: string | null }> {
  if (!hasLlmKey()) return { name: null, category: null }
  const prompt = `Someone called Ryan LaRocca's real-estate office line. From the transcript below, extract the caller's name and which of these categories fits them best: Agent (real estate agent/broker), Vendor (inspector, contractor, lender, title, any service provider), PM (property manager), Investor, PrivateMoney (private lender), Personal (friend/family). Ryan LaRocca is the person being called — never return his name.

Reply with ONLY a JSON object: {"name": "<first and last name as spoken, or null>", "category": "<one of Agent|Vendor|PM|Investor|PrivateMoney|Personal, or null>"}. Use null when the transcript doesn't say.

TRANSCRIPT:
"${transcript.slice(0, 4000)}"`
  try {
    const out = await completeText({ model: HAIKU, prompt, maxTokens: 120, tag: "[crms/call identify]" })
    const m = out.text?.match(/\{[\s\S]*\}/)
    if (!m) return { name: null, category: null }
    const j = JSON.parse(m[0]) as { name?: unknown; category?: unknown }
    const name = typeof j.name === "string" && j.name.trim().length >= 2 && !/laroc/i.test(j.name) ? j.name.trim().slice(0, 80) : null
    const category = typeof j.category === "string" && isValidCategory(j.category) ? j.category : null
    return { name, category }
  } catch (e) {
    console.warn("[crms/call] identify failed:", e instanceof Error ? e.message : String(e))
    return { name: null, category: null }
  }
}

export async function processRelationshipRecording(args: {
  touchId: string
  relationshipId: string
  fullUrl: string
  recordingDurationSec: number | null
  kind?: RelationshipCallKind
  line?: CallLine
  // Agents line only: mirror the summary onto the campaign timeline
  // (campaign_events) so the Email Drip contact card tells the same story.
  campaign?: { contactId: string | null; callSid: string | null }
}): Promise<void> {
  const { touchId, relationshipId, fullUrl, recordingDurationSec } = args
  const kind: RelationshipCallKind = args.kind ?? "outbound"
  const line: CallLine = args.line ?? "office"
  const sb = getLeadsClient()
  const alert = line === "agents" ? (text: string) => sendCampaignAlert(sb, text) : sendTelegramAlert
  const mirror = async (summary: string) => {
    if (line !== "agents" || !args.campaign) return
    try {
      await mirrorCampaignTimeline(sb, { ...args.campaign, kind, summary, durationSec: recordingDurationSec, recordingUrl: fullUrl })
    } catch (e) {
      console.error("[crms/call] campaign timeline mirror failed:", e instanceof Error ? e.message : String(e))
    }
  }
  let name = "a contact"
  let category: string | null = null
  let phone: string | null = null
  try {
    const { data } = await sb.from("relationships").select("name, category, phone").eq("id", relationshipId).single()
    if (data) { name = data.name || name; category = data.category ?? null; phone = (data.phone as string | null) ?? null }
  } catch {}
  const label = kind === "voicemail" ? "Voicemail from" : kind === "inbound" ? "Call from" : "Call with"

  // Under MIN_TRANSCRIBE_SEC there was no conversation — a voicemail
  // greeting, a wrong-number hang-up, a test call. Not worth a Whisper +
  // Haiku round trip; stamp the touch and leave notes alone (Ryan, 2026-09-23).
  const floor = kind === "voicemail" ? MIN_VOICEMAIL_TRANSCRIBE_SEC : MIN_TRANSCRIBE_SEC
  if (recordingDurationSec !== null && recordingDurationSec < floor) {
    const short = kind === "voicemail"
      ? `${CALL_OUTCOME_PREFIX}Voicemail ${recordingDurationSec}s — too short to transcribe (hang-up)`
      : `${CALL_OUTCOME_PREFIX}Connected ${recordingDurationSec}s — too short to transcribe (voicemail or hang-up)`
    const { error } = await sb
      .from("relationship_touches")
      .update({ message: short })
      .eq("id", touchId)
    if (error) console.error("[crms/call] short-call stamp failed:", error.message)
    if (kind !== "outbound") await alert(`📵 ${label} ${name}: ${recordingDurationSec}s, nothing to transcribe.`)
    await mirror(short.replace(CALL_OUTCOME_PREFIX, ""))
    return
  }

  try {
    // Same encoding-lag + partial-file guard as the Leads pipeline.
    await new Promise(r => setTimeout(r, 10_000))
    let audio = await fetchTwilioAudio(fullUrl)
    const expectedBytes = recordingDurationSec && recordingDurationSec > 0 ? Math.floor(recordingDurationSec * 3600) : 0
    let partial = !!audio && expectedBytes > 0 && audio.length < expectedBytes
    for (let i = 1; i <= 3 && partial; i++) {
      await new Promise(r => setTimeout(r, 15_000))
      const again = await fetchTwilioAudio(fullUrl)
      if (again && again.length > audio!.length) audio = again
      partial = !!audio && audio.length < expectedBytes
    }
    if (partial || !audio) {
      const why = !audio ? "audio download failed" : "audio still partial after retries"
      console.error(`[crms/call] touch ${touchId}: ${why}`)
      await alert(`⚠️ ${label} ${name} recorded, but ${why} — transcript not saved. Recording: ${fullUrl}`)
      return
    }

    const transcript = await transcribeAudio(audio, "relationship-call.mp3")
    if (!transcript) {
      await alert(`⚠️ ${label} ${name}: transcription failed — nothing saved to notes. Recording: ${fullUrl}`)
      return
    }

    // Office-line contact we only know by number: let the transcript name
    // them. Only a placeholder name is ever replaced; category only moves
    // off the default when the caller said what they do.
    let identified = ""
    if (kind !== "outbound" && phone && isPlaceholderName(name, phone)) {
      const who = await identifyCallerFromTranscript(transcript)
      const patch: Record<string, string> = {}
      if (who.name) { patch.name = who.name; name = who.name }
      if (who.category && who.category !== category) { patch.category = who.category; category = who.category }
      if (Object.keys(patch).length > 0) {
        const { error } = await sb.from("relationships").update(patch).eq("id", relationshipId)
        if (error) console.error("[crms/call] identify update failed:", error.message)
        else identified = `\n\n🆕 Card updated from the call: ${[patch.name && `name → ${patch.name}`, patch.category && `category → ${patch.category}`].filter(Boolean).join(", ")}. Fix it on the card if that's wrong.`
      } else {
        identified = "\n\n🆕 New contact — they didn't give a name. Set it on the card."
      }
    }

    const summary = (await summarizeRelationshipCall(name, category, transcript, kind, line)) ?? transcript.slice(0, 600)

    const { error: touchErr } = await sb
      .from("relationship_touches")
      .update({ transcript, message: summary, ...(kind === "outbound" ? { action: "sent" } : {}) })
      .eq("id", touchId)
    if (touchErr) console.error("[crms/call] touch update failed:", touchErr.message)

    const noted = await appendCallNote(relationshipId, kind === "voicemail" ? `Voicemail: ${summary}` : summary)
    if (!noted) await alert(`⚠️ ${label} ${name}: summary saved on the touch but the notes append failed.`)

    const icon = kind === "voicemail" ? "📨" : "📞"
    await alert(`${icon} ${label} ${name}${recordingDurationSec ? ` (${Math.max(1, Math.round(recordingDurationSec / 60))} min)` : ""}\n\n${summary}${identified}`)
    await mirror(summary)
  } catch (e) {
    console.error("[crms/call] pipeline threw:", e)
    await alert(`⚠️ ${label} ${name}: transcript pipeline crashed (${e instanceof Error ? e.message : String(e)}). Recording: ${fullUrl}`)
  }
}

// Agents line: keep the campaign timeline (campaign_events — what the Email
// Drip contact card shows) in step with the Relationships card. An answered
// call already has its call_answered row from /api/campaign/voice/status;
// attach the summary to it. A voicemail gets its own row.
async function mirrorCampaignTimeline(
  sb: ReturnType<typeof getLeadsClient>,
  args: { contactId: string | null; callSid: string | null; kind: RelationshipCallKind; summary: string; durationSec: number | null; recordingUrl: string }
): Promise<void> {
  const { contactId, callSid, kind, summary, durationSec, recordingUrl } = args
  if (kind === "voicemail") {
    const { error } = await sb.from("campaign_events").insert({
      contact_id: contactId,
      kind: "voicemail",
      duration_seconds: durationSec,
      body: summary.slice(0, 2000),
      ai_summary: summary.slice(0, 2000),
      raw: { recording_url: recordingUrl, call_sid: callSid, via: "relationship-card" },
    })
    if (error) throw new Error(error.message)
    return
  }
  if (callSid) {
    const { data: rows } = await sb
      .from("campaign_events")
      .select("id")
      .eq("kind", "call_answered")
      .filter("raw->>call_sid", "eq", callSid)
      .limit(1)
    if (rows?.[0]?.id) {
      const { error } = await sb.from("campaign_events").update({ ai_summary: summary.slice(0, 2000) }).eq("id", rows[0].id)
      if (error) throw new Error(error.message)
      return
    }
  }
  const { error } = await sb.from("campaign_events").insert({
    contact_id: contactId,
    kind: "call_answered",
    duration_seconds: durationSec,
    body: `answered call${durationSec ? `, ${durationSec}s` : ""}`,
    ai_summary: summary.slice(0, 2000),
    raw: { recording_url: recordingUrl, call_sid: callSid, via: "relationship-card" },
  })
  if (error) throw new Error(error.message)
}
