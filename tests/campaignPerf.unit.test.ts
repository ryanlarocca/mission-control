import { describe, expect, it } from "vitest"
import { computeCampaignCounts, groupPeople, type PerfRow } from "@/lib/campaignPerf"

const familyOf = (id: string) => ({ q4a: "q4", q4b: "q4" } as Record<string, string>)[id] ?? id
let n = 0
function row(p: Partial<PerfRow>): PerfRow {
  return {
    id: `r${++n}`, created_at: "2026-11-04T18:00:00Z", name: null, property_address: null, campaign_id: null, campaign_via: null,
    caller_phone: "+15550000001", email: null, gmail_thread_id: null, twilio_number: "+14084186294", lead_type: "call",
    is_junk: false, is_dnc: false, offer_verbalized_at: null, offer_amount: null, deal_closed_at: null, deal_value: null,
    became_lead_at: null, appointment_at: null, pending_at: null, ...p,
  }
}

describe("groupPeople", () => {
  it("joins a phone row and an email-only row through a shared email, never through a blocked caller ID", () => {
    const a = row({ caller_phone: "+15551112222", email: "a@x.com" })
    const b = row({ caller_phone: null, email: "A@x.com" })
    const anon1 = row({ caller_phone: "Anonymous" })
    const anon2 = row({ caller_phone: "Anonymous" })
    const g = groupPeople([a, b, anon1, anon2])
    expect(g.get(a.id)).toBe(g.get(b.id))
    expect(g.get(anon1.id)).not.toBe(g.get(anon2.id))
  })
})

describe("computeCampaignCounts", () => {
  it("counts a person once even when calls and an email-only reply both carry the campaign", () => {
    const call = row({ caller_phone: "+15551110000", email: "s@x.com", campaign_id: "mfma" })
    const mail = row({ caller_phone: null, email: "s@x.com", twilio_number: "email:ryansvg@lrghomes.com", lead_type: "email", campaign_id: "mfma" })
    const { byCampaign } = computeCampaignCounts([call, mail], familyOf)
    expect(byCampaign.get("mfma")!.total_responses).toBe(1)
  })

  it("puts a sale under the mailing they had most recently answered when it closed; both count the response", () => {
    const may = row({ caller_phone: "+15552220000", campaign_id: "mfma", created_at: "2026-05-02T18:00:00Z" })
    const nov = row({ caller_phone: "+15552220000", campaign_id: "q4b", created_at: "2026-11-05T18:00:00Z", twilio_number: "+16506703914" })
    const out = row({ caller_phone: "+15552220000", twilio_number: null, deal_closed_at: "2026-12-20T18:00:00Z", deal_value: 1500000, offer_verbalized_at: "2026-11-20T18:00:00Z" })
    const { byCampaign, offers } = computeCampaignCounts([may, nov, out], familyOf)
    expect(byCampaign.get("mfma")!.responses).toBe(1)
    expect(byCampaign.get("q4b")!.responses).toBe(1)
    expect(byCampaign.get("q4b")!.closed).toBe(1)
    expect(byCampaign.get("q4b")!.deal_value_total).toBe(1500000)
    expect(byCampaign.get("mfma")!.closed).toBe(0)
    expect(offers[0].campaign_id).toBe("q4b")
    expect(byCampaign.get("q4b")!.by_door.website_number).toBe(1)
  })

  it("keeps an old campaign's close where it was when the person later answers a new letter", () => {
    const old = row({ caller_phone: "+15553330000", campaign_id: "mfma", created_at: "2026-05-02T18:00:00Z", deal_closed_at: "2026-06-01T18:00:00Z", deal_value: 900000 })
    const later = row({ caller_phone: "+15553330000", campaign_id: "q4a", created_at: "2026-11-05T18:00:00Z" })
    const { byCampaign } = computeCampaignCounts([old, later], familyOf)
    expect(byCampaign.get("mfma")!.closed).toBe(1)
    expect(byCampaign.get("q4a")!.closed).toBe(0)
  })

  it("falls back to the earliest credited campaign for a close older than every credited row (hand-attached legacy close)", () => {
    const r = row({ caller_phone: "+15554440000", campaign_id: "feb25", created_at: "2026-04-30T18:00:00Z", deal_closed_at: "2025-07-03T18:00:00Z", deal_value: 2150000 })
    const { byCampaign } = computeCampaignCounts([r], familyOf)
    expect(byCampaign.get("feb25")!.closed).toBe(1)
    expect(byCampaign.get("feb25")!.closed_deals[0].deal_value).toBe(2150000)
  })

  it("counts an opt-out after the new letter as the new letter's removal; the old one keeps a real response", () => {
    const may = row({ caller_phone: "+15556660000", campaign_id: "mfma", created_at: "2026-05-02T18:00:00Z" })
    const stop = row({ caller_phone: "+15556660000", campaign_id: "q4a", created_at: "2026-11-05T18:00:00Z", is_dnc: true, lead_type: "sms" })
    const { byCampaign } = computeCampaignCounts([may, stop], familyOf)
    expect(byCampaign.get("mfma")!.responses).toBe(1)
    expect(byCampaign.get("q4a")!.removals).toBe(1)
  })

  it("rolls an A/B family up once per person", () => {
    const a = row({ caller_phone: "+15557770000", campaign_id: "q4a", campaign_via: "line" })
    const b = row({ caller_phone: "+15557770000", campaign_id: "q4b", created_at: "2026-11-06T18:00:00Z", lead_type: "form", twilio_number: "+16506703914" })
    const { byCampaign, byFamily } = computeCampaignCounts([a, b], familyOf)
    expect(byCampaign.get("q4a")!.responses + byCampaign.get("q4b")!.responses).toBe(2)
    expect(byFamily.get("q4")!.responses).toBe(1)
    expect(byFamily.get("q4")!.by_door.letter).toBe(1)
  })
})
