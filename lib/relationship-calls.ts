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

export const PROD_BASE = "https://mission-control-three-chi.vercel.app"

// The number the contact sees. Must be a Twilio Verified Caller ID (Ryan's
// cell +14085006293 is, checked 2026-09-23) — Twilio rejects the <Dial>
// otherwise. Env override for the day that changes.
export function relationshipCallerId(): string {
  return process.env.CRMS_CALL_CALLER_ID?.trim() || FORWARD_TO
}

export const CALL_OUTCOME_PREFIX = "📵 "
export const MIN_TRANSCRIBE_SEC = 15

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

async function summarizeRelationshipCall(name: string, category: string | null, transcript: string): Promise<string | null> {
  if (!hasLlmKey()) return null
  const who = category ? `${name} (${category})` : name
  const prompt = `You are writing the CRM note for a phone call between Ryan LaRocca (a real estate investor, LRG Homes) and ${who}, someone in his network — an agent, vendor, property manager, investor or friend, not a lead. Write the note Ryan will read the next time this person comes up in his outreach queue. Plain prose, no labels, no markdown, no bullets, no quotes.

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

export async function processRelationshipRecording(args: {
  touchId: string
  relationshipId: string
  fullUrl: string
  recordingDurationSec: number | null
}): Promise<void> {
  const { touchId, relationshipId, fullUrl, recordingDurationSec } = args
  const sb = getLeadsClient()
  let name = "a contact"
  let category: string | null = null
  try {
    const { data } = await sb.from("relationships").select("name, category").eq("id", relationshipId).single()
    if (data) { name = data.name || name; category = data.category ?? null }
  } catch {}

  // Under MIN_TRANSCRIBE_SEC there was no conversation — a voicemail
  // greeting, a wrong-number hang-up, a test call. Not worth a Whisper +
  // Haiku round trip; stamp the touch and leave notes alone (Ryan, 2026-09-23).
  if (recordingDurationSec !== null && recordingDurationSec < MIN_TRANSCRIBE_SEC) {
    const { error } = await sb
      .from("relationship_touches")
      .update({ message: `${CALL_OUTCOME_PREFIX}Connected ${recordingDurationSec}s — too short to transcribe (voicemail or hang-up)` })
      .eq("id", touchId)
    if (error) console.error("[crms/call] short-call stamp failed:", error.message)
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
      await sendTelegramAlert(`⚠️ Relationships call with ${name} recorded, but ${why} — transcript not saved. Recording: ${fullUrl}`)
      return
    }

    const transcript = await transcribeAudio(audio, "relationship-call.mp3")
    if (!transcript) {
      await sendTelegramAlert(`⚠️ Relationships call with ${name}: transcription failed — nothing saved to notes. Recording: ${fullUrl}`)
      return
    }
    const summary = (await summarizeRelationshipCall(name, category, transcript)) ?? transcript.slice(0, 600)

    const { error: touchErr } = await sb
      .from("relationship_touches")
      .update({ transcript, message: summary, action: "sent" })
      .eq("id", touchId)
    if (touchErr) console.error("[crms/call] touch update failed:", touchErr.message)

    const noted = await appendCallNote(relationshipId, summary)
    if (!noted) await sendTelegramAlert(`⚠️ Relationships call with ${name}: summary saved on the touch but the notes append failed.`)

    await sendTelegramAlert(`📞 Call with ${name}${recordingDurationSec ? ` (${Math.round(recordingDurationSec / 60)} min)` : ""}\n\n${summary}`)
  } catch (e) {
    console.error("[crms/call] pipeline threw:", e)
    await sendTelegramAlert(`⚠️ Relationships call with ${name}: transcript pipeline crashed (${e instanceof Error ? e.message : String(e)}). Recording: ${fullUrl}`)
  }
}
