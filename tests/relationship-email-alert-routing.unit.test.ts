import { describe, it, expect, vi, beforeEach } from "vitest"

// 2026-11-11: replies to an email alert (line "email") and an AGENT REPLY
// alert (line "campaign") on the one reply path (lib/alertReply) — which
// function each one reaches, with what.

const { calls, rec, db } = vi.hoisted(() => {
  const calls: { fn: string; args: unknown[] }[] = []
  const rec = (fn: string, ret: unknown) => (...args: unknown[]) => {
    calls.push({ fn, args })
    return Promise.resolve(ret)
  }
  // Per-table answers for the lookups alertReply does.
  const db = {
    relationships: { id: "rel-1", name: "Ashley Cao", phone: null, status: "active", tier: "B", category: "Investor" } as Record<string, unknown> | null,
    campaign_contacts: [{ id: "cc-2", name: "Pat Lee" }] as unknown[],
    campaign_events: [{ contact_id: "cc-2", occurred_at: "2026-11-11T00:00:00Z" }] as unknown[],
  }
  return { calls, rec, db }
})

vi.mock("@/lib/leads", () => ({
  getLeadsClient: () => ({
    from: (table: keyof typeof db) => {
      const chain: Record<string, unknown> = {}
      for (const m of ["select", "eq", "ilike", "in", "not", "order", "limit"]) chain[m] = () => chain
      chain.maybeSingle = async () => ({ data: db[table], error: null })
      chain.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: db[table], error: null }).then(ok)
      return { ...chain }
    },
  }),
  normalizeE164: (p: string) => {
    const d = p.replace(/\D/g, "").slice(-10)
    return d.length === 10 ? `+1${d}` : null
  },
  sendLeadSms: rec("sendLeadSms", { success: true }),
  lookupLeadName: rec("lookupLeadName", null),
}))
vi.mock("@/lib/reply/telegram", () => ({
  coachDraftForLead: rec("coachDraftForLead", { ok: true }),
  coachDraftForRelationship: rec("coachDraftForRelationship", { ok: true }),
}))
vi.mock("@/lib/relationshipEmail", () => ({
  sendRelationshipEmail: rec("sendRelationshipEmail", { ok: true, status: 200, threaded: true, mailbox: "ryan@lrghomes.com", to: "acao@x.com", touchLogged: true }),
}))
vi.mock("@/lib/campaignDraft", () => ({
  draftCampaignEmail: rec("draftCampaignEmail", { success: true, draft: "Hi Pat", label: "Pat Lee", eventId: "ev-1" }),
  postCampaignDraft: rec("postCampaignDraft", undefined),
}))
vi.mock("@/lib/campaignEmail", () => ({
  sendCampaignEmailReply: rec("sendCampaignEmailReply", { success: true, label: "Pat Lee <pat@x.com>", mailbox: "ryansvr@lrghomes.com" }),
}))
vi.mock("@/lib/campaignSms", () => ({
  sendAgentsLineText: rec("sendAgentsLineText", { success: true }),
  startAgentsLineRelayCall: rec("startAgentsLineRelayCall", { success: true, label: "x" }),
}))
vi.mock("@/lib/office-reply", () => ({ sendOfficeText: rec("sendOfficeText", { ok: true, from: "+14084585442" }) }))
vi.mock("@/lib/card-line", () => ({ displayLine: () => "the office line" }))

import { campaignContactForCard, draftForSubject, textSubject } from "@/lib/alertReply"

const email = { kind: "relationship" as const, relationshipId: "rel-1", phone: null, line: "email" as const }
const campaign = { kind: "relationship" as const, relationshipId: "rel-1", phone: "+14085551234", line: "campaign" as const }

beforeEach(() => {
  calls.length = 0
  db.campaign_contacts = [{ id: "cc-2", name: "Pat Lee" }]
})

describe("email line", () => {
  it("Draft: → the coach drafts for the email line, no phone needed", async () => {
    expect(await draftForSubject(email, "ask what she's working on", 11)).toBeNull()
    expect(calls).toEqual([{ fn: "coachDraftForRelationship", args: ["rel-1", null, "ask what she's working on", 11, "email"] }])
  })
  it("a typed reply → sendRelationshipEmail with the text, never a text message", async () => {
    const out = await textSubject(email, "Mostly duplexes in San Jose — want to grab coffee?")
    expect(calls).toEqual([{ fn: "sendRelationshipEmail", args: [{ relationshipId: "rel-1", body: "Mostly duplexes in San Jose — want to grab coffee?" }] }])
    expect(out).toBe("✅ Emailed Ashley Cao — same thread, from ryan@lrghomes.com")
  })
})

describe("campaign line", () => {
  it("Draft: → the campaign drafter, by the card's contact id, posted with the usual buttons", async () => {
    expect(await draftForSubject(campaign, "send me the address", 12)).toBeNull()
    expect(calls.map((c) => c.fn)).toEqual(["draftCampaignEmail", "postCampaignDraft"])
    expect(calls[0].args[0]).toEqual({ contactName: "Pat Lee", contactId: "cc-2", guidance: "send me the address" })
    expect(calls[1].args).toEqual([{ success: true, draft: "Hi Pat", label: "Pat Lee", eventId: "ev-1" }, 12])
  })
  it("a typed reply → sendCampaignEmailReply by contact id, the old confirmation (escaped for HTML)", async () => {
    const out = await textSubject(campaign, "Thanks Pat")
    expect(calls).toEqual([{ fn: "sendCampaignEmailReply", args: [{ contactName: "Pat Lee", contactId: "cc-2", body: "Thanks Pat" }] }])
    expect(out).toBe("✅ Emailed Pat Lee &lt;pat@x.com&gt; — same thread, from ryansvr@lrghomes.com.")
  })
  it("no campaign contact on the card → nothing drafted or sent", async () => {
    db.campaign_contacts = []
    expect(await campaignContactForCard("rel-1")).toBeNull()
    expect(await draftForSubject(campaign, "x", 1)).toContain("no campaign contact")
    expect(await textSubject(campaign, "x")).toContain("Not sent")
    expect(calls).toEqual([])
  })
})
