import { describe, it, expect, vi, beforeEach } from "vitest"

// One reply path for every alert about a person (2026-11-10): the alert
// records who it's about (lib/alertSubject); Draft:, a typed text and
// "call him" route by that record (lib/alertReply).

const { calls, rec, fakeSb } = vi.hoisted(() => {
  const calls: { fn: string; args: unknown[] }[] = []
  const rec = (fn: string, ret: unknown) => (...args: unknown[]) => {
    calls.push({ fn, args })
    return Promise.resolve(ret)
  }
  // A relationships row for the card lookups textSubject does.
  const card = { id: "rel-1", name: "Luis Fernando Galindo", phone: "+14083092868", status: "active", tier: "C", category: "Agent" }
  const fakeSb = () => {
    const chain: Record<string, unknown> = {}
    const self = () => chain
    for (const m of ["select", "eq", "ilike", "in", "not", "order", "limit"]) chain[m] = self
    chain.maybeSingle = async () => ({ data: card, error: null })
    return { from: () => chain }
  }
  return { calls, rec, fakeSb }
})

vi.mock("@/lib/leads", () => ({
  getLeadsClient: () => fakeSb(),
  normalizeE164: (p: string) => {
    const d = p.replace(/\D/g, "").slice(-10)
    return d.length === 10 ? `+1${d}` : null
  },
  sendLeadSms: rec("sendLeadSms", { success: true }),
  lookupLeadName: rec("lookupLeadName", "Anita"),
}))
vi.mock("@/lib/reply/telegram", () => ({
  coachDraftForLead: rec("coachDraftForLead", { ok: true }),
  coachDraftForRelationship: rec("coachDraftForRelationship", { ok: true }),
}))
vi.mock("@/lib/campaignSms", () => ({
  sendAgentsLineText: rec("sendAgentsLineText", { success: true }),
  startAgentsLineRelayCall: rec("startAgentsLineRelayCall", { success: true, label: "Luis" }),
}))
vi.mock("@/lib/office-reply", () => ({
  sendOfficeText: rec("sendOfficeText", { ok: true, from: "+14084585442", logWarning: false }),
}))
vi.mock("@/lib/card-line", () => ({ displayLine: () => "the office line" }))
vi.mock("@/lib/leadCall", () => ({ startLeadCall: rec("startLeadCall", { ok: true }) }))
vi.mock("@/lib/officeCall", () => ({ startOfficeRelayCall: rec("startOfficeRelayCall", { ok: true, label: "Ashley Cao" }) }))

import { replyIntent, draftForSubject, textSubject, callSubject } from "@/lib/alertReply"
import { subjectFromRow, messageIdOf } from "@/lib/alertSubject"

beforeEach(() => {
  calls.length = 0
})

describe("replyIntent", () => {
  it("reads Draft:, call and a plain text", () => {
    expect(replyIntent("Draft: going to pass because the house is on a busy road")).toEqual({ intent: "draft", gist: "going to pass because the house is on a busy road" })
    expect(replyIntent("draft:pass")).toEqual({ intent: "draft", gist: "pass" })
    expect(replyIntent("call him back")).toEqual({ intent: "call", gist: "" })
    expect(replyIntent("Thanks, I'll pass on this one")).toEqual({ intent: "text", gist: "" })
  })
})

describe("draftForSubject", () => {
  it("an office-line contact drafts from the card, sent from the office line", async () => {
    expect(await draftForSubject({ kind: "relationship", relationshipId: "rel-1", phone: "+16509556008", line: "office" }, "pass", 42)).toBeNull()
    expect(calls).toEqual([{ fn: "coachDraftForRelationship", args: ["rel-1", "+16509556008", "pass", 42, "office"] }])
  })
  it("an agents-line contact drafts for the agents line", async () => {
    await draftForSubject({ kind: "relationship", relationshipId: "rel-2", phone: "+16506900515", line: "agents" }, "pass", 7)
    expect(calls[0]).toEqual({ fn: "coachDraftForRelationship", args: ["rel-2", "+16506900515", "pass", 7, "agents"] })
  })
  it("a lead drafts by its id", async () => {
    await draftForSubject({ kind: "lead", leadId: "lead-9", phone: "+14085551234" }, "ask for a time", 3)
    expect(calls[0]).toEqual({ fn: "coachDraftForLead", args: ["lead-9", "ask for a time", 3] })
  })
})

describe("textSubject", () => {
  it("agents line → texted from the agents line (which logs the card touch)", async () => {
    const out = await textSubject({ kind: "relationship", relationshipId: "rel-1", phone: "+16506900515", line: "agents" }, "Thanks, passing")
    expect(calls.map((c) => c.fn)).toEqual(["sendAgentsLineText"])
    expect(calls[0].args[0]).toMatchObject({ to10: "6506900515", body: "Thanks, passing" })
    expect(out).toContain("from the agents line")
  })
  it("office line → sendOfficeText to the alert's number", async () => {
    await textSubject({ kind: "relationship", relationshipId: "rel-1", phone: "+14083092868", line: "office" }, "Passing")
    expect(calls.map((c) => c.fn)).toEqual(["sendOfficeText"])
    expect(calls[0].args[2]).toBe("+14083092868")
  })
  it("a lead with a phone → the lead line", async () => {
    const out = await textSubject({ kind: "lead", leadId: "lead-9", phone: "4085551234" }, "Hi")
    expect(calls[0]).toEqual({ fn: "sendLeadSms", args: [{ phone: "+14085551234", message: "Hi", source: null }] })
    expect(out).toContain("lead line")
  })
})

describe("callSubject", () => {
  it("'call him' on an office alert places the card's click-to-call — never a text", async () => {
    const out = await callSubject({ kind: "relationship", relationshipId: "rel-1", phone: "+14083092868", line: "office" })
    expect(calls).toEqual([{ fn: "startOfficeRelayCall", args: [{ relationshipId: "rel-1", phone: "+14083092868" }] }])
    expect(out).toContain("connected to Ashley Cao")
  })
  it("'call him' on an email alert calls the card's main number (the alert may carry none)", async () => {
    await callSubject({ kind: "relationship", relationshipId: "rel-1", phone: null, line: "email" })
    expect(calls).toEqual([{ fn: "startOfficeRelayCall", args: [{ relationshipId: "rel-1", phone: null }] }])
  })
  it("agents line → relay call", async () => {
    await callSubject({ kind: "relationship", relationshipId: "rel-1", phone: "+16506900515", line: "agents" })
    expect(calls[0]).toEqual({ fn: "startAgentsLineRelayCall", args: ["6506900515"] })
  })
})

describe("alertSubject rows", () => {
  it("round-trips a row into a subject", () => {
    expect(subjectFromRow({ kind: "relationship", relationship_id: "r", lead_id: null, phone: "+1", email: null, line: "agents" })).toEqual({ kind: "relationship", relationshipId: "r", phone: "+1", line: "agents" })
    expect(subjectFromRow({ kind: "relationship", relationship_id: "r", lead_id: null, phone: null, email: null, line: null })).toMatchObject({ line: "office" })
    expect(subjectFromRow({ kind: "lead", relationship_id: null, lead_id: null, phone: null, email: "a@b.com", line: null })).toEqual({ kind: "lead", leadId: null, phone: null, email: "a@b.com" })
    expect(subjectFromRow({ kind: "lead", relationship_id: null, lead_id: null, phone: null, email: null, line: null })).toBeNull()
  })
  it("reads the message id off Telegram's response", () => {
    expect(messageIdOf({ ok: true, result: { message_id: 5150 } })).toBe(5150)
    expect(messageIdOf(null)).toBeNull()
  })
})
