import { describe, expect, it } from "vitest"
import { spaceLevel } from "@/lib/miniSpace"

const GB = 1024 * 1024
describe("mini low-space level", () => {
  it("warns under 25 GB and goes urgent under 10 GB", () => {
    expect(spaceLevel(64 * GB, null)).toBeNull()
    expect(spaceLevel(24 * GB, null)).toBe("warn")
    expect(spaceLevel(9 * GB, null)).toBe("urgent")
  })
  it("doesn't flap around a line", () => {
    expect(spaceLevel(26 * GB, "warn")).toBe("warn")   // needs > 30 to clear
    expect(spaceLevel(31 * GB, "warn")).toBeNull()
    expect(spaceLevel(12 * GB, "urgent")).toBe("urgent") // needs > 15 to step down
    expect(spaceLevel(16 * GB, "urgent")).toBe("warn")
  })
  it("keeps the level when the mini didn't report", () => {
    expect(spaceLevel(null, "warn")).toBe("warn")
  })
})
