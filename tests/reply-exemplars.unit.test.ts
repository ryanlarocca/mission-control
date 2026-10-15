import { describe, it, expect } from "vitest"
import { rankSentExemplars, formatExemplars, type SentDraftRow } from "@/lib/reply/exemplars"

// Coached-draft brief §F1: coached sends rank first for the same moment /
// channel / surface and render as "Ryan's gist: … → what he sent: …".

const rows: SentDraftRow[] = [
  { moment: "offer_requested", channel: "sms", sent_body: "Auto reply, newest", sent_at: "2026-10-14T00:00:00Z", lead_id: "L1", mode: "auto" },
  { moment: "offer_requested", channel: "sms", sent_body: "Coached text about 950", sent_at: "2026-10-10T00:00:00Z", lead_id: "L2", mode: "coach", gist: "I'm at 950, he's at 1.6, keep the door open" },
  { moment: "offer_requested", channel: "email", sent_body: "Coached email about 700", sent_at: "2026-10-13T00:00:00Z", lead_id: "L3", mode: "coach", gist: "700 all cash, no agents" },
  { moment: "offer_requested", channel: "sms", sent_body: "Auto reply, older", sent_at: "2026-10-01T00:00:00Z", lead_id: "L4", mode: "auto" },
  { moment: "offer_requested", channel: "sms", sent_body: "Coached text about 950", sent_at: "2026-10-09T00:00:00Z", lead_id: "L5", mode: "coach", gist: "duplicate body, must dedupe" },
  { moment: "offer_requested", channel: "sms", sent_body: "Relationship row, wrong surface", sent_at: "2026-10-15T00:00:00Z", relationship_id: "R1", mode: "coach", gist: "x" },
  { moment: "offer_requested", channel: "sms", sent_body: "Coach row with empty gist counts as auto", sent_at: "2026-10-15T00:00:00Z", lead_id: "L6", mode: "coach", gist: "" },
]

describe("rankSentExemplars", () => {
  it("puts coached sends first — same channel, then other channels — then Auto newest first", () => {
    const out = rankSentExemplars(rows, { surface: "leads", channel: "sms", limit: 10 })
    expect(out.map((e) => e.reply)).toEqual([
      "Coached text about 950",
      "Coached email about 700",
      "Coach row with empty gist counts as auto",
      "Auto reply, newest",
      "Auto reply, older",
    ])
    expect(out[0].gist).toBe("I'm at 950, he's at 1.6, keep the door open")
    expect(out[2].gist).toBeNull()
    expect(out[3].gist).toBeNull()
  })
  it("keeps the surface filter and the limit", () => {
    const rel = rankSentExemplars(rows, { surface: "relationships", channel: "imessage", limit: 5 })
    expect(rel.map((e) => e.reply)).toEqual(["Relationship row, wrong surface"])
    const two = rankSentExemplars(rows, { surface: "leads", channel: "sms", limit: 2 })
    expect(two).toHaveLength(2)
    expect(two.every((e) => !!e.gist)).toBe(true)
  })
})

describe("formatExemplars", () => {
  it("renders a coached exemplar as gist → what he sent, an Auto one as before", () => {
    const text = formatExemplars(rankSentExemplars(rows, { surface: "leads", channel: "sms", limit: 10 }))
    expect(text).toContain("Example 1 (coached)\n  Ryan's gist: I'm at 950, he's at 1.6, keep the door open → what he sent: Coached text about 950")
    expect(text).toContain("Example 4\n  Ryan replied: Auto reply, newest")
    expect(text).not.toContain("Ryan's gist: duplicate body")
  })
  it("still says (none yet) when empty", () => {
    expect(formatExemplars([])).toBe("(none yet)")
  })
})
