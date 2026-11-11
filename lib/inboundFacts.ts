// What a contact tells Ryan lands on their card's notes (2026-11-11).
//
// Every text and email a Relationships contact sends is logged as an inbound
// touch, but the notes field — the thing Ryan reads at a glance, and what
// survives months of silence — only changed when someone typed into it.
// Phoenix Chiang's "my development partner and I buy land … generous referral
// fee" sat in the message log while her card still said "realtor". Now one
// Sonnet call reads each inbound message and, when it carries a lasting fact
// (what they do, what they want, a deal, a referral offer, a change in their
// situation), appends one dated line: "[Nov 11, 2026 text] …". Pleasantries,
// tapbacks and scheduling chatter add nothing.
//
// Hooked into the two inbound writers (lib/office-inbound logInboundTextTouch
// for the office + agents lines, lib/agentsLineInbound logInboundEmailTouch
// for email replies), so every caller gets it. Runs under waitUntil after the
// webhook has answered, and never throws — a missed note must not cost an
// alert or a touch.

import { waitUntil } from "@vercel/functions"
import { completeText, extractJsonObject, hasLlmKey, SONNET } from "@/lib/llm"
import { getLeadsClient } from "@/lib/leads"
import { appendNoteBlock, noteStampDay } from "@/lib/relationshipNotes"

export type InboundKind = "text" | "email"

// iMessage reactions arrive as plain texts: Loved “…”, Liked “…”, etc.
const TAPBACK_RE = /^(loved|liked|disliked|laughed at|emphasi[sz]ed|questioned)\s+[“"]/i
const STOP_RE = /^\s*(stop|unsubscribe|cancel|end|quit|stopall)\s*$/i
// Short enough that it can't carry a fact worth a note ("Thanks!", "Sounds good").
export const MIN_NOTE_CHARS = 25

/** Messages that can never hold a note-worthy fact — skipped without a model call. */
export function skipForNotes(text: string): boolean {
  const t = text.trim()
  return t.length < MIN_NOTE_CHARS || TAPBACK_RE.test(t) || STOP_RE.test(t)
}

/** `[Nov 11, 2026 text] Buys land with a dev partner; pays referral fees.` */
export function inboundNoteLine(day: string, kind: InboundKind, note: string): string {
  const line = note.replace(/\s+/g, " ").trim().replace(/[.]+$/, "")
  return `[${day} ${kind}] ${line}.`
}

/** Sonnet: does this message tell Ryan something the card should keep? null = no. */
export async function extractInboundNote(args: {
  name: string | null
  category: string | null
  kind: InboundKind
  text: string
  subject?: string | null
  existingNotes: string | null
}): Promise<string | null> {
  if (!hasLlmKey()) return null
  const who = `${args.name || "A contact"}${args.category ? ` (${args.category})` : ""}`
  const notes = (args.existingNotes || "").trim()
  const prompt = `Ryan LaRocca buys and flips houses in the Bay Area (LRG Homes). ${who} just sent him this ${args.kind === "email" ? "email" : "text message"}. Decide whether it tells Ryan something worth remembering on their contact card.

THE MESSAGE
"""
${args.subject ? `Subject: ${args.subject}\n` : ""}${args.text.trim().slice(0, 6000)}
"""

WHAT THE CARD ALREADY SAYS
"""
${notes ? notes.slice(-3000) : "(nothing yet)"}
"""

Return JSON only:
{ "note": string | null }

WORTH A NOTE: what they do or their business; what they are looking for or offering (deals, properties, land, financing, buyers, referrals, a referral fee); a property address, price or timeline; a change in their situation (new job, license, moving, retiring, a death or sickness in the family); how or when they want to be reached; a personal detail they shared.
NOT WORTH A NOTE → null: thanks, greetings, "nice to meet you", reactions, scheduling back-and-forth, an out-of-office reply, anything the card already says. A question or request to Ryan (asking for his projects, his info, a call) is NOT a fact about them — null, unless the message also says what they do or want. Never comment on the name, signature or who sent it.

THE NOTE: one line, under 220 characters, note shorthand, about them in the third person. Example shape: "Buys land, tear-downs and probates with a dev partner to entitle and resell; pays a referral fee for off-market leads." Never invent; only what the message says.`
  try {
    const out = await completeText({ model: SONNET, prompt, maxTokens: 300, thinking: false, tag: "[inbound-facts]", lane: "background" })
    const parsed = JSON.parse(extractJsonObject(out.text)) as { note?: unknown }
    return typeof parsed.note === "string" && parsed.note.trim() ? parsed.note.trim() : null
  } catch (e) {
    console.warn("[inbound-facts] extraction failed:", e instanceof Error ? e.message : String(e))
    return null
  }
}

type NoteRel = { id: string; name: string | null; category: string | null; notes: string | null; status: string | null }

/** Read the message, append the note if there is one. Never throws. */
export async function landInboundNote(relationshipId: string, kind: InboundKind, text: string, subject?: string | null): Promise<string | null> {
  try {
    if (!relationshipId || skipForNotes(text)) return null
    const sb = getLeadsClient()
    const { data: rel } = await sb.from("relationships").select("id, name, category, notes, status").eq("id", relationshipId).maybeSingle<NoteRel>()
    if (!rel || rel.status === "do_not_contact") return null
    const note = await extractInboundNote({ name: rel.name, category: rel.category, kind, text, subject, existingNotes: rel.notes })
    if (!note) return null
    // Re-read right before writing: the model call takes seconds, and another
    // writer (a second text, Ryan's edit) may have changed the notes meanwhile.
    const { data: fresh } = await sb.from("relationships").select("notes").eq("id", rel.id).maybeSingle<{ notes: string | null }>()
    const line = inboundNoteLine(noteStampDay(), kind, note)
    const { error } = await sb.from("relationships").update({ notes: appendNoteBlock(fresh?.notes ?? rel.notes, line) }).eq("id", rel.id)
    if (error) {
      console.error("[inbound-facts] note append failed:", error.message)
      return null
    }
    console.log(`[inbound-facts] ${rel.name ?? rel.id}: ${line}`)
    return line
  } catch (e) {
    console.error("[inbound-facts] threw:", e instanceof Error ? e.message : String(e))
    return null
  }
}

/** Fire-and-forget from a webhook: the response goes back first, the note follows. */
export function queueInboundNote(relationshipId: string, kind: InboundKind, text: string, subject?: string | null): void {
  if (skipForNotes(text)) return
  waitUntil(landInboundNote(relationshipId, kind, text, subject))
}
