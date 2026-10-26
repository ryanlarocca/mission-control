import { describe, it, expect } from "vitest"
import { splitLeadNotes, ryanNotes, joinLeadNotes } from "@/lib/lead-notes"

const BLOCK = [
  "[Skip trace 2026-09-01 — fastpeoplesearch.com, UNVERIFIED — confirm which property the letter reached]",
  "⚑ LIFE-SITUATION WATCH: Dick Disalvo is 95, at 2528 Aragon Way since December 1992 (34 yrs)",
  "• Dick Disalvo, age 95 (b. March 1931) — San Jose, CA",
  "   Current: 2528 Aragon Way, San Jose CA 95125 (since December 1992)",
  "   Prev: 176 N Morrison AVE, San Jose CA 95126 (rec. June 1998)",
  "",
  "• Mary Di Salvo, age 95 (b. January 1931) — San Jose, CA",
  "   Current: 2528 Aragon Way, San Jose CA 95125 (since July 1975)",
].join("\n")

describe("lead notes — skip-trace split", () => {
  it("separates Ryan's text from a trailing skip-trace block", () => {
    const notes = `Looks like we never connected. Text him.\n\n${BLOCK}`
    const { mine, skipTrace } = splitLeadNotes(notes)
    expect(mine).toBe("Looks like we never connected. Text him.")
    expect(skipTrace).toBe(BLOCK)
    expect(ryanNotes(notes)).toBe("Looks like we never connected. Text him.")
  })

  it("keeps text written after the block (blank line, then non-bullet text)", () => {
    const notes = `Duplex (2) 2/1\n\n${BLOCK}\n\n[History backfilled from Gmail/Google Voice 2026-09-24] Steve. Mar 27 2025 text.`
    const { mine, skipTrace } = splitLeadNotes(notes)
    expect(mine).toBe("Duplex (2) 2/1\n\n[History backfilled from Gmail/Google Voice 2026-09-24] Steve. Mar 27 2025 text.")
    expect(skipTrace).toBe(BLOCK)
  })

  it("a block-only note has no Ryan text", () => {
    expect(ryanNotes(BLOCK)).toBeNull()
    expect(splitLeadNotes(BLOCK).skipTrace).toBe(BLOCK)
  })

  it("notes without a block pass through untouched", () => {
    expect(splitLeadNotes("Wants 1.9, offered 1.5").mine).toBe("Wants 1.9, offered 1.5")
    expect(splitLeadNotes(null)).toEqual({ mine: "", skipTrace: "" })
  })

  it("an edit keeps the block on save", () => {
    const { skipTrace } = splitLeadNotes(`old note\n\n${BLOCK}`)
    const saved = joinLeadNotes("new note", skipTrace)
    expect(saved).toBe(`new note\n\n${BLOCK}`)
    expect(splitLeadNotes(saved).mine).toBe("new note")
    expect(joinLeadNotes("", "")).toBeNull()
  })
})
