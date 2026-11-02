import { describe, it, expect } from "vitest"
// Offer bot money / phone helpers — pure and credential-free. These amounts
// end up printed on a purchase agreement, so lock the parser down.
import { parseMoney, formatMoney, formatPhone } from "../lib/offerMoney"

describe("parseMoney — shorthand from the header comment", () => {
  it.each([
    ["1.52M", 1_520_000],
    ["1.52m", 1_520_000],
    ["1.52mm", 1_520_000],
    ["1.52MM", 1_520_000],
    ["$1.52 million", 1_520_000],
    ["1.2 mil", 1_200_000],
    ["1520k", 1_520_000],
    ["1520K", 1_520_000],
    ["10 thousand", 10_000],
    ["1,520,000", 1_520_000],
    ["1520000", 1_520_000],
    ["$10,000", 10_000],
    ["1,520,000.00", 1_520_000],
  ])("%s → %d", (raw, expected) => {
    expect(parseMoney(raw)).toBe(expected)
  })

  it("accepts currency prefixes and suffixes", () => {
    expect(parseMoney("USD 10,000")).toBe(10_000)
    expect(parseMoney("us$10,000")).toBe(10_000)
    expect(parseMoney("$ 1.5m")).toBe(1_500_000)
    expect(parseMoney("10,000 usd")).toBe(10_000)
    expect(parseMoney("10,000 dollars")).toBe(10_000)
    expect(parseMoney("1 dollar k")).toBeNull() // suffix must be last
    expect(parseMoney("1.2 million dollars")).toBe(1_200_000)
  })

  it("trims surrounding whitespace and is case-insensitive", () => {
    expect(parseMoney("  1.52M  ")).toBe(1_520_000)
    expect(parseMoney("1.2 MILLION")).toBe(1_200_000)
    expect(parseMoney("10 Thousand")).toBe(10_000)
  })

  it("handles whole and fractional bases with every suffix", () => {
    expect(parseMoney("2m")).toBe(2_000_000)
    expect(parseMoney("0.5m")).toBe(500_000)
    expect(parseMoney("1.5k")).toBe(1_500)
    expect(parseMoney("250k")).toBe(250_000)
    expect(parseMoney("1,000.50")).toBe(1_000.5)
  })

  it("rounds to cents with no float noise", () => {
    expect(parseMoney("1.13m")).toBe(1_130_000)
    expect(parseMoney("1.005k")).toBe(1_005)
    expect(parseMoney("1000.004")).toBe(1_000)
    expect(parseMoney("1000.005")).toBe(1_000.01)
    // NOTE: extra decimals are silently rounded, not rejected —
    // "1520000.999" becomes $1,520,001.00 on the agreement.
    expect(parseMoney("1520000.999")).toBe(1_520_001)
  })

  it("1,000 is the smallest bare number accepted", () => {
    expect(parseMoney("1000")).toBe(1_000)
    expect(parseMoney("1,000")).toBe(1_000)
    expect(parseMoney("999")).toBeNull()
    expect(parseMoney("999.99")).toBeNull()
  })
})

describe("parseMoney — null cases", () => {
  it("null, undefined and blank", () => {
    expect(parseMoney(null)).toBeNull()
    expect(parseMoney(undefined)).toBeNull()
    expect(parseMoney("")).toBeNull()
    expect(parseMoney("   ")).toBeNull()
  })

  it("percentages", () => {
    expect(parseMoney("2.5%")).toBeNull()
    expect(parseMoney("3 %")).toBeNull()
    expect(parseMoney("10,000%")).toBeNull()
  })

  it("words", () => {
    expect(parseMoney("one million")).toBeNull()
    expect(parseMoney("TBD")).toBeNull()
    expect(parseMoney("$")).toBeNull()
    expect(parseMoney("usd")).toBeNull()
    expect(parseMoney("k")).toBeNull()
  })

  it("bare numbers under 1,000 with no suffix (ambiguous: ask)", () => {
    expect(parseMoney("1.2")).toBeNull()
    expect(parseMoney("$1.52")).toBeNull()
    expect(parseMoney("500")).toBeNull()
  })

  it("zero, negatives and malformed numbers", () => {
    expect(parseMoney("0")).toBeNull()
    expect(parseMoney("0k")).toBeNull()
    expect(parseMoney("-500k")).toBeNull()
    expect(parseMoney("1,52,000")).toBeNull()
    expect(parseMoney("1520,000")).toBeNull()
    expect(parseMoney("1.2.3m")).toBeNull()
    expect(parseMoney(".5m")).toBeNull()
    expect(parseMoney("1.52b")).toBeNull()
    expect(parseMoney("1.52 billion")).toBeNull()
    expect(parseMoney("1.52 m k")).toBeNull()
  })
})

describe("parseMoney — numbers as input", () => {
  it("positive finite numbers pass through, rounded to cents", () => {
    expect(parseMoney(1_520_000)).toBe(1_520_000)
    expect(parseMoney(10_000.5)).toBe(10_000.5)
    expect(parseMoney(1_234.567)).toBe(1_234.57)
  })

  it("zero, negatives and non-finite numbers are null", () => {
    expect(parseMoney(0)).toBeNull()
    expect(parseMoney(-1)).toBeNull()
    expect(parseMoney(-1_520_000)).toBeNull()
    expect(parseMoney(NaN)).toBeNull()
    expect(parseMoney(Infinity)).toBeNull()
    expect(parseMoney(-Infinity)).toBeNull()
  })

  it("NOTE: numbers skip the under-1,000 rule that strings get", () => {
    // NOTE: the string "1.2" is null (ambiguous), but the number 1.2 is
    // accepted as $1.20. Current behavior, documented here; not changed.
    expect(parseMoney(1.2)).toBe(1.2)
    expect(parseMoney(500)).toBe(500)
    expect(parseMoney("500")).toBeNull()
  })
})

describe("formatMoney", () => {
  it("adds thousands separators and always two decimals, no $", () => {
    expect(formatMoney(1_520_000)).toBe("1,520,000.00")
    expect(formatMoney(10_000)).toBe("10,000.00")
    expect(formatMoney(1_000.5)).toBe("1,000.50")
    expect(formatMoney(999)).toBe("999.00")
    expect(formatMoney(0)).toBe("0.00")
    expect(formatMoney(0.5)).toBe("0.50")
  })

  it("rounds to cents", () => {
    expect(formatMoney(1_234.567)).toBe("1,234.57")
    expect(formatMoney(1_234.561)).toBe("1,234.56")
  })

  it("round-trips with parseMoney", () => {
    for (const raw of ["1.52M", "1520k", "$10,000", "1,520,000.00", "1,000.50"]) {
      const n = parseMoney(raw)
      expect(n).not.toBeNull()
      expect(parseMoney(formatMoney(n as number))).toBe(n)
    }
  })
})

describe("formatPhone", () => {
  it.each([
    ["408-555-1234", "(408) 555-1234"],
    ["+1 (408) 555 1234", "(408) 555-1234"],
    ["4085551234", "(408) 555-1234"],
    ["14085551234", "(408) 555-1234"],
    ["1-408-555-1234", "(408) 555-1234"],
    ["+14085551234", "(408) 555-1234"],
    ["408.555.1234", "(408) 555-1234"],
    ["(408) 555-1234", "(408) 555-1234"],
    ["  408 555 1234  ", "(408) 555-1234"],
  ])("%s → %s", (raw, expected) => {
    expect(formatPhone(raw)).toBe(expected)
  })

  it("anything that isn't a 10-digit US number comes back trimmed as typed", () => {
    expect(formatPhone("555-1234")).toBe("555-1234")
    expect(formatPhone("  555-1234  ")).toBe("555-1234")
    expect(formatPhone("24085551234")).toBe("24085551234") // 11 digits, no leading 1
    expect(formatPhone("+44 20 7946 0958")).toBe("+44 20 7946 0958")
    expect(formatPhone("408-555-1234 x12")).toBe("408-555-1234 x12")
    expect(formatPhone("call me")).toBe("call me")
  })

  it("null, undefined and blank are null", () => {
    expect(formatPhone(null)).toBeNull()
    expect(formatPhone(undefined)).toBeNull()
    expect(formatPhone("")).toBeNull()
    expect(formatPhone("   ")).toBeNull()
  })
})
