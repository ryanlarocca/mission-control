import type { SupabaseClient } from "@supabase/supabase-js"
import { isAnonymousCaller } from "./anonymous"
import { personPhoneFor } from "./leadPhones"
import { completeText, extractJsonObject, SONNET } from "./llm"

// The number a hidden-caller-ID caller gave on the call (2026-11-13).
//
// A blocked caller is saved as caller_phone "Anonymous", so the card has
// nothing to dial. When the caller says "you can call me at …", the model
// reads the number out of the transcript, and code only takes it if those
// exact ten digits are in what the CALLER said (numberIsInTranscript) — a
// model is never trusted to write a phone number on its own. The row then
// takes the number, which puts it on that person's card.
//
// Kept free of lib/leads imports so lib/leads can use it. lib/jackie is
// imported lazily for the same reason (it reaches lib/leads).

const DIGIT_WORDS: Record<string, string> = {
  zero: "0", oh: "0", o: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9",
}

// What may sit between the groups of one spoken number: spaces, line breaks,
// dashes, dots, commas, parens, slashes. A word ("Alder Way", "and he can
// call me at") ends the number, so address digits said just before it can't
// be stitched onto it.
const NUMBER_GLUE = /^[\s\-–—.,()/+…]+$/

const SPEAKER_LINE = /^\s*(Jackie|Caller):\s?(.*)$/

/** Only what the caller said, when the transcript is split by speaker; the whole text otherwise. */
function callerText(transcript: string): string {
  const lines = transcript.split("\n")
  if (!lines.some(l => SPEAKER_LINE.test(l))) return transcript
  const out: string[] = []
  let speaker: string | null = null
  for (const line of lines) {
    const m = line.match(SPEAKER_LINE)
    if (m) {
      speaker = m[1]
      if (speaker === "Caller") out.push(m[2])
    } else if (/^\s*\[/.test(line)) {
      // "[Call answered by Jackie …]" — a note, nobody's turn.
      speaker = null
    } else if (speaker === "Caller") {
      // Whisper wraps a long turn onto unlabeled lines.
      out.push(line)
    }
  }
  return out.join("\n")
}

/**
 * True when `target` (ten digits) is one spoken number in `text`: it starts
 * at the first digit of a group, ends at the last digit of a group, and only
 * NUMBER_GLUE sits between its groups.
 */
function hasWholeNumber(text: string, target: string): boolean {
  let digits = ""
  let starts = new Set<number>()
  let ends = new Set<number>()
  const found = (): boolean => {
    for (let i = digits.indexOf(target); i >= 0; i = digits.indexOf(target, i + 1)) {
      if (starts.has(i) && ends.has(i + target.length)) return true
    }
    return false
  }
  for (const piece of text.match(/\d+|\D+/g) ?? []) {
    if (/^\d/.test(piece)) {
      starts.add(digits.length)
      digits += piece
      ends.add(digits.length)
    } else if (!NUMBER_GLUE.test(piece)) {
      if (found()) return true
      digits = ""
      starts = new Set()
      ends = new Set()
    }
  }
  return found()
}

/**
 * The guard: were these ten digits said by the caller, in order, as one
 * number? Checked on the transcript as written and again with spoken digit
 * words ("six five oh …") turned into digits; either passing is enough.
 */
export function numberIsInTranscript(transcript: string, tenDigits: string): boolean {
  if (!/^\d{10}$/.test(tenDigits)) return false
  const said = callerText(transcript || "")
  if (hasWholeNumber(said, tenDigits)) return true
  // Whole words only, so "o'clock" or "someone" never turn into digits.
  const worded = said.replace(/[A-Za-z']+/g, w => DIGIT_WORDS[w.toLowerCase()] ?? w)
  return hasWholeNumber(worded, tenDigits)
}

// "(408) 555-0142" / "1-408-555-0142" → "4085550142"; anything that isn't a
// real 10-digit US number (area code or exchange starting 0/1) → null.
function tenDigitsOf(raw: unknown): string | null {
  let d = String(raw ?? "").replace(/\D/g, "")
  if (d.length === 11 && d[0] === "1") d = d.slice(1)
  if (d.length !== 10 || /^[01]/.test(d) || /^...[01]/.test(d)) return null
  return d
}

export interface SpokenCallback {
  /** E.164, only when the model's digits passed numberIsInTranscript. */
  number: string | null
  /** The caller gave a number, but it couldn't be read cleanly (or failed the guard). */
  unclear: boolean
  note: string | null
}

const NOTHING: SpokenCallback = { number: null, unclear: false, note: null }

/** Did the caller give a number to reach them at? Never throws. */
export async function extractSpokenCallback(transcript: string): Promise<SpokenCallback> {
  if (!transcript?.trim()) return NOTHING
  const prompt = `This is a phone call to one of the mailer lines of LRG Homes (Ryan, a Bay Area home buyer). The caller's caller ID was hidden, so we don't have their number. It is either a voicemail they left, or a call answered by Jackie, Ryan's AI receptionist. Lines are labelled "Jackie:" and "Caller:" when the recording could be split by speaker; otherwise it is one block with no speaker labels.

Did the CALLER give a phone number to reach them at ("you can call me at …", "my number is …", "call me back at …")? Only a number that is theirs to be reached at — never Ryan's or LRG Homes' numbers, never a number Jackie read out, never somebody else's number they merely mention. If they gave more than one, the newest. Put its 10 digits in "callback_number" only if all ten digits are clear in the transcript; if they gave one but the digits are incomplete or unclear, leave "callback_number" null and set "callback_unclear" true. "callback_note" = a few words on whose number it is ("his own number, given at the end of the call"). Nothing given → null, false, null.

Respond with ONLY JSON:
{"callback_number": "<10 digits>" or null, "callback_unclear": true|false, "callback_note": "<a few words>" or null}

Transcript:
${transcript.slice(0, 20000)}`
  try {
    const out = await completeText({ prompt, model: SONNET, maxTokens: 200, thinking: false, tag: "[spoken-number]" })
    const j = JSON.parse(extractJsonObject(out.text)) as Record<string, unknown>
    const note = typeof j.callback_note === "string" && j.callback_note.trim() ? j.callback_note.trim().slice(0, 160) : null
    const heard = j.callback_number != null && String(j.callback_number).trim() !== ""
    if (!heard) return { number: null, unclear: j.callback_unclear === true, note }
    // The model's digits only count if the caller really said them.
    const d = tenDigitsOf(j.callback_number)
    if (d && numberIsInTranscript(transcript, d)) return { number: `+1${d}`, unclear: false, note }
    console.warn(`[spoken-number] model's number failed the transcript check — treated as unclear`)
    return { number: null, unclear: true, note }
  } catch (e) {
    console.error(`[spoken-number] failed: ${e instanceof Error ? e.message : e}`)
    return NOTHING
  }
}

export type AdoptResult =
  | { ok: true; phone: string; joinedExistingCard: boolean; viaBestNumber: boolean }
  | { ok: false; reason: "own_number" | "not_anonymous" | "not_found" | "bad_number" | "error"; detail?: string }

const last10 = (n: string): string => String(n || "").replace(/\D/g, "").slice(-10)

/**
 * Give an anonymous row the number its caller gave on the call. Only ever
 * replaces a hidden-ID placeholder, never a real number; the row then sits on
 * that number's card, joining it when the person has called before.
 */
export async function adoptSpokenNumber(
  sb: SupabaseClient,
  leadId: string,
  e164: string,
  opts: { ownNumbers: Iterable<string>; unjunk?: boolean },
): Promise<AdoptResult> {
  try {
    if (!/^\+1\d{10}$/.test(e164)) return { ok: false, reason: "bad_number" }
    const own = new Set(Array.from(opts.ownNumbers).map(last10).filter(d => d.length === 10))
    if (own.has(last10(e164))) return { ok: false, reason: "own_number" }
    // Already someone's "best number" → the row belongs on that card.
    const phone = await personPhoneFor(sb, e164)
    if (own.has(last10(phone))) return { ok: false, reason: "own_number" }

    const { data: row, error: readErr } = await sb.from("leads").select("caller_phone, jackie_call").eq("id", leadId).maybeSingle()
    if (readErr) return { ok: false, reason: "error", detail: readErr.message }
    if (!row) return { ok: false, reason: "not_found" }
    const current = row.caller_phone as string | null
    if (!isAnonymousCaller(current)) return { ok: false, reason: "not_anonymous" }

    const { data: others } = await sb.from("leads").select("id").eq("caller_phone", phone).neq("id", leadId).limit(1)
    // The placeholder is in the WHERE too: if anything gave the row a real
    // number since the read, this matches nothing and leaves it alone.
    const update: Record<string, unknown> = { caller_phone: phone }
    if (opts.unjunk) update.is_junk = false
    const { data: changed, error: updErr } = await sb.from("leads").update(update).eq("id", leadId).eq("caller_phone", current as string).select("id")
    if (updErr) return { ok: false, reason: "error", detail: updErr.message }
    if (!changed?.length) return { ok: false, reason: "not_anonymous" }

    // jackie_call.anonymous stays true — the record that the ID was hidden.
    if (row.jackie_call) {
      try {
        const { mergeJackieCall } = await import("@/lib/jackie")
        await mergeJackieCall(sb, leadId, { spoken_number: e164 })
      } catch (e) {
        console.error(`[spoken-number] jackie_call note failed for ${leadId}: ${e instanceof Error ? e.message : e}`)
      }
    }
    return { ok: true, phone, joinedExistingCard: !!others?.length, viaBestNumber: phone !== e164 }
  } catch (e) {
    return { ok: false, reason: "error", detail: e instanceof Error ? e.message : String(e) }
  }
}
