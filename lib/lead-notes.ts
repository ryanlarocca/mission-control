// A lead's `notes` column holds two kinds of text: what Ryan typed, and the
// "[Skip trace …]" block scripts/skip-trace-fps.mjs appends (unverified
// people-search data — ages, every past address, relatives). Ryan
// 2026-10-26: the block is detail for the full lead card only. Every other
// surface that shows notes as his words, or hands them to an AI as his
// steering, goes through ryanNotes() so the dump never leaks into a worklist
// card or a draft. New readers of lead notes should do the same.

// Same boundary the skip-trace script uses to replace its own block: the
// block runs until a blank line that is NOT followed by another bullet /
// flag / indented address line.
const SKIP_TRACE_BLOCK = /\n*\[Skip trace[\s\S]*?(?=\n\n(?!\s*[•⚑]|\s{3})|$)/g

export interface SplitLeadNotes {
  // Ryan's own text (anything outside skip-trace blocks), trimmed.
  mine: string
  // The skip-trace block(s), verbatim, or "" when there are none.
  skipTrace: string
}

export function splitLeadNotes(notes: string | null | undefined): SplitLeadNotes {
  const text = notes ?? ""
  const blocks = text.match(SKIP_TRACE_BLOCK) ?? []
  return {
    mine: text.replace(SKIP_TRACE_BLOCK, "").trim(),
    skipTrace: blocks.map((b) => b.trim()).filter(Boolean).join("\n\n"),
  }
}

/** Ryan's own notes with any skip-trace block removed; null when empty. */
export function ryanNotes(notes: string | null | undefined): string | null {
  return splitLeadNotes(notes).mine || null
}

/** Rebuild the column after Ryan edits his part — the skip-trace block is
 *  kept (appended after his text, where the script puts it). */
export function joinLeadNotes(mine: string, skipTrace: string): string | null {
  const parts = [mine.trim(), skipTrace.trim()].filter(Boolean)
  return parts.length ? parts.join("\n\n") : null
}
