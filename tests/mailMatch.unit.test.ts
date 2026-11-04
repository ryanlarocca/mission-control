import { describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { isPieceMismatch, mailRecordSiteLine, normStreet, normSurname, parseFreeAddress, pieceMismatchLabel, suggestMailRecord } from "@/lib/mailMatch"

describe("mailMatch normalizers", () => {
  it("drops units and standardizes suffixes", () => {
    expect(normStreet("231 Market Pl # 290")).toBe("231 MARKET PL")
    expect(normStreet("1630 8th St Unit 2308")).toBe("1630 8TH ST")
    expect(normStreet("860 24th Ave., Apt 4")).toBe("860 24TH AVE")
    expect(normStreet("1145 Davis Street")).toBe("1145 DAVIS ST")
    expect(normStreet("2130 Rexford Way")).toBe("2130 REXFORD WAY")
  })
  it("takes the last real token as the surname", () => {
    expect(normSurname("Donald Teixeira, Trustee")).toBe("TEIXEIRA")
    expect(normSurname("Richard Hudnut Jr")).toBe("HUDNUT")
    expect(normSurname("Kim & Deborah Rosenblatt")).toBe("ROSENBLATT")
    expect(normSurname("The Liu Family Trust")).toBe("LIU")
    expect(normSurname("")).toBe("")
  })
  it("parses the free-text addresses leads actually carry", () => {
    expect(parseFreeAddress("860 24th Ave., Santa Cruz 95062")).toEqual({ street: "860 24TH AVE", city: "SANTA CRUZ", zip: "95062", hasNumber: true })
    expect(parseFreeAddress("1035 Bryant, Palo Alto")).toEqual({ street: "1035 BRYANT", city: "PALO ALTO", zip: "", hasNumber: true })
    expect(parseFreeAddress("132 N 14th Street, San Jose, CA 95112")).toEqual({ street: "132 N 14TH ST", city: "SAN JOSE", zip: "95112", hasNumber: true })
    expect(parseFreeAddress("1450 Merrill St Santa Cruz")).toEqual({ street: "1450 MERRILL ST", city: "SANTA CRUZ", zip: "", hasNumber: true })
    expect(parseFreeAddress("San Jose, CA (duplex)").hasNumber).toBe(false)
    expect(parseFreeAddress("").hasNumber).toBe(false)
  })
})

// A/B piece cross-check (2026-10-12): the lead card chip for a linked record
// whose creative differs from the lead's campaign piece.
describe("pieceMismatchLabel", () => {
  it("names the record piece first, then the line piece", () => {
    expect(pieceMismatchLabel("A", "B")).toBe("⚠ piece mismatch (record B, line A)")
    expect(pieceMismatchLabel("B", "A")).toBe("⚠ piece mismatch (record A, line B)")
  })
  it("normalizes case and whitespace like isPieceMismatch", () => {
    expect(isPieceMismatch(" a ", "A")).toBe(false)
    expect(pieceMismatchLabel(" a ", "A")).toBeNull()
    expect(pieceMismatchLabel("a", " b")).toBe("⚠ piece mismatch (record B, line A)")
  })
  it("is null when the pieces agree or either side is unknown", () => {
    expect(pieceMismatchLabel("A", "A")).toBeNull()
    expect(pieceMismatchLabel(null, "B")).toBeNull()
    expect(pieceMismatchLabel("A", null)).toBeNull()
    expect(pieceMismatchLabel(undefined, undefined)).toBeNull()
    expect(pieceMismatchLabel("", "B")).toBeNull()
  })
})

// Minimal mail_records stand-in: .from().select().eq()...limit() resolves to the rows matching every eq().
function fakeSb(rows: Record<string, unknown>[]): SupabaseClient {
  const from = () => {
    const filters: [string, unknown][] = []
    const q = {
      select: () => q,
      limit: () => q,
      eq: (col: string, v: unknown) => { filters.push([col, v]); return q },
      then: (res: (v: { data: unknown[] }) => unknown) => res({ data: rows.filter(r => filters.every(([c, v]) => r[c] === v)) }),
    }
    return q
  }
  return { from } as unknown as SupabaseClient
}

const GARY = {
  id: "r1", campaign_id: "c1", record_id: "NOO26-17119", owner_name: "Gary & Susan Giannini",
  site_address: "140 Johnson Ave", site_city: "Los Gatos", site_zip: "95030",
  site_street_norm: "140 JOHNSON AVE", site_city_norm: "LOS GATOS", mail_line_norm: "1654 W CREEK DR", mail_city_norm: "SAN JOSE",
  owner_surname_norm: "GIANNINI",
}

describe("suggestMailRecord city mishearing", () => {
  it("links a one-house street match when the heard city is wrong (call 19: Los Gatos → Las Vegas)", async () => {
    const r = await suggestMailRecord(fakeSb([GARY]), { campaignId: "c1", propertyAddress: "140 Johnson Avenue, Las Vegas", name: "Gary" })
    expect(r.record?.id).toBe("r1")
    expect(r.method).toBe("auto_address")
    expect(r.cityCorrected).toBe(true)
  })
  it("doesn't flag a correction when the city matches", async () => {
    const r = await suggestMailRecord(fakeSb([GARY]), { campaignId: "c1", propertyAddress: "140 Johnson Ave, Los Gatos", name: null })
    expect(r.record?.id).toBe("r1")
    expect(r.cityCorrected).toBeUndefined()
  })
  it("won't guess when the street is on the list twice in other cities", async () => {
    const twin = { ...GARY, id: "r2", site_city: "San Jose", site_city_norm: "SAN JOSE" }
    const r = await suggestMailRecord(fakeSb([GARY, twin]), { campaignId: "c1", propertyAddress: "140 Johnson Ave, Las Vegas", name: null })
    expect(r.record).toBeNull()
  })
  it("needs a campaign scope to ignore the city", async () => {
    const r = await suggestMailRecord(fakeSb([GARY]), { campaignId: null, propertyAddress: "140 Johnson Ave, Las Vegas", name: null })
    expect(r.record).toBeNull()
  })
  it("formats the corrected card address", () => {
    expect(mailRecordSiteLine(GARY)).toBe("140 Johnson Ave, Los Gatos, CA 95030")
    expect(mailRecordSiteLine({ site_address: "1 Main St", site_city: null, site_zip: null })).toBe("1 Main St")
  })
})

describe("echoesWhisperPrompt", () => {
  it("flags a transcript that's just the city hints echoed back", async () => {
    const { echoesWhisperPrompt } = await import("@/lib/leads")
    expect(echoesWhisperPrompt("LRG Homes. San Jose, Santa Clara, Sunnyvale, Palo Alto, Milpitas.")).toBe(true)
    expect(echoesWhisperPrompt("140 Johnson Avenue in Los Gatos. Have him call me anytime.")).toBe(false)
  })
})
