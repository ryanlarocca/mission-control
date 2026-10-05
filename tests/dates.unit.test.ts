import { describe, it, expect } from "vitest"
import { formatDate, formatDateTime } from "@/lib/dates"

// Every CRMS date label carries the year — "Dec 15" on a voicemail from a
// prior year is ambiguous. These pin the shared formatter's shape.
describe("formatDate", () => {
  it("includes the year on ISO instants", () => {
    expect(formatDate("2025-12-15T17:58:00Z", { timeZone: "America/Los_Angeles" })).toBe("Dec 15, 2025")
  })
  it("reads bare YYYY-MM-DD as a local calendar date (no UTC day shift)", () => {
    expect(formatDate("2026-03-01")).toBe("Mar 1, 2026")
  })
  it("falls back to a dash for empty input and echoes garbage strings", () => {
    expect(formatDate(null)).toBe("—")
    expect(formatDate("")).toBe("—")
    expect(formatDate("not-a-date")).toBe("not-a-date")
  })
})

describe("formatDateTime", () => {
  it("includes the year alongside the time", () => {
    expect(formatDateTime("2025-12-15T17:58:00Z", { timeZone: "America/Los_Angeles" })).toBe("Dec 15, 2025, 9:58 AM")
  })
  it("accepts extra options such as a weekday", () => {
    expect(formatDateTime("2025-12-15T17:58:00Z", { weekday: "short", timeZone: "America/Los_Angeles" })).toBe("Mon, Dec 15, 2025, 9:58 AM")
  })
})
