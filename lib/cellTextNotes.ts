// Notes from Ryan's cell texts, read when a card is opened (2026-11-11,
// briefs/BRIEF_RELATIONSHIP_EMAIL_SYNC_2026-11-11.md item 5).
//
// Texts on our Twilio lines are read for notes as they arrive
// (lib/inboundFacts). Texts to Ryan's own phone live only in the Mac mini's
// chat.db, which nothing watches — so a contact who tells Ryan what they do
// by iMessage never reached the card. /api/crms/messages already pulls the
// thread when a card opens; this reads the inbound texts in it that are newer
// than relationships.texts_noted_through, in one Sonnet call, after the
// response has gone back. No extra sidecar call, no history: the first open
// only starts the clock.
//
// Business cards only — not Personal, not do-not-contact (notesAllowed).

import type { SupabaseClient } from "@supabase/supabase-js"
import { landInboundNote, notesAllowed, TAPBACK_RE } from "@/lib/inboundFacts"
import type { ThreadMessage } from "@/lib/relationship-messages"
import { relationshipsByAnyPhone, to10Digit } from "@/lib/relationships"

// Enough for a burst of texts; the note model reads 6,000 characters at most.
export const MAX_BATCH_TEXTS = 20

export type CellTextPlan =
  /** First open: start the clock, read nothing. */
  | { kind: "start"; markTo: string }
  /** New texts since the marker: move it to the newest one, read `texts` (may be empty — all tapbacks). */
  | { kind: "read"; markTo: string; texts: string[] }

/**
 * Which of the thread's texts are new for notes. Only theirs, only from
 * Ryan's phone (chat.db rows have no `via`; business-line rows were read on
 * arrival), only newer than the marker. null = nothing to do.
 */
export function planCellTextNotes(thread: readonly ThreadMessage[], markedThrough: string | null, now = new Date()): CellTextPlan | null {
  if (!markedThrough) return { kind: "start", markTo: now.toISOString() }
  const mark = Date.parse(markedThrough)
  if (!Number.isFinite(mark)) return { kind: "start", markTo: now.toISOString() }
  const fresh = thread.filter((m) => !m.fromMe && !m.via && Date.parse(m.at) > mark)
  if (!fresh.length) return null
  const newest = fresh.reduce((max, m) => Math.max(max, Date.parse(m.at)), mark)
  const texts = fresh
    .map((m) => m.text.trim())
    .filter((t) => t && !TAPBACK_RE.test(t))
    .slice(-MAX_BATCH_TEXTS)
  return { kind: "read", markTo: new Date(newest).toISOString(), texts }
}

type MarkerRel = { id: string; name: string | null; category: string | null; status: string | null; texts_noted_through: string | null }

/** After /api/crms/messages answers: land a note from new cell texts. Never throws. */
export async function noteCellTextsOnOpen(sb: SupabaseClient, phone: string, thread: readonly ThreadMessage[]): Promise<void> {
  try {
    const d = to10Digit(phone)
    if (d.length !== 10) return
    const rel = (await relationshipsByAnyPhone<MarkerRel>(sb, d, "id, name, category, status, texts_noted_through", 1))[0]
    if (!rel || !notesAllowed(rel)) return
    const plan = planCellTextNotes(thread, rel.texts_noted_through)
    if (!plan) return
    // Claim: the marker moves only if nobody moved it since we read it, so
    // two quick opens of the card can't both read the same texts.
    const claim = sb.from("relationships").update({ texts_noted_through: plan.markTo }).eq("id", rel.id)
    const { data, error } = rel.texts_noted_through
      ? await claim.eq("texts_noted_through", rel.texts_noted_through).select("id")
      : await claim.is("texts_noted_through", null).select("id")
    if (error) {
      console.warn("[cell-text-notes] marker update failed:", error.message)
      return
    }
    if (!data?.length || plan.kind === "start" || !plan.texts.length) return
    await landInboundNote(rel.id, "text", plan.texts.join("\n"))
  } catch (e) {
    console.warn("[cell-text-notes] threw:", e instanceof Error ? e.message : String(e))
  }
}
