import { describe, it, expect, vi } from "vitest"
import {
  formatUsPhone,
  isOfficeLine,
  isPlaceholderName,
  last10,
  resolveOfficeCaller,
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
    for (const m of ["select", "like", "order", "limit", "eq", "not", "is"]) chain[m] = self
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
