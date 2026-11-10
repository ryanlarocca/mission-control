import { describe, expect, it } from "vitest"
import { doorLabel, planMailCredit, WEBSITE_LINE, type CreditCampaign, type CreditRecord, type CreditRow } from "@/lib/mailCredit"
import { parseParcelEntry } from "@/lib/mailMatch"

// Mailer credit (briefs/BRIEF_MAILER_CREDIT_RULE_2026-11-09.md): anyone linked
// to a MAILED record is credited to that mailing, whatever door they used.
const Q4 = "q4"
const Q4A = "q4a"
const Q4B = "q4b"
const MFMA = "mfma"
const LEGACY = "feb26"
const campaigns = new Map<string, CreditCampaign>([
  [Q4, { id: Q4, name: "NOO Q4 2026", parent_campaign_id: null, piece: null, drop_date: "2026-10-08", first_drop_date: "2026-10-27" }],
  [Q4A, { id: Q4A, name: "NOO Q4 2026 — A (bullets)", parent_campaign_id: Q4, piece: "A", drop_date: "2026-10-08", first_drop_date: null }],
  [Q4B, { id: Q4B, name: "NOO Q4 2026 — B (prose)", parent_campaign_id: Q4, piece: "B", drop_date: "2026-10-08", first_drop_date: null }],
  [MFMA, { id: MFMA, name: "MFM-A May 2026", parent_campaign_id: null, piece: null, drop_date: "2026-04-30", first_drop_date: null }],
  [LEGACY, { id: LEGACY, name: "Feb 2026 SVR", parent_campaign_id: null, piece: null, drop_date: "2026-02-10", first_drop_date: null }],
])
const REC_B: CreditRecord = { id: "r1", campaign_id: Q4, piece: "B", arm: "A", is_seed: false }

let n = 0
function row(p: Partial<CreditRow>): CreditRow {
  return { id: `l${++n}`, created_at: "2026-11-04T18:00:00Z", twilio_number: WEBSITE_LINE, lead_type: "call", campaign_id: null, campaign_via: null, status: "new", is_dnc: false, ...p }
}

describe("planMailCredit", () => {
  it("credits a website-number caller to the record's letter (Maryam: form already on B, calls + texts not)", () => {
    const form = row({ lead_type: "form", created_at: "2026-11-02T18:11:00Z", campaign_id: Q4B, campaign_via: "match" })
    const call = row({ created_at: "2026-11-04T17:50:00Z" })
    const text = row({ lead_type: "sms", created_at: "2026-11-04T22:16:00Z" })
    const outbound = row({ twilio_number: null, created_at: "2026-11-04T00:33:00Z", status: "contacted" })
    const plan = planMailCredit({ rows: [form, call, text, outbound], record: REC_B, method: "auto_address", campaigns })
    expect(plan.targetId).toBe(Q4B)
    expect(plan.updates.map(u => u.id).sort()).toEqual([call.id, text.id].sort())
    expect(plan.updates.every(u => u.campaign_via === "match")).toBe(true)
    expect(plan.newlyCredited).toBe(false) // her form row already counted
  })

  it("picks the A/B child from the record's piece for a first credit", () => {
    const call = row({})
    const plan = planMailCredit({ rows: [call], record: REC_B, method: "auto_address", campaigns })
    expect(plan.targetId).toBe(Q4B)
    expect(plan.newlyCredited).toBe(true)
    expect(plan.firstRow?.id).toBe(call.id)
  })

  it("follows the child a person is already credited to (one letter per person per mailing)", () => {
    const line = row({ twilio_number: "+14084186294", campaign_id: Q4A, campaign_via: "line", created_at: "2026-11-03T18:00:00Z" })
    const web = row({ created_at: "2026-11-05T18:00:00Z" })
    const plan = planMailCredit({ rows: [line, web], record: REC_B, method: "auto_soundalike", campaigns })
    expect(plan.targetId).toBe(Q4A)
    expect(plan.updates).toEqual([{ id: web.id, campaign_id: Q4A, campaign_via: "match" }])
  })

  it("never credits a record that wasn't mailed, or a seed", () => {
    const call = row({})
    expect(planMailCredit({ rows: [call], record: { ...REC_B, arm: "none", piece: null }, method: "auto_address", campaigns }).skip).toBe("not_mailed")
    expect(planMailCredit({ rows: [call], record: { ...REC_B, is_seed: true }, method: "auto_address", campaigns }).skip).toBe("not_mailed")
  })

  it("waits for Ryan on a mailing-address or surname-only link", () => {
    const call = row({})
    expect(planMailCredit({ rows: [call], record: REC_B, method: "auto_mail_address", campaigns }).skip).toBe("weak_match")
    expect(planMailCredit({ rows: [call], record: REC_B, method: "auto_surname", campaigns }).skip).toBe("weak_match")
    expect(planMailCredit({ rows: [call], record: REC_B, method: "manual", campaigns }).updates[0].campaign_via).toBe("manual")
    expect(planMailCredit({ rows: [call], record: REC_B, method: "auto_parcel", campaigns }).updates).toHaveLength(1)
  })

  it("gives no credit before the mailing's first drop, and none when it hasn't started", () => {
    const early = row({ created_at: "2026-10-27T05:00:00Z" }) // 10/26 10pm Pacific
    const onDay = row({ created_at: "2026-10-27T16:00:00Z" })
    const plan = planMailCredit({ rows: [early, onDay], record: REC_B, method: "auto_address", campaigns })
    expect(plan.updates.map(u => u.id)).toEqual([onDay.id])
    const notStarted = new Map(campaigns)
    notStarted.set(Q4, { ...campaigns.get(Q4)!, first_drop_date: null })
    expect(planMailCredit({ rows: [onDay], record: REC_B, method: "auto_address", campaigns: notStarted }).skip).toBe("not_started")
  })

  it("moves a known lead's new contact on an old line to the newest mailing, leaving old rows alone (R6)", () => {
    const may = row({ twilio_number: "+16504364279", campaign_id: MFMA, campaign_via: "line", created_at: "2026-04-30T18:00:00Z", status: "nurture" })
    const nov = row({ twilio_number: "+16504364279", campaign_id: MFMA, campaign_via: "inherited", created_at: "2026-11-12T18:00:00Z", status: "nurture" })
    const plan = planMailCredit({ rows: [may, nov], record: REC_B, method: "auto_address", campaigns })
    expect(plan.updates).toEqual([{ id: nov.id, campaign_id: Q4B, campaign_via: "match" }])
    expect(plan.newlyCredited).toBe(true)
    expect(plan.resetRowId).toBe(nov.id) // D3: an old Nurture lead answering the new letter comes back as New
  })

  it("doesn't reset a lead Ryan is already working, a brand-new lead, or a DNC'd one", () => {
    const may = row({ twilio_number: "+16504364279", campaign_id: MFMA, created_at: "2026-04-30T18:00:00Z" })
    const working = row({ created_at: "2026-11-12T18:00:00Z", status: "active" })
    expect(planMailCredit({ rows: [may, working], record: REC_B, method: "auto_address", campaigns }).resetRowId).toBeNull()
    const fresh = row({ created_at: "2026-11-12T18:00:00Z", status: "dead" })
    expect(planMailCredit({ rows: [fresh], record: REC_B, method: "auto_address", campaigns }).resetRowId).toBeNull()
    const dnc = row({ created_at: "2026-11-12T18:00:00Z", status: "dead", is_dnc: true })
    expect(planMailCredit({ rows: [may, dnc], record: REC_B, method: "auto_address", campaigns }).resetRowId).toBeNull()
  })

  it("never touches Ryan's hand-attached credit or Ryan's outbound rows", () => {
    const hand = row({ created_at: "2026-11-05T18:00:00Z", campaign_id: LEGACY, campaign_via: "manual" })
    const out = row({ twilio_number: null, created_at: "2026-11-05T19:00:00Z" })
    const plan = planMailCredit({ rows: [hand, out], record: REC_B, method: "auto_address", campaigns })
    expect(plan.updates).toEqual([])
  })
})

describe("doorLabel", () => {
  it("names the door from the line, never the inherited source_type", () => {
    expect(doorLabel({ twilio_number: WEBSITE_LINE, lead_type: "form" })).toBe("website form")
    expect(doorLabel({ twilio_number: WEBSITE_LINE, lead_type: "sms" })).toBe("website number")
    expect(doorLabel({ twilio_number: "email:ryansvy@lrghomes.com", lead_type: "email" })).toBe("email (ryansvy@lrghomes.com)")
    expect(doorLabel({ twilio_number: "+14084186294", lead_type: "call" })).toBeNull()
  })
})

describe("parseParcelEntry", () => {
  it("reads a multi-parcel owner's other house", () => {
    expect(parseParcelEntry("342-39-031 1257 Woodview Ter, Los Altos")).toEqual({ street: "1257 WOODVIEW TER", city: "LOS ALTOS" })
    expect(parseParcelEntry(" 001-133-14 1314 Laurent St, Santa Cruz")).toEqual({ street: "1314 LAURENT ST", city: "SANTA CRUZ" })
    expect(parseParcelEntry("garbage")).toBeNull()
  })
})
