// A Relationships card's notes field, as blocks (2026-11-11). Pure — safe to
// import anywhere.
//
// Notes are blank-line-separated blocks: an AI summary of the message history
// (Enrich), plus dated lines that people and the system add over time —
// "[Nov 11, 2026 note] …" typed by hand, "[Oct 9, 2026 call] …",
// "[Coach 2026-10-15] …", "[Nov 11, 2026 text] …" from lib/inboundFacts.
//
// Enrich used to REPLACE the whole field with a fresh summary, so pressing it
// wiped every dated note and anything Ryan wrote after meeting someone. Now
// the summary is its own tagged block, "[Summary · Nov 11, 2026] …", that
// Enrich swaps on each run; every other block stays.

const SUMMARY_TAG_RE = /^\[Summary\b[^\]]*\]/i
const ENRICHED_MARKER_RE = /^\[enriched:\s*\d{4}-\d{2}-\d{2}\]\s*/

// How the pre-2026-11 summaries open (an untagged block written by Enrich or
// the May migration): "Ryan and Brenda met …", "They've discussed …",
// "# Contact Summary: …", "The origin of …", "There's insufficient context …".
const LEGACY_SUMMARY_RE =
  /\bRyan and\b|^They(?:'ve| have)?\s+(?:discussed|talked|exchanged|only|connected|haven't|have not)\b|^#+\s*Contact Summary|^The (?:origin|earliest|contact|message history)\b|^There(?:'s| is) insufficient|^Based on (?:the|their)\b/i

/** "Nov 11, 2026" in Pacific time — the stamp the dated note lines use. */
export function noteStampDay(now = new Date()): string {
  return now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" })
}

/** Append one block to the notes, blank line between. */
export function appendNoteBlock(existing: string | null | undefined, block: string): string {
  const prev = (existing || "").trim()
  return prev ? `${prev}\n\n${block.trim()}` : block.trim()
}

function blocks(notes: string): string[] {
  return notes.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)
}

/** The leading blocks that are an old untagged AI summary (dropped when Enrich writes a new one). */
function legacySummaryLength(bs: string[]): number {
  if (!bs.length || bs[0].startsWith("[") || !LEGACY_SUMMARY_RE.test(bs[0].slice(0, 300))) return 0
  // A summary can run several paragraphs (the "# Contact Summary" ones have
  // headed sections) — it ends at the first dated/tagged block.
  let n = 0
  while (n < bs.length && !bs[n].startsWith("[")) n++
  return n
}

/**
 * Enrich's new summary on top, everything else kept: dated lines, hand notes,
 * intake notes. Only the previous summary goes — the "[Summary · …]" block,
 * or (for cards enriched before this change) the untagged AI summary at the top.
 */
export function mergeEnrichedNotes(existing: string | null | undefined, summary: string, day = noteStampDay()): string {
  const bs = blocks((existing || "").replace(ENRICHED_MARKER_RE, ""))
  const legacy = legacySummaryLength(bs)
  const kept = bs.slice(legacy).filter((b) => !SUMMARY_TAG_RE.test(b))
  // One block: a blank line inside the summary would split it, and the next
  // Enrich would keep the second half as if it were a note.
  const body = summary.replace(ENRICHED_MARKER_RE, "").trim().replace(/\n\s*\n/g, "\n")
  return [`[Summary · ${day}] ${body}`, ...kept].join("\n\n")
}
