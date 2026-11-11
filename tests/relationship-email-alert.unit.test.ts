import { describe, it, expect, vi, beforeEach } from "vitest"

// 2026-11-11: an email from a Relationships contact to ryan@ posts one
// Telegram alert that records the card (line "email"); AGENT REPLY alerts
// record theirs (line "campaign") — briefs/BRIEF_RELATIONSHIP_EMAIL_ALERTS_2026-11-11.md.
// The pure decisions, plus one pass of the sync with a fake database to
// check when it alerts and that an alert can't change the answer to the mini.

const { alerts, alertOk } = vi.hoisted(() => ({
  alerts: [] as { text: string; opts: unknown }[],
  alertOk: { value: true as boolean | "throw" },
}))

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }))
vi.mock("@/lib/leads", () => ({
  getLeadsClient: vi.fn(),
  leadAlertBotToken: () => undefined,
  sendLeadSms: vi.fn(),
  normalizeE164: (p: string) => p,
  sendTelegramAlert: async (text: string, opts: unknown) => {
    if (alertOk.value === "throw") throw new Error("telegram down")
    alerts.push({ text, opts })
    return alertOk.value
  },
}))
vi.mock("@/lib/llm", () => ({ completeText: vi.fn(), extractJsonObject: (t: string) => t, hasLlmKey: () => true, SONNET: "sonnet", HAIKU: "haiku", OPUS: "opus" }))
vi.mock("@/lib/inboundFacts", () => ({ notesAllowed: () => true, landInboundNote: async () => null }))

import {
  DEAL_LEAD_KIND,
  emailAlertAbout,
  emailAlertCard,
  emailAlertText,
  isQuietRequest,
  parseSyncMessage,
  syncRelationshipEmails,
  type CardResult,
  type SyncCard,
  type SyncMessage,
} from "@/lib/relationshipEmailSync"
import { parseAlertLine, subjectFromRow } from "@/lib/alertSubject"
import { emailReplyConfirmation, pickCampaignContact, usesLegacyCampaignPath } from "@/lib/alertReply"
import { campaignDraftMessage } from "@/lib/campaignDraft"
import { agentReplyAbout } from "@/lib/campaignInbox"
import { emailDraftSubject, emailSentLabel } from "@/lib/reply/telegram"

const card = (over: Partial<SyncCard> = {}): SyncCard => ({
  id: "rel-1", name: "Ashley Cao", email: "acao@oldcapitallending.com", status: "active", tier: "B", category: "Investor", last_contacted_at: null, phone: null, ...over,
})

const msg = (over: Partial<SyncMessage> = {}): SyncMessage => ({
  gmailId: "g1", threadId: "t1", direction: "inbound", at: "2026-11-11T21:33:53.000Z",
  from: "acao@oldcapitallending.com", to: [], subject: "Re: Great meeting you at the Mega Meetup",
  text: "Likewise! What are you working on currently?", failedRecipient: null, ...over,
})

const logged = (id = "rel-1"): CardResult => ({ relationshipId: id, name: id, status: "logged", note: null })

beforeEach(() => {
  alerts.length = 0
  alertOk.value = true
})

describe("alert lines", () => {
  it("accepts the two new lines and still reads anything unknown as office", () => {
    expect(parseAlertLine("email")).toBe("email")
    expect(parseAlertLine("campaign")).toBe("campaign")
    expect(parseAlertLine("agents")).toBe("agents")
    expect(parseAlertLine("office")).toBe("office")
    expect(parseAlertLine("fax")).toBe("office")
    expect(parseAlertLine(null)).toBe("office")
    expect(subjectFromRow({ kind: "relationship", relationship_id: "r", lead_id: null, phone: null, email: null, line: "email" })).toEqual({ kind: "relationship", relationshipId: "r", phone: null, line: "email" })
    expect(subjectFromRow({ kind: "relationship", relationship_id: "r", lead_id: null, phone: "+14085551234", email: null, line: "campaign" })).toMatchObject({ line: "campaign" })
    expect(subjectFromRow({ kind: "relationship", relationship_id: "r", lead_id: null, phone: null, email: null, line: "Email" })).toMatchObject({ line: "office" })
  })
})

describe("when an email alerts", () => {
  it("an inbound email newly logged → its card", () => {
    expect(emailAlertCard(msg(), [logged()], false)).toBe("rel-1")
  })
  it("never for sent, bounce, a quiet request or a deal lead", () => {
    expect(emailAlertCard(msg({ direction: "sent" }), [logged()], false)).toBeNull()
    expect(emailAlertCard(msg({ direction: "bounce" }), [logged()], false)).toBeNull()
    expect(emailAlertCard(msg(), [logged()], true)).toBeNull()
    expect(emailAlertCard(msg({ kind: DEAL_LEAD_KIND }), [logged()], false)).toBeNull()
  })
  it("another kind still alerts", () => {
    expect(emailAlertCard(msg({ kind: "conversation" }), [logged()], false)).toBe("rel-1")
  })
  it("never for stamped, duplicate or skipped", () => {
    for (const status of ["stamped", "duplicate", "skipped"] as const) {
      expect(emailAlertCard(msg(), [{ relationshipId: "rel-1", name: null, status, note: null }], false)).toBeNull()
    }
  })
  it("one alert per email, even on two cards", () => {
    expect(emailAlertCard(msg(), [{ relationshipId: "rel-0", name: null, status: "duplicate", note: null }, logged("rel-1"), logged("rel-2")], false)).toBe("rel-1")
  })
  it("quiet: only an explicit no is loud", () => {
    expect(isQuietRequest(undefined)).toBe(false)
    expect(isQuietRequest(null)).toBe(false)
    expect(isQuietRequest(false)).toBe(false)
    expect(isQuietRequest("false")).toBe(false)
    expect(isQuietRequest(true)).toBe(true)
    expect(isQuietRequest("true")).toBe(true)
    expect(isQuietRequest(1)).toBe(true)
  })
  it("parseSyncMessage carries the inbox agent's kind, and leaves it off when absent", () => {
    const base = { gmailId: "g", direction: "inbound", at: "2026-11-11T21:33:53Z", from: "a@b.com", subject: "s", text: "t" }
    expect(parseSyncMessage({ ...base, kind: " deal_lead " })).toMatchObject({ ok: true, msg: { kind: "deal_lead" } })
    const p = parseSyncMessage(base)
    expect(p.ok && "kind" in p.msg).toBe(false)
  })
})

describe("the alert", () => {
  it("matches the brief's shape", () => {
    expect(emailAlertText(card(), "Re: Great meeting you at the Mega Meetup", "Likewise! What are you working on currently?")).toBe(
      `✉️ <b>Email</b> — <b>Ashley Cao</b> (Investor · B)\n<b>Re: Great meeting you at the Mega Meetup</b>\n"Likewise! What are you working on currently?"`,
    )
  })
  it("says do-not-contact on the first line; Personal alerts like any other", () => {
    expect(emailAlertText(card({ status: "do_not_contact" }), "Hi", "x").split("\n")[0]).toBe("✉️ <b>Email</b> — <b>Ashley Cao</b> (Investor · B) · do-not-contact")
    expect(emailAlertText(card({ category: "Personal", tier: null }), "Hi", "x").split("\n")[0]).toBe("✉️ <b>Email</b> — <b>Ashley Cao</b> (Personal)")
  })
  it("escapes HTML, falls back to the address, and keeps a long body whole up to the cap", () => {
    const out = emailAlertText(card({ name: null, category: null, tier: null }), "", "a < b & c")
    expect(out).toBe(`✉️ <b>Email</b> — <b>acao@oldcapitallending.com</b>\n<b>(no subject)</b>\n"a &lt; b &amp; c"`)
    const long = emailAlertText(card(), "s", "x".repeat(4000))
    expect(long).toContain("(full text on the card)")
  })
  it("records the card on the email line, with or without a phone", () => {
    expect(emailAlertAbout(card())).toEqual({ kind: "relationship", relationshipId: "rel-1", phone: null, line: "email" })
    expect(emailAlertAbout(card({ phone: "(408) 555-1234" }))).toEqual({ kind: "relationship", relationshipId: "rel-1", phone: "+14085551234", line: "email" })
  })
})

describe("the sync posts the alert", () => {
  // A fake Supabase: every chain resolves to { data, error: null }; the card
  // list for relationships, nothing already logged for touches.
  const fakeSb = (cards: SyncCard[]) => {
    const inserts: { table: string; row: unknown }[] = []
    const from = (table: string) => {
      const result = { data: table === "relationships" ? cards : [], error: null }
      const chain: Record<string, unknown> = {}
      for (const m of ["select", "eq", "is", "not", "gte", "lte", "lt", "order", "range", "limit", "update"]) chain[m] = () => chain
      chain.insert = (row: unknown) => {
        inserts.push({ table, row })
        return chain
      }
      chain.maybeSingle = async () => ({ data: null, error: null })
      chain.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result).then(ok, bad)
      return chain
    }
    return { sb: { from } as never, inserts }
  }
  const entry = (over: Record<string, unknown> = {}) => ({
    gmailId: "g1", threadId: "t1", direction: "inbound", at: "2026-11-11T21:33:53Z",
    from: "acao@oldcapitallending.com", to: [], subject: "Re: Great meeting you", text: "Likewise!", ...over,
  })

  it("one alert for a newly logged inbound email, about the card", async () => {
    const { sb, inserts } = fakeSb([card()])
    const results = await syncRelationshipEmails(sb, [entry()])
    expect(results).toEqual([{ gmailId: "g1", cards: [{ relationshipId: "rel-1", name: "Ashley Cao", status: "logged", note: null }], done: true }])
    expect(inserts.map((i) => i.table)).toEqual(["relationship_touches"])
    expect(alerts).toHaveLength(1)
    expect(alerts[0].text).toContain("<b>Ashley Cao</b> (Investor · B)")
    expect(alerts[0].opts).toEqual({ about: { kind: "relationship", relationshipId: "rel-1", phone: null, line: "email" } })
  })
  it("nothing on a quiet request, for a deal lead, a send or a bounce", async () => {
    const { sb } = fakeSb([card()])
    await syncRelationshipEmails(sb, [entry()], { quiet: true })
    await syncRelationshipEmails(sb, [entry({ gmailId: "g2", kind: "deal_lead" })])
    await syncRelationshipEmails(sb, [entry({ gmailId: "g3", direction: "sent", from: "ryan@lrghomes.com", to: ["acao@oldcapitallending.com"] })])
    await syncRelationshipEmails(sb, [entry({ gmailId: "g4", direction: "bounce", failedRecipient: "acao@oldcapitallending.com" })])
    expect(alerts).toEqual([])
  })
  it("an alert that fails or throws leaves the answer to the mini unchanged", async () => {
    const expected = [{ gmailId: "g1", cards: [{ relationshipId: "rel-1", name: "Ashley Cao", status: "logged", note: null }], done: true }]
    alertOk.value = false
    expect(await syncRelationshipEmails(fakeSb([card()]).sb, [entry()])).toEqual(expected)
    alertOk.value = "throw"
    expect(await syncRelationshipEmails(fakeSb([card()]).sb, [entry()])).toEqual(expected)
  })
})

describe("campaign contact through the card", () => {
  const contacts = [{ id: "cc-1", name: "Pat Lee" }, { id: "cc-2", name: "Pat Lee" }]
  it("the one with the newest email reply", () => {
    expect(pickCampaignContact(contacts, [
      { contact_id: "cc-1", occurred_at: "2026-10-01T00:00:00Z" },
      { contact_id: "cc-2", occurred_at: "2026-11-11T00:00:00Z" },
    ])).toEqual(contacts[1])
  })
  it("ignores replies from contacts not on the card and unreadable times", () => {
    expect(pickCampaignContact(contacts, [
      { contact_id: "cc-9", occurred_at: "2026-11-12T00:00:00Z" },
      { contact_id: "cc-2", occurred_at: null },
      { contact_id: "cc-1", occurred_at: "2026-10-01T00:00:00Z" },
    ])).toEqual(contacts[0])
  })
  it("no replies: the only contact, else nobody", () => {
    expect(pickCampaignContact([contacts[0]], [])).toEqual(contacts[0])
    expect(pickCampaignContact(contacts, [])).toBeNull()
    expect(pickCampaignContact([], [])).toBeNull()
  })
  it("call, or no contact on the card, keeps the AGENT REPLY name path", () => {
    expect(usesLegacyCampaignPath("call", true)).toBe(true)
    expect(usesLegacyCampaignPath("draft", false)).toBe(true)
    expect(usesLegacyCampaignPath("text", false)).toBe(true)
    expect(usesLegacyCampaignPath("draft", true)).toBe(false)
    expect(usesLegacyCampaignPath("text", true)).toBe(false)
  })
  it("the AGENT REPLY alert records the card on the campaign line", () => {
    expect(agentReplyAbout("rel-7", "+14085551234", "6505550000")).toEqual({ kind: "relationship", relationshipId: "rel-7", phone: "+14085551234", line: "campaign" })
    expect(agentReplyAbout("rel-7", null, "6505550000")).toMatchObject({ phone: "+16505550000" })
    expect(agentReplyAbout("rel-7", null, null)).toMatchObject({ phone: null })
  })
  it("the campaign draft message keeps its wording and buttons", () => {
    const m = campaignDraftMessage({ label: "Pat Lee", draft: "Hi Pat,\n\nRyan", eventId: "ev-1" })
    expect(m.text).toBe("📝 Draft for Pat Lee:\n\nHi Pat,\n\nRyan\n\nReply to THIS message with changes and I'll revise. Nothing sends until you tap ✅.")
    expect(m.reply_markup.inline_keyboard).toEqual([[{ text: "✅ Send", callback_data: "dsend:ev-1" }, { text: "❌ Discard", callback_data: "ddisc:ev-1" }]])
  })
})

describe("email drafts and confirmations", () => {
  it("shows the subject it will go out under", () => {
    expect(emailDraftSubject({ subject: "Great meeting you at the Mega Meetup" }, "Following up")).toBe("Re: Great meeting you at the Mega Meetup")
    expect(emailDraftSubject({ subject: "Re: Re: Great meeting you" }, null)).toBe("Re: Great meeting you")
    expect(emailDraftSubject(null, "Re: Following up")).toBe("Following up")
    expect(emailDraftSubject(null, null)).toBe("Checking in")
  })
  it("says who, and whether it went in their thread", () => {
    expect(emailSentLabel("Ashley Cao", { threaded: true, mailbox: "ryan@lrghomes.com" })).toBe("Ashley Cao by email — same thread, from ryan@lrghomes.com")
    expect(emailSentLabel("Ashley Cao", { threaded: false, mailbox: "ryan@lrghomes.com" })).toBe("Ashley Cao by email — new email, from ryan@lrghomes.com")
    expect(emailReplyConfirmation("Ashley <Cao>", { threaded: true, mailbox: "ryan@lrghomes.com" })).toBe("✅ Emailed Ashley &lt;Cao&gt; — same thread, from ryan@lrghomes.com")
    expect(emailReplyConfirmation("Ashley", { threaded: false, mailbox: "ryan@lrghomes.com", touchLogged: false })).toBe("✅ Emailed Ashley — as a new email (no earlier thread on file), from ryan@lrghomes.com  ⚠️ (logged with a warning)")
  })
})
