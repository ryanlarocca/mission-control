import { describe, it, expect, vi } from "vitest"

// 2026-11-11: full texts in Telegram alerts (lib/alertText), Enrich merges
// instead of overwriting (lib/relationshipNotes), and what a contact tells
// Ryan lands on the card as a dated note (lib/inboundFacts).

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }))
vi.mock("@/lib/leads", () => ({ getLeadsClient: vi.fn() }))
vi.mock("@/lib/llm", () => ({ completeText: vi.fn(), extractJsonObject: (t: string) => t, hasLlmKey: () => true, SONNET: "sonnet" }))

import { alertQuote, ALERT_TEXT_MAX } from "@/lib/alertText"
import { appendNoteBlock, mergeEnrichedNotes } from "@/lib/relationshipNotes"
import { inboundNoteLine, skipForNotes } from "@/lib/inboundFacts"

const PHOENIX =
  "On my end do you have any clients sitting on land, tear-downs, or probate properties in the Bay Area? My development partner and I are actively buying land to get it ready to sell to investors to build on, getting the land ready is a lengthy process. \nMy builder handles 100% of the permits and entitlements, and either we or the previous owner should agree to paying a generous referral fee for off-market leads. Let’s talk if you have anything on your radar now or later in the future"

describe("alertQuote", () => {
  it("keeps a 500-character text whole (the old cap cut Phoenix's at 300)", () => {
    expect(PHOENIX.length).toBeGreaterThan(300)
    const q = alertQuote(PHOENIX)
    expect(q).toContain("later in the future")
    expect(q).not.toContain("…")
  })
  it("escapes HTML", () => {
    expect(alertQuote("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d")
  })
  it("cuts only past the limit, and says where the rest is", () => {
    const q = alertQuote("x".repeat(ALERT_TEXT_MAX + 50))
    expect(q.endsWith("… (full text on the card)")).toBe(true)
    expect(q.length).toBeLessThan(ALERT_TEXT_MAX + 40)
  })
})

describe("mergeEnrichedNotes", () => {
  const meetup =
    "Met at the Mega Meetup with Tom Tran, Nov 10, 2026 (CPA presentation). Photographer / videographer — Quality Visualz."
  const dated = "[Nov 11, 2026 note] Met at the Mega Meetup. Does video production."

  it("keeps hand notes and dated lines, summary on top", () => {
    const out = mergeEnrichedNotes(`${meetup}\n\n${dated}`, "They've texted about a shoot.", "Nov 12, 2026")
    expect(out).toBe(`[Summary · Nov 12, 2026] They've texted about a shoot.\n\n${meetup}\n\n${dated}`)
  })

  it("replaces the previous [Summary] block, not stacking them", () => {
    const first = mergeEnrichedNotes(dated, "Old summary.", "Nov 12, 2026")
    const second = mergeEnrichedNotes(first, "New summary.", "Dec 1, 2026")
    expect(second).toBe(`[Summary · Dec 1, 2026] New summary.\n\n${dated}`)
  })

  it("drops a pre-change untagged AI summary (all its paragraphs) but keeps the dated lines after it", () => {
    const legacy = "# Contact Summary: Ryan & Brenda\nOrigin: met July 2024.\n\n## Topics\nHard money for flips."
    const out = mergeEnrichedNotes(`${legacy}\n\n[Oct 9, 2026 call] Left a voicemail.`, "Fresh summary.", "Nov 12, 2026")
    expect(out).toBe("[Summary · Nov 12, 2026] Fresh summary.\n\n[Oct 9, 2026 call] Left a voicemail.")
  })

  it("treats 'Ryan and X …' prose at the top as the old summary", () => {
    const out = mergeEnrichedNotes("Ryan and Kelsey have a bookkeeping relationship.", "New.", "Nov 12, 2026")
    expect(out).toBe("[Summary · Nov 12, 2026] New.")
  })

  it("keeps an untagged intake note that isn't a summary", () => {
    const intake = "Promoted from Leads. Mark owns a duplex at 212 Caledonia St, Santa Cruz."
    expect(mergeEnrichedNotes(intake, "S.", "Nov 12, 2026")).toBe(`[Summary · Nov 12, 2026] S.\n\n${intake}`)
  })

  it("keeps a multi-paragraph summary in one block so the next Enrich replaces all of it", () => {
    const first = mergeEnrichedNotes(dated, "Para one.\n\nPara two.", "Nov 12, 2026")
    expect(mergeEnrichedNotes(first, "Next.", "Dec 1, 2026")).toBe(`[Summary · Dec 1, 2026] Next.\n\n${dated}`)
  })

  it("strips the old [enriched: date] marker", () => {
    expect(mergeEnrichedNotes("[enriched: 2026-04-01] Promoted from Leads.", "S.", "Nov 12, 2026")).toBe("[Summary · Nov 12, 2026] S.\n\nPromoted from Leads.")
  })
})

describe("inbound notes", () => {
  it("skips tapbacks, STOP and short pleasantries without a model call", () => {
    expect(skipForNotes("Loved “Hey Phoenix, it's Ryan LaRocca with LRG Homes.”")).toBe(true)
    expect(skipForNotes("Liked \"Great meeting you\"")).toBe(true)
    expect(skipForNotes("STOP")).toBe(true)
    expect(skipForNotes("Thanks, you too!")).toBe(true)
    expect(skipForNotes(PHOENIX)).toBe(false)
  })
  it("formats the dated line like the other card notes", () => {
    expect(inboundNoteLine("Nov 11, 2026", "text", "Buys land with a dev partner;  pays referral fees.")).toBe(
      "[Nov 11, 2026 text] Buys land with a dev partner; pays referral fees."
    )
  })
  it("appends as its own block", () => {
    expect(appendNoteBlock("A", "[Nov 11, 2026 email] B.")).toBe("A\n\n[Nov 11, 2026 email] B.")
    expect(appendNoteBlock(null, "x")).toBe("x")
  })
})
