import { describe, expect, it } from "vitest"
import { clipHistoryText, fitHistoryBudget } from "@/lib/leads"

describe("LLM history budget", () => {
  it("keeps a whole 11-minute call transcript", () => {
    const call = "Lead: hello. ".repeat(800) // ~10.4k chars, Maryam 11-04 size
    expect(clipHistoryText(call)).toBe(call)
  })
  it("marks a cut instead of ending silently", () => {
    const huge = "x".repeat(30_000)
    const out = clipHistoryText(huge)
    expect(out.length).toBeLessThan(huge.length)
    expect(out).toMatch(/rest of this transcript not shown\]$/)
  })
  it("drops the oldest events first when the block is over budget", () => {
    const lines = ["a", "b", "c", "d", "e"].map(k => k.repeat(20_000))
    const kept = fitHistoryBudget(lines)
    expect(kept[kept.length - 1]).toBe(lines[4])
    expect(kept).not.toContain(lines[0])
    expect(kept.join("\n").length).toBeLessThanOrEqual(80_000)
  })
  it("always keeps the newest event even if it alone is large", () => {
    const big = "z".repeat(90_000)
    expect(fitHistoryBudget(["old", big])).toEqual([big])
  })
})
