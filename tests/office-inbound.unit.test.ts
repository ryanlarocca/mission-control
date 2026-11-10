import { describe, it, expect, vi } from "vitest"
import {
  formatUsPhone,
  isOfficeLine,
  isPlaceholderName,
  last10,
  resolveOfficeCaller,
  signedPhones,
  toE164,
  NEW_CONTACT_CATEGORY,
  NEW_CONTACT_SOURCE,
} from "@/lib/office-inbound"

// Business-card routing (brief: BRIEF_OFFICE_LINE_INBOUND_2026-09-24).
// Relationships → Leads → create a Relationship; office lines only.

describe("office-line helpers", () => {
  it("only the two office lines are office lines", () => {
    expect(isOfficeLine("+14084585442")).toBe(true)
    expect(isOfficeLine("+14084930632")).toBe(true)
    expect(isOfficeLine("+16506703914")).toBe(false) // Google Ads
    expect(isOfficeLine("+16504364279")).toBe(false) // MFM-A
    expect(isOfficeLine(null)).toBe(false)
  })
  it("normalizes phones", () => {
    expect(last10("+1 (408) 555-1234")).toBe("4085551234")
    expect(toE164("408-555-1234")).toBe("+14085551234")
    expect(toE164("555-1234")).toBeNull()
    expect(formatUsPhone("+14085551234")).toBe("(408) 555-1234")
  })
  it("treats the formatted number as a placeholder name, never a real name", () => {
    expect(isPlaceholderName("(408) 555-1234", "+14085551234")).toBe(true)
    expect(isPlaceholderName("+14085551234", "+14085551234")).toBe(true)
    expect(isPlaceholderName("", "+14085551234")).toBe(true)
    expect(isPlaceholderName("Kelly Ray", "+14085551234")).toBe(false)
  })
})

// A tiny fake of the PostgREST builder chain — each table answers with the
// rows we hand it; inserts are captured so the test can inspect them.
function fakeSb(tables: { relationships?: unknown[]; leads?: unknown[] }, inserted: Record<string, unknown>[] = []) {
  const builder = (table: string) => {
    const rows = (tables as Record<string, unknown[] | undefined>)[table] ?? []
    const chain: Record<string, unknown> = {}
    const self = () => chain
    for (const m of ["select", "like", "or", "order", "limit", "eq", "not", "is"]) chain[m] = self
    chain.insert = (row: Record<string, unknown>) => {
      inserted.push({ table, ...row })
      return { select: () => ({ single: async () => ({ data: { id: `new-${table}` }, error: null }) }) }
    }
    chain.then = (resolve: (v: unknown) => void) => resolve({ data: rows, error: null })
    return chain
  }
  return { from: builder } as unknown as Parameters<typeof resolveOfficeCaller>[0]
}

describe("resolveOfficeCaller", () => {
  it("a Relationships contact wins, even if they also have lead rows", async () => {
    const sb = fakeSb({ relationships: [{ id: "r1", name: "Kelly Ray", category: "Agent", tier: "B", status: "active" }], leads: [{ id: "l1" }] })
    const who = await resolveOfficeCaller(sb, "+14085551234")
    expect(who).toMatchObject({ kind: "relationship", id: "r1", name: "Kelly Ray", isNew: false, placeholderName: false })
  })
  it("an existing lead stays a lead", async () => {
    const sb = fakeSb({ relationships: [], leads: [{ id: "l1" }] })
    expect(await resolveOfficeCaller(sb, "+14085551234")).toEqual({ kind: "lead" })
  })
  it("nobody → a new Relationships contact with placeholder name, Agent / C, source Business Card", async () => {
    const inserted: Record<string, unknown>[] = []
    const sb = fakeSb({ relationships: [], leads: [] }, inserted)
    const who = await resolveOfficeCaller(sb, "+14085551234")
    expect(who).toMatchObject({ kind: "relationship", id: "new-relationships", isNew: true, placeholderName: true, name: "(408) 555-1234" })
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({ table: "relationships", phone: "+14085551234", category: NEW_CONTACT_CATEGORY, tier: "C", source: NEW_CONTACT_SOURCE, status: "active" })
  })
  it("an unusable number falls through to the lead path without touching the DB", async () => {
    const sb = fakeSb({})
    const spy = vi.spyOn(sb, "from")
    expect(await resolveOfficeCaller(sb, "Anonymous")).toEqual({ kind: "lead" })
    expect(spy).not.toHaveBeenCalled()
  })
})

// A wholesaler's blast from a bulk line, signed with the cell that's already
// on his card (2026-11-10).
describe("signedPhones", () => {
  it("finds the number a blast is signed with", () => {
    const body = "📍14585 Union Ave, San Jose, CA 95124\nAsking: $1,584,999\n1,263 Sq Ft | 7,840 Sq Ft Lot\nFernando | (408) 309-2868\nReply REMOVE to Unsubscribe"
    expect(signedPhones(body, "+16509556008")).toEqual(["4083092868"])
  })
  it("skips the sender's own number and our lines", () => {
    expect(signedPhones("call me at 650-955-6008", "+16509556008")).toEqual([])
    expect(signedPhones("you texted 408-458-5442, mine is 408.555.1212", "+16505550000")).toEqual(["4085551212"])
  })
  it("ignores prices and sizes", () => {
    expect(signedPhones("Asking $1,584,999 ARV 2000000 lot 7840", "+16505550000")).toEqual([])
  })
  it("reads +1 forms once", () => {
    expect(signedPhones("text +1 (925) 765-3858 or 19257653858", "+16505550000")).toEqual(["9257653858"])
  })
})

describe("resolveOfficeCaller — signed number", () => {
  // Relationships answers by the number in the .or() filter; updates are captured.
  function signedSb(cardByDigits: Record<string, unknown[]>, updates: Record<string, unknown>[], inserted: Record<string, unknown>[]) {
    const builder = (table: string) => {
      let rows: unknown[] = []
      const chain: Record<string, unknown> = {}
      const self = () => chain
      for (const m of ["select", "like", "order", "limit", "eq", "not", "is"]) chain[m] = self
      chain.or = (f: string) => {
        rows = Object.entries(cardByDigits).find(([d]) => f.includes(d))?.[1] ?? []
        return chain
      }
      chain.update = (patch: Record<string, unknown>) => {
        updates.push({ table, ...patch })
        return { eq: async () => ({ error: null }) }
      }
      chain.insert = (row: Record<string, unknown>) => {
        inserted.push({ table, ...row })
        return { select: () => ({ single: async () => ({ data: { id: `new-${table}` }, error: null }) }) }
      }
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: table === "leads" ? [] : rows, error: null })
      return chain
    }
    return { from: builder } as unknown as Parameters<typeof resolveOfficeCaller>[0]
  }
  const luis = { id: "r-luis", name: "Luis Fernando Galindo", phone: "+14083092868", alt_phones: [], category: "Agent", tier: "C", notes: "ALD Investments", status: "active" }
  const blast = "Asking: $1,584,999\nFernando | (408) 309-2868\nReply REMOVE to Unsubscribe"

  it("a blast signed with a card's number lands on that card, sender added as an extra", async () => {
    const updates: Record<string, unknown>[] = []
    const inserted: Record<string, unknown>[] = []
    const who = await resolveOfficeCaller(signedSb({ "4083092868": [luis] }, updates, inserted), "+16509556008", blast)
    expect(who).toMatchObject({ kind: "relationship", id: "r-luis", name: "Luis Fernando Galindo", isNew: false, signedAs: "+14083092868" })
    expect(inserted).toHaveLength(0)
    expect(updates[0]).toMatchObject({ table: "relationships", alt_phones: ["+16509556008"] })
    expect(String(updates[0].notes)).toContain("(650) 955-6008 added as an extra number")
  })
  it("no card knows the signed number → a new card, as before", async () => {
    const inserted: Record<string, unknown>[] = []
    const who = await resolveOfficeCaller(signedSb({}, [], inserted), "+16509556008", blast)
    expect(who).toMatchObject({ kind: "relationship", isNew: true })
    expect(inserted).toHaveLength(1)
  })
  it("two cards know the signed number → ambiguous, a new card instead", async () => {
    const inserted: Record<string, unknown>[] = []
    const who = await resolveOfficeCaller(signedSb({ "4083092868": [luis, { ...luis, id: "r-2" }] }, [], inserted), "+16509556008", blast)
    expect(who).toMatchObject({ isNew: true })
  })
})
