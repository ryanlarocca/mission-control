// Market-cycle owned-property registry (briefs/BRIEF_MARKET_CYCLE_TRACKER_2026-11-01.md
// §3.1 item 5). Pure pieces: the street normaliser / matcher, the `own …` command
// parser, the event planner, the listing-agreement name test and the flag; plus
// applyRegistryEvent against an in-memory fake client (no network).
import { describe, expect, it } from "vitest"
import {
  applyRegistryEvent,
  closingDateFor,
  cycleRegistryOn,
  isListingAgreementName,
  normalizeStreet,
  parseOwnCommand,
  planRegistryChange,
  registryListText,
  sameProperty,
  zipFrom,
} from "../scripts/market-cycle/registry.mjs"

const HALLECK = { id: "h1", address: "5764 Halleck Dr, San Jose, CA 95123", zip: "95123", flag: "for_sale", bought_on: "2026-10-01", listed_on: "2026-10-14", sold_on: null, retired_at: null }
const QUITO = { id: "q1", address: "2116 Quito Rd, San Jose, CA 95130", zip: "95130", flag: "held", bought_on: "2026-10-08", listed_on: null, sold_on: null, retired_at: null }
const HOME = { id: "home", address: null, zip: "95118", flag: "home", bought_on: null, listed_on: null, sold_on: null, retired_at: null }

describe("normalizeStreet — number + street name", () => {
  it("drops suffix, city, state, zip and case", () => {
    expect(normalizeStreet("5764 Halleck Dr, San Jose, CA 95123")).toEqual({ number: "5764", street: "halleck", key: "5764 halleck" })
    expect(normalizeStreet("5764 HALLECK DRIVE")?.key).toBe("5764 halleck")
    expect(normalizeStreet("2116 Quito Rd.")?.key).toBe("2116 quito")
  })
  it("drops a unit and folds directions", () => {
    expect(normalizeStreet("100 North Main St #4, San Jose")?.key).toBe("100 n main")
    expect(normalizeStreet("100 N Main Street Apt 4")?.key).toBe("100 n main")
  })
  it("keeps multi-word street names and stops at a bare zip", () => {
    expect(normalizeStreet("93 Ridgeview Ave")?.key).toBe("93 ridgeview")
    expect(normalizeStreet("1115 Mariposa 95110")?.key).toBe("1115 mariposa")
    expect(normalizeStreet("450 El Camino Real, Santa Clara")?.key).toBe("450 el camino real")
  })
  it("null without a leading street number", () => {
    expect(normalizeStreet(null)).toBeNull()
    expect(normalizeStreet("Halleck Dr")).toBeNull()
    expect(normalizeStreet("5764")).toBeNull()
  })
})

describe("sameProperty — matching", () => {
  it("matches spellings of the same address", () => {
    expect(sameProperty("5764 Halleck Dr, San Jose, CA 95123", "5764 Halleck Drive")).toBe(true)
    expect(sameProperty("2116 Quito Road", "2116 QUITO RD, SAN JOSE")).toBe(true)
    expect(sameProperty("5764 Halleck San Jose", "5764 Halleck Dr")).toBe(true) // comma-less address drags the city in
  })
  it("different number or street never matches", () => {
    expect(sameProperty("5764 Halleck Dr", "5766 Halleck Dr")).toBe(false)
    expect(sameProperty("2116 Quito Rd", "2116 Quinto Rd")).toBe(false)
    expect(sameProperty(null, "2116 Quito Rd")).toBe(false)
  })
})

describe("zipFrom", () => {
  it("last 5-digit group, ZIP+4 trimmed", () => {
    expect(zipFrom("5764 Halleck Dr, San Jose, CA 95123")).toBe("95123")
    expect(zipFrom("2116 Quito Rd, San Jose, CA 95130-4410")).toBe("95130")
  })
  it("a 5-digit street number alone is not a zip", () => {
    expect(zipFrom("12345 Main St")).toBeNull()
    expect(zipFrom("5764 Halleck Dr")).toBeNull()
  })
})

describe("parseOwnCommand", () => {
  it("own add with zip and flag", () => {
    expect(parseOwnCommand("own add 123 Main St 95123 held")).toEqual({ kind: "add", address: "123 Main St", zip: "95123", flag: "held" })
    expect(parseOwnCommand("own add 2116 Quito Rd 95130 for_sale")).toEqual({ kind: "add", address: "2116 Quito Rd", zip: "95130", flag: "for_sale" })
    expect(parseOwnCommand("Own add 5764 Halleck Dr, San Jose, CA 95123 home")).toEqual({ kind: "add", address: "5764 Halleck Dr, San Jose", zip: "95123", flag: "home" })
  })
  it("flag defaults to held; for-sale alias", () => {
    expect(parseOwnCommand("own add 123 Main St 95123")).toEqual({ kind: "add", address: "123 Main St", zip: "95123", flag: "held" })
    expect(parseOwnCommand("/own add 123 Main St 95123 for-sale")).toMatchObject({ flag: "for_sale" })
  })
  it("own add without a zip is an error that says so", () => {
    const out = parseOwnCommand("own add 123 Main St held")
    expect(out).toMatchObject({ kind: "error" })
    expect((out as { message: string }).message).toMatch(/zip/)
  })
  it("own add without a street number is an error", () => {
    expect(parseOwnCommand("own add Main St 95123")).toMatchObject({ kind: "error" })
  })
  it("own sold / own list / help", () => {
    expect(parseOwnCommand("own sold 5764 Halleck Dr")).toEqual({ kind: "sold", address: "5764 Halleck Dr" })
    expect(parseOwnCommand("own list")).toEqual({ kind: "list" })
    expect(parseOwnCommand("own")).toMatchObject({ kind: "error" })
    expect(parseOwnCommand("own help")).toMatchObject({ kind: "error" })
    expect(parseOwnCommand("own sold")).toMatchObject({ kind: "error" })
  })
  it("not a registry command → null (falls through to the other handlers)", () => {
    expect(parseOwnCommand("owner wants 1.2")).toBeNull()
    expect(parseOwnCommand("call her back")).toBeNull()
    expect(parseOwnCommand("")).toBeNull()
  })
})

describe("planRegistryChange", () => {
  const live = [HALLECK, QUITO, HOME]
  it("buyer statement adds held with the closing date when the address is new", () => {
    const p = planRegistryChange(live, { kind: "bought", address: "123 Main St, San Jose, CA 95123", zip: "95123", date: "2026-11-20", source: "inbox-agent" })
    expect(p.op).toBe("insert")
    expect(p.row).toEqual({ address: "123 Main St, San Jose, CA 95123", zip: "95123", flag: "held", bought_on: "2026-11-20", source: "inbox-agent" })
    expect(p.line).toBe("Registry: added 123 Main St (held)")
  })
  it("buyer statement on a live address changes nothing", () => {
    const p = planRegistryChange(live, { kind: "bought", address: "5764 Halleck Drive", zip: "95123", date: "2026-11-20" })
    expect(p.op).toBe("none")
  })
  it("buyer statement without a zip asks for the Telegram fallback", () => {
    const p = planRegistryChange(live, { kind: "bought", address: "123 Main St", zip: null, date: "2026-11-20" })
    expect(p.op).toBe("none")
    expect(p.line).toMatch(/own add 123 Main St <zip>/)
  })
  it("seller statement retires the live row", () => {
    const p = planRegistryChange(live, { kind: "sold", address: "2116 Quito Road, San Jose", date: "2026-12-05", retiredAt: "2026-12-05T20:00:00.000Z" })
    expect(p).toMatchObject({ op: "update", id: "q1", patch: { sold_on: "2026-12-05", retired_at: "2026-12-05T20:00:00.000Z" } })
    expect(p.line).toBe("Registry: retired 2116 Quito Rd (sold 2026-12-05)")
  })
  it("seller statement for an unknown address is a no-op with a line", () => {
    expect(planRegistryChange(live, { kind: "sold", address: "1 Nowhere Ln", date: "2026-12-05" })).toMatchObject({ op: "none" })
  })
  it("listing marks a held property for sale; already listed or not ours → silent", () => {
    const p = planRegistryChange(live, { kind: "listed", address: "2116 Quito Rd", date: "2026-11-03" })
    expect(p).toMatchObject({ op: "update", id: "q1", patch: { flag: "for_sale", listed_on: "2026-11-03" } })
    expect(planRegistryChange(live, { kind: "listed", address: "5764 Halleck Dr", date: "2026-11-03" })).toEqual({ op: "none", line: null })
    expect(planRegistryChange(live, { kind: "listed", address: "9 Other St", date: "2026-11-03" })).toEqual({ op: "none", line: null })
  })
  it("own add re-flags a live row instead of duplicating it", () => {
    const p = planRegistryChange(live, { kind: "add", address: "2116 Quito Rd", zip: "95130", flag: "for_sale" })
    expect(p).toMatchObject({ op: "update", id: "q1", patch: { flag: "for_sale" } })
  })
  it("retired rows are not live", () => {
    const p = planRegistryChange([{ ...QUITO, retired_at: "2026-12-05T00:00:00Z" }], { kind: "bought", address: "2116 Quito Rd", zip: "95130", date: "2027-03-01" })
    expect(p.op).toBe("insert")
  })
})

describe("registryListText / isListingAgreementName / closingDateFor / flag", () => {
  it("lists live rows on one line", () => {
    expect(registryListText([HALLECK, QUITO, HOME])).toBe("Registry (3): 5764 Halleck Dr 95123 for sale · 2116 Quito Rd 95130 held · (home, no address) 95118 home")
    expect(registryListText([])).toBe("Registry: empty.")
  })
  it("listing agreements by name; cancellations and modifications are not", () => {
    expect(isListingAgreementName("[RLA] Residential Listing Agreement.pdf")).toBe(true)
    expect(isListingAgreementName("Exclusive Authorization and Right to Sell.pdf")).toBe(true)
    expect(isListingAgreementName("[COL] Cancellation of Listing.pdf")).toBe(false)
    expect(isListingAgreementName("[MT-LA] Modification of Terms, Listing Agreement (1).pdf")).toBe(false)
    expect(isListingAgreementName("Seller Statement.pdf")).toBe(false)
  })
  it("closing date from the statement, else the email day", () => {
    expect(closingDateFor({ closing_date: "2026-10-01" }, "2026-10-03")).toEqual({ date: "2026-10-01", fromEmail: false })
    expect(closingDateFor({ closing_date: "Oct 1" }, "2026-10-03")).toEqual({ date: "2026-10-03", fromEmail: true })
    expect(closingDateFor(null, "2026-10-03")).toEqual({ date: "2026-10-03", fromEmail: true })
  })
  it("CYCLE_REGISTRY defaults to off", () => {
    expect(cycleRegistryOn({})).toBe(false)
    expect(cycleRegistryOn({ CYCLE_REGISTRY: "off" })).toBe(false)
    expect(cycleRegistryOn({ CYCLE_REGISTRY: "1" })).toBe(false)
    expect(cycleRegistryOn({ CYCLE_REGISTRY: "on" })).toBe(true)
    expect(cycleRegistryOn({ CYCLE_REGISTRY: " ON " })).toBe(true)
  })
})

// Minimal supabase-js stand-in: select().is().order() reads, insert(), update().eq().
function fakeClient(rows: Array<Record<string, unknown>>) {
  const writes: Array<{ op: string; payload: unknown; id?: unknown }> = []
  const client = {
    from() {
      return {
        select() {
          return { is: () => ({ order: async () => ({ data: rows.filter((r) => !r.retired_at), error: null }) }) }
        },
        async insert(payload: unknown) {
          writes.push({ op: "insert", payload })
          return { error: null }
        },
        update(payload: unknown) {
          return { eq: async (_c: string, id: unknown) => { writes.push({ op: "update", payload, id }); return { error: null } } }
        },
      }
    },
  }
  return { client, writes }
}

describe("applyRegistryEvent", () => {
  it("writes the planned change and returns its line", async () => {
    const { client, writes } = fakeClient([QUITO])
    const out = await applyRegistryEvent(client, { kind: "bought", address: "123 Main St, San Jose, CA 95123", zip: "95123", date: "2026-11-20", source: "inbox-agent" })
    expect(out).toEqual({ op: "insert", line: "Registry: added 123 Main St (held)" })
    expect(writes).toHaveLength(1)
  })
  it("dry run reads but never writes", async () => {
    const { client, writes } = fakeClient([QUITO])
    const out = await applyRegistryEvent(client, { kind: "sold", address: "2116 Quito Rd", date: "2026-12-05" }, { dryRun: true })
    expect(out.line).toBe("Registry (dry run, not written): retired 2116 Quito Rd (sold 2026-12-05)")
    expect(writes).toHaveLength(0)
  })
})
