import { describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { isPieceMismatch, mailRecordSiteLine, normStreet, normSurname, parseFreeAddress, pieceMismatchLabel, soundAlike, soundAlikeMatch, soundAlikeName, soundKey, streetParts, suggestMailRecord } from "@/lib/mailMatch"

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

// Minimal mail_records stand-in: .from().select().eq()...limit() resolves to the rows matching every eq()
// and every like() (prefix patterns only: "314 %").
function fakeSb(rows: Record<string, unknown>[]): SupabaseClient {
  const from = () => {
    const filters: [string, unknown][] = []
    const prefixes: [string, string][] = []
    const q = {
      select: () => q,
      limit: () => q,
      eq: (col: string, v: unknown) => { filters.push([col, v]); return q },
      like: (col: string, pattern: string) => { prefixes.push([col, pattern.replace(/%$/, "")]); return q },
      ilike: () => { filters.push(["parcels", "__never__"]); return q }, // parcel search: no multi-parcel rows here
      then: (res: (v: { data: unknown[] }) => unknown) => res({
        data: rows.filter(r => filters.every(([c, v]) => r[c] === v) && prefixes.every(([c, p]) => String(r[c] ?? "").startsWith(p))),
      }),
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

// Sound-alike matching (2026-11-04): a Jackie call heard "Bieber Dr" as
// "Viber Drive" and the surname with an F for its V. Made-up owners below.
describe("sound-alike mail match", () => {
  // One house number, six streets in the same city.
  const row = (street: string, owner: string, city = "SAN JOSE") => ({ site_street_norm: street, site_city_norm: city, owner_name: owner })
  const listSameNumber = [
    row("314 COPCO LN", "Owen & Priya Castell"),
    row("314 DONDERO WAY", "Lena Ortiz & Sam Whitlow"),
    row("314 N CREEK DR", "Hugo Lindqvist & Mei Tanaka"),
    row("314 BIEBER DR", "Carol Vardell & The Carol A Vardell Trust January 2013"),
    row("314 NANCY LN", "Ines Morrow & The Ines Morrow Trust"),
    row("314 DORIS AVE", "Doris Holdings Llc"),
  ]

  it("keys words by consonant sound", () => {
    expect(soundKey("Bieber")).toBe("BBR")
    expect(soundKey("Viber")).toBe("BBR")
    expect(soundKey("Fardell")).toBe(soundKey("Vardell"))
    expect(soundAlike("Viber", "Bieber").sound).toBeGreaterThanOrEqual(0.8)
    expect(soundAlike("Park", "Brook").spelling).toBeLessThan(0.5)
    expect(soundAlike("24th", "25th").sound).toBe(0)
  })

  it("splits a normalized street into number and name", () => {
    expect(streetParts("314 N CREEK DR")).toEqual({ num: "314", name: "CREEK" })
    expect(streetParts("1035 BRYANT")).toEqual({ num: "1035", name: "BRYANT" })
    expect(streetParts("12 SANTA CRUZ AVE")).toEqual({ num: "12", name: "SANTACRUZ" })
    expect(streetParts("BIEBER DR").num).toBe("")
  })

  it("finds Bieber Dr from Viber Drive", () => {
    const m = soundAlikeMatch({ street: "314 VIBER DR", city: "SAN JOSE", name: "Carol Fardell" }, listSameNumber)
    expect(m.winner?.site_street_norm).toBe("314 BIEBER DR")
  })

  it("still finds it when a relative with another name calls", () => {
    // Street alone must then be a near-spelling in the same city.
    const m = soundAlikeMatch({ street: "314 BEIBER DR", city: "SAN JOSE", name: "Nadia Brooks" }, listSameNumber)
    expect(m.winner?.site_street_norm).toBe("314 BIEBER DR")
  })

  it("won't correct on sound alone without a second witness", () => {
    const m = soundAlikeMatch({ street: "314 VIBER DR", city: "SAN JOSE", name: "Nadia Brooks" }, listSameNumber)
    expect(m.winner).toBeNull()
    expect(m.near.map(r => r.site_street_norm)).toEqual(["314 BIEBER DR"])
  })

  it("doesn't turn one real street into another (489 Sweets Dr is not 489 Sioux Ln)", () => {
    const m = soundAlikeMatch({ street: "489 SWEETS DR", city: "SANTA CRUZ", name: "Dana Reyes" }, [row("489 SIOUX LN", "Pat Olsen", "SANTA CRUZ")])
    expect(m.winner).toBeNull()
    const park = soundAlikeMatch({ street: "314 PARK AVE", city: "SAN JOSE", name: null }, [row("314 BROOK DR", "Lee Chan")])
    expect(park.winner).toBeNull()
  })

  it("won't pick between two that both qualify", () => {
    const m = soundAlikeMatch({ street: "40 BIEBER DR", city: "", name: null }, [row("40 BEIBER DR", "A B"), row("40 BIEBER CT", "C D")])
    expect(m.winner).toBeNull()
    expect(m.near).toHaveLength(2)
  })

  it("ignores other house numbers and needs a street name", () => {
    expect(soundAlikeMatch({ street: "318 VIBER DR", city: "SAN JOSE", name: "Carol Fardell" }, listSameNumber).near).toEqual([])
    expect(soundAlikeMatch({ street: "314", city: "SAN JOSE", name: "Carol Fardell" }, listSameNumber).winner).toBeNull()
  })

  it("links through suggestMailRecord as a sound-alike correction", async () => {
    const rec = (id: string, r: ReturnType<typeof row>, site: string) => ({
      id, campaign_id: "c1", record_id: id, site_address: site, site_city: "San Jose", site_zip: "95123",
      mail_line_norm: null, mail_city_norm: null, owner_surname_norm: null, ...r,
    })
    const sb = fakeSb([rec("r1", listSameNumber[0], "314 Copco Ln"), rec("r4", listSameNumber[3], "314 Bieber Dr")])
    const r = await suggestMailRecord(sb, { campaignId: "c1", propertyAddress: "314 Viber Drive, San Jose", name: "Carol Fardell" })
    expect(r.record?.id).toBe("r4")
    expect(r.method).toBe("auto_soundalike")
    expect(r.soundCorrected).toBe(true)
    // No campaign scope, no guessing by sound.
    const open = await suggestMailRecord(sb, { campaignId: null, propertyAddress: "314 Viber Drive, San Jose", name: "Carol Fardell" })
    expect(open.record).toBeNull()
  })

  it("respells a surname that only sounds like the owner's", () => {
    const owner = "Carol Vardell & The Carol A Vardell Trust January 2013"
    expect(soundAlikeName("Carol Fardell", owner)).toBe("Carol Vardell")
    expect(soundAlikeName("John Fardell", owner)).toBe("John Vardell")
    expect(soundAlikeName("Carol Vardell", owner)).toBeNull()
    expect(soundAlikeName("Nadia Brooks", owner)).toBeNull()
    expect(soundAlikeName("Carol", owner)).toBeNull()
  })
})

describe("echoesWhisperPrompt", () => {
  it("flags a transcript that's just the city hints echoed back", async () => {
    const { echoesWhisperPrompt } = await import("@/lib/leads")
    expect(echoesWhisperPrompt("LRG Homes. San Jose, Santa Clara, Sunnyvale, Palo Alto, Milpitas.")).toBe(true)
    expect(echoesWhisperPrompt("140 Johnson Avenue in Los Gatos. Have him call me anytime.")).toBe(false)
  })
})
