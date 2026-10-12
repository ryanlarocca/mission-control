import { afterEach, describe, expect, it, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { CAMPAIGN_MAP, EMAIL_CAMPAIGN_MAP, SOURCE_OVERRIDE_NUMBERS, resolveMailbox, resolveRecipientCampaign } from "@/lib/leads"
import { autoLinkMailRecord, isPieceMismatch, mailSearchCampaignId } from "@/lib/mailMatch"

// NOO Q4 2026 A/B piece plumbing (briefs/BRIEF_NOO_Q4_AB_PLUMBING_2026-10-12.md).
// One list, two letters: piece A = bullets (408-418-6294 / ryansvx@), piece B
// = prose (408-418-8450 / ryansvy@). The dialed line / emailed alias decides
// the piece; the record match is the cross-check.

const LINE_A = "+14084186294"
const LINE_B = "+14084188450"
const HUB = "campaigns@lrghomes.com"

describe("NOO Q4 2026 A/B label map", () => {
  it("maps each printed line to its piece label", () => {
    expect(CAMPAIGN_MAP[LINE_A]).toBe("NOO-Q4-2026-A")
    expect(CAMPAIGN_MAP[LINE_B]).toBe("NOO-Q4-2026-B")
  })

  it("lets both lines override a returning caller's inherited source", () => {
    expect(SOURCE_OVERRIDE_NUMBERS.has(LINE_A)).toBe(true)
    expect(SOURCE_OVERRIDE_NUMBERS.has(LINE_B)).toBe(true)
  })

  it("no longer buckets the B line as Legacy DM, and no line carries the bare parent label", () => {
    expect(CAMPAIGN_MAP[LINE_B]).not.toBe("Legacy DM")
    // The parent label stays resolvable (campaigns.source_label on the parent
    // row) for rows written before the split, but no live line emits it.
    expect(Object.values(CAMPAIGN_MAP)).not.toContain("NOO-Q4-2026")
  })

  it("relabels the two aliases without touching the hub mailbox or the alias structure", () => {
    expect(EMAIL_CAMPAIGN_MAP["ryansvx@lrghomes.com"].source).toBe("NOO-Q4-2026-A")
    expect(EMAIL_CAMPAIGN_MAP["ryansvy@lrghomes.com"].source).toBe("NOO-Q4-2026-B")
    expect(EMAIL_CAMPAIGN_MAP[HUB].source).toBe("NOO-Q4-2026")
    expect(EMAIL_CAMPAIGN_MAP["ryansvx@lrghomes.com"].mailbox).toBe(HUB)
    expect(EMAIL_CAMPAIGN_MAP["ryansvy@lrghomes.com"].mailbox).toBe(HUB)
    expect(resolveMailbox("ryansvy@lrghomes.com")).toBe(HUB)
    for (const [addr, entry] of Object.entries(EMAIL_CAMPAIGN_MAP)) {
      if (addr.startsWith("ryansvx@") || addr.startsWith("ryansvy@")) continue
      expect(entry.source).not.toMatch(/^NOO-Q4-2026-/)
    }
  })

  it("attributes hub mail to the piece whose alias it was sent to", () => {
    const h = (pairs: [string, string][]) => pairs.map(([name, value]) => ({ name, value }))
    expect(resolveRecipientCampaign(h([["Delivered-To", "ryansvx@lrghomes.com"]]), HUB).campaign.source).toBe("NOO-Q4-2026-A")
    expect(resolveRecipientCampaign(h([["To", "Ryan <RyanSVY@lrghomes.com>"]]), HUB).campaign.source).toBe("NOO-Q4-2026-B")
    expect(resolveRecipientCampaign(h([["To", "undisclosed-recipients:;"]]), HUB).campaign.source).toBe("NOO-Q4-2026")
  })
})

describe("mail-record search scope", () => {
  const PARENT = "5b71ff54-14f9-4c83-a14d-8d1eed6325f2"
  const CHILD = "11111111-1111-4111-8111-111111111111"

  it("scopes an A/B child to its parent's records", () => {
    expect(mailSearchCampaignId({ id: CHILD, parent_campaign_id: PARENT, piece: "A" }, CHILD)).toBe(PARENT)
  })
  it("scopes a parent (or any non-child) to itself", () => {
    expect(mailSearchCampaignId({ id: PARENT, parent_campaign_id: null, piece: null }, PARENT)).toBe(PARENT)
  })
  it("falls back to the lead's campaign_id when the campaign row is missing", () => {
    expect(mailSearchCampaignId(null, CHILD)).toBe(CHILD)
    expect(mailSearchCampaignId(null, null)).toBeNull()
  })

  it("flags a piece mismatch only when both sides carry a piece", () => {
    expect(isPieceMismatch("A", "B")).toBe(true)
    expect(isPieceMismatch("A", "a")).toBe(false)
    expect(isPieceMismatch("A", "A")).toBe(false)
    expect(isPieceMismatch(null, "B")).toBe(false)
    expect(isPieceMismatch("A", null)).toBe(false)
    expect(isPieceMismatch(undefined, undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// autoLinkMailRecord end to end against a recording fake of the Supabase
// query builder: every chained call is captured, and a handler decides the
// result when the builder is awaited.
type Step = [string, unknown[]]
interface Call { table: string; chain: Step[] }
const arg = (c: Call, method: string, idx = 0) => c.chain.filter(s => s[0] === method).map(s => s[1][idx])
const eqValue = (c: Call, col: string) => c.chain.find(s => s[0] === "eq" && s[1][0] === col)?.[1][1]
const has = (c: Call, method: string) => c.chain.some(s => s[0] === method)

function fakeSupabase(handler: (c: Call) => { data?: unknown; error?: unknown }, log: Call[]) {
  const from = (table: string) => {
    const call: Call = { table, chain: [] }
    log.push(call)
    const builder: Record<string, unknown> = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") {
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve().then(() => handler(call)).then(res, rej)
        }
        return (...args: unknown[]) => { call.chain.push([prop, args]); return builder }
      },
    })
    return builder
  }
  return { from } as unknown as SupabaseClient
}

describe("autoLinkMailRecord on an A/B child campaign", () => {
  const PARENT = "5b71ff54-14f9-4c83-a14d-8d1eed6325f2"
  const CHILD_A = "11111111-1111-4111-8111-111111111111"
  const LEAD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  const RECORD = { id: "rec-1", campaign_id: PARENT, record_id: "SC-000123", owner_name: "Donald Teixeira", site_address: "860 24th Ave", site_city: "Santa Cruz", site_zip: "95062", mail_address: "PO Box 1", mail_city: "Aptos", mail_zip: "95003", county: "Santa Cruz", arm: "A", batch: 1, is_seed: false, piece: "B", tenure_bucket: null, imp_tercile: null, any_signal: null, estate_language: null, family_transfer: null, out_of_state: null, multi_parcel_personal: null, site_city_norm: "SANTA CRUZ", mail_city_norm: "APTOS" }

  function scenario(opts: { campaignRow: { id: string; parent_campaign_id: string | null; piece: string | null } | null; leadCampaignId: string | null; recordPiece: string | null }) {
    const log: Call[] = []
    const sb = fakeSupabase(c => {
      if (c.table === "leads" && has(c, "maybeSingle")) {
        return { data: { id: LEAD, caller_phone: "+15550001111", email: null, gmail_thread_id: null, name: "Donald Teixeira", property_address: "860 24th Ave., Santa Cruz 95062", campaign_id: opts.leadCampaignId, mail_record_id: null, mail_match_method: null } }
      }
      if (c.table === "leads" && has(c, "update")) return { data: [{ id: LEAD }] }
      if (c.table === "leads") return { data: [] } // sibling lookup: nobody linked yet
      if (c.table === "campaigns") return { data: opts.campaignRow }
      if (c.table === "mail_records") {
        const scoped = eqValue(c, "campaign_id")
        const street = eqValue(c, "site_street_norm")
        if (scoped === PARENT && street === "860 24TH AVE") return { data: [{ ...RECORD, piece: opts.recordPiece }] }
        return { data: [] }
      }
      throw new Error(`unexpected table ${c.table}`)
    }, log)
    return { sb, log }
  }

  afterEach(() => vi.restoreAllMocks())

  it("searches the parent's records, links the hit, and warns when the record's piece disagrees", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { sb, log } = scenario({ campaignRow: { id: CHILD_A, parent_campaign_id: PARENT, piece: "A" }, leadCampaignId: CHILD_A, recordPiece: "B" })
    const result = await autoLinkMailRecord(sb, LEAD)

    expect(result?.record?.id).toBe("rec-1")
    expect(result?.method).toBe("auto_address")
    const recordQueries = log.filter(c => c.table === "mail_records")
    expect(recordQueries.length).toBeGreaterThan(0)
    for (const q of recordQueries) expect(eqValue(q, "campaign_id")).toBe(PARENT)
    expect(log.find(c => c.table === "campaigns") && eqValue(log.find(c => c.table === "campaigns")!, "id")).toBe(CHILD_A)

    const update = log.find(c => c.table === "leads" && has(c, "update"))!
    expect(arg(update, "update")[0]).toMatchObject({ mail_record_id: "rec-1", mail_match_method: "auto_address" })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toMatch(/^\[mail-match\] piece mismatch/)
    expect(String(warn.mock.calls[0][0])).toContain("piece A")
    expect(String(warn.mock.calls[0][0])).toContain("piece B")
  })

  it("stays quiet when the record's piece agrees with the child's", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { sb } = scenario({ campaignRow: { id: CHILD_A, parent_campaign_id: PARENT, piece: "A" }, leadCampaignId: CHILD_A, recordPiece: "A" })
    const result = await autoLinkMailRecord(sb, LEAD)
    expect(result?.record?.id).toBe("rec-1")
    expect(warn).not.toHaveBeenCalled()
  })

  it("keeps a parent campaign scoped to itself and never compares pieces", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { sb, log } = scenario({ campaignRow: { id: PARENT, parent_campaign_id: null, piece: null }, leadCampaignId: PARENT, recordPiece: "B" })
    const result = await autoLinkMailRecord(sb, LEAD)
    expect(result?.record?.id).toBe("rec-1")
    for (const q of log.filter(c => c.table === "mail_records")) expect(eqValue(q, "campaign_id")).toBe(PARENT)
    expect(warn).not.toHaveBeenCalled()
  })

  it("falls back to the lead's own campaign_id when the campaign row is missing", async () => {
    const { sb, log } = scenario({ campaignRow: null, leadCampaignId: CHILD_A, recordPiece: "A" })
    const result = await autoLinkMailRecord(sb, LEAD)
    expect(result?.record).toBeNull() // the child has no records of its own
    for (const q of log.filter(c => c.table === "mail_records")) expect(eqValue(q, "campaign_id")).toBe(CHILD_A)
  })

  it("skips the campaign lookup for an unattributed lead", async () => {
    const { sb, log } = scenario({ campaignRow: null, leadCampaignId: null, recordPiece: "A" })
    await autoLinkMailRecord(sb, LEAD)
    expect(log.some(c => c.table === "campaigns")).toBe(false)
    for (const q of log.filter(c => c.table === "mail_records")) expect(eqValue(q, "campaign_id")).toBeUndefined()
  })
})
