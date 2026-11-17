// Lead email sync (briefs/BRIEF_LEAD_EMAIL_SYNC_2026-11-17.md). Pure pieces only:
// the shared matching rules (scripts/inbox-agent/leadmatch.mjs), the mini's
// candidate filters + Relationships hand-off (leadmail.mjs), the row / alert
// builders (lib/leadEmailSync.ts) and the Relationships alert skip. No network.
import { describe, expect, it } from "vitest"
import * as matchModule from "../scripts/inbox-agent/leadmatch.mjs"
import * as mailModule from "../scripts/inbox-agent/leadmail.mjs"
import * as cardsModule from "../scripts/inbox-agent/cards.mjs"
import { buildLeadRow, leadEmailAlertAbout, leadEmailAlertText, outsideRecipients, SYNC_MAILBOX_LINE } from "@/lib/leadEmailSync"
import { emailAlertCard, parseSyncMessage, type SyncMessage } from "@/lib/relationshipEmailSync"
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const M = matchModule as unknown as Record<string, any>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const L = mailModule as unknown as Record<string, any>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const C = cardsModule as unknown as Record<string, any>

// Maryam's card, trimmed from the real rows (2026-11-17): phone-keyed, the
// hand-added offer email row has the thread but no Gmail id.
const MARYAM = [
  { id: "form", created_at: "2026-11-02T18:11:54.503Z", lead_type: "form", twilio_number: "+16506703914", caller_phone: "+16505207069", email: "maryamjnorton@gmail.com", name: "Maryam Norton", property_address: "5122 Severance Ct, San Jose, CA", source: "Website", source_type: "website", status: "active", is_junk: false, is_dnc: false, gmail_thread_id: null, gmail_message_id: null },
  { id: "sms-in", created_at: "2026-11-13T01:13:51.122Z", lead_type: "sms", twilio_number: "+16506703914", caller_phone: "+16505207069", email: "maryamjnorton@gmail.com", name: "Maryam Norton", property_address: "Severance Ct, San Jose, CA", source: "Website", source_type: "website", status: "active", is_junk: false, is_dnc: false, gmail_thread_id: null, gmail_message_id: null },
  { id: "hand", created_at: "2026-11-13T21:11:13Z", lead_type: "email", twilio_number: null, caller_phone: "+16505207069", email: "maryamjnorton@gmail.com", name: "Maryam Norton", property_address: "5122 Severance Ct, San Jose, CA 95136", source: "Website", source_type: null, status: "contacted", is_junk: false, is_dnc: false, gmail_thread_id: "1a1d6be335d9de09", gmail_message_id: null },
  { id: "call-out", created_at: "2026-11-17T20:28:56.989Z", lead_type: "call", twilio_number: null, caller_phone: "+16505207069", email: "maryamjnorton@gmail.com", name: "Maryam Norton", property_address: null, source: "Website", source_type: null, status: "contacted", is_junk: false, is_dnc: false, gmail_thread_id: null, gmail_message_id: null },
]
// David: two spellings of one Gmail address on his rows.
const DAVID = [
  { id: "d-call", created_at: "2026-11-16T22:08:21Z", lead_type: "call", twilio_number: "+14084188450", caller_phone: "+17073183456", email: "david.levitt@gmail.com", name: "David Leavitt", property_address: "3885 Magnolia Dr, Palo Alto, CA 94306", source: "NOO-Q4-2026-B", source_type: "direct_mail", status: "active", is_junk: false, is_dnc: false, gmail_thread_id: null, gmail_message_id: null },
  { id: "d-hand", created_at: "2026-11-17T20:45:12Z", lead_type: "email", twilio_number: null, caller_phone: "+17073183456", email: "davidlevitt@gmail.com", name: "David Leavitt", property_address: "3885 Magnolia Dr, Palo Alto, CA 94306", source: "NOO-Q4-2026-B", source_type: null, status: "contacted", is_junk: false, is_dnc: false, gmail_thread_id: "1a1eb41ae31153e9", gmail_message_id: null },
]
const JUNK = [{ id: "j1", created_at: "2026-11-01T00:00:00Z", lead_type: "email", twilio_number: "email:ryansvg@lrghomes.com", caller_phone: null, email: "spam@example.com", gmail_thread_id: "t-junk", name: "Spam", status: "dead", is_junk: true, is_dnc: false, gmail_message_id: "x" }]
// An email-only lead (no phone) keyed by its thread.
const EMAILONLY = [{ id: "e1", created_at: "2026-11-05T00:00:00Z", lead_type: "email", twilio_number: "email:ryansvj@lrghomes.com", caller_phone: null, email: "seller@yahoo.com", gmail_thread_id: "t-seller", name: "Sam Seller", status: "new", is_junk: false, is_dnc: false, gmail_message_id: "m-e1", property_address: null, source: "MFM-A", source_type: "direct_mail" }]
const index = M.buildLeadIndex([...MARYAM, ...DAVID, ...JUNK, ...EMAILONLY])

describe("leadEmailKey", () => {
  it("lower-cases and reads angle brackets", () => {
    expect(M.leadEmailKey("Maryam <MaryamJNorton@Gmail.com>")).toBe("maryamjnorton@gmail.com")
    expect(M.leadEmailKey("a@b.com ")).toBe("a@b.com")
  })
  it("folds Gmail dots and +tags (david.levitt = davidlevitt)", () => {
    expect(M.leadEmailKey("david.levitt@gmail.com")).toBe(M.leadEmailKey("davidlevitt@gmail.com"))
    expect(M.leadEmailKey("d.levitt+offers@googlemail.com")).toBe("dlevitt@gmail.com")
  })
  it("leaves other domains' dots alone and rejects junk", () => {
    expect(M.leadEmailKey("john.smith@yahoo.com")).toBe("john.smith@yahoo.com")
    expect(M.leadEmailKey("not an email")).toBe("")
    expect(M.leadEmailKey(null)).toBe("")
  })
})

describe("addresses that are never a lead", () => {
  it("Ryan's own domains and personal Gmail, machine senders", () => {
    for (const e of ["ryan@lrghomes.com", "info@lrghomesoffers.com", "Ryan.LaRocca9@gmail.com", "no-reply@accounts.google.com", "noreply@x.com", "mailer-daemon@googlemail.com", "notifications@github.com"]) {
      expect(M.isNeverLeadAddress(e)).toBe(true)
    }
    expect(M.isNeverLeadAddress("maryamjnorton@gmail.com")).toBe(false)
    expect(M.isNeverLeadAddress("noreen@x.com")).toBe(false)
  })
  it("a lead row carrying one doesn't make its sender a lead", () => {
    const own = M.buildLeadIndex([{ id: "x", created_at: "2026-10-19T00:00:00Z", lead_type: "sms", twilio_number: "+14085550000", caller_phone: "+14085551111", email: "ryanlarocca9@gmail.com", is_junk: false }])
    expect(M.isLeadMessage(own, { direction: "inbound", from: "ryanlarocca9@gmail.com", to: [], threadId: null })).toBe(false)
    expect(M.isLeadMessage(own, { direction: "sent", to: ["ryanlarocca9@gmail.com"], threadId: null })).toBe(false)
  })
})

describe("cards (groupLeads keys)", () => {
  it("phone first, then an email row's thread, then email, then id", () => {
    expect(M.cardKeyOf({ id: "1", caller_phone: "+14085551212", email: "a@b.com" })).toBe("phone:+14085551212")
    expect(M.cardKeyOf({ id: "1", caller_phone: "Anonymous", lead_type: "email", gmail_thread_id: "t1" })).toBe("thread:t1")
    expect(M.cardKeyOf({ id: "1", lead_type: "sms", gmail_thread_id: "t1", email: "A@B.com" })).toBe("email:a@b.com")
    expect(M.cardKeyOf({ id: "1" })).toBe("id:1")
  })
  it("indexes every row's email (Gmail-folded) and thread", () => {
    expect(index.byEmail.get("davidlevitt@gmail.com")).toEqual(["phone:+17073183456"])
    expect(index.byThread.get("1a1d6be335d9de09")).toEqual(["phone:+16505207069"])
    expect(index.clusters.get("phone:+16505207069").map((r: { id: string }) => r.id)).toEqual(["call-out", "hand", "sms-in", "form"])
  })
  it("profile: identity from the newest inbound row first; status inherited from it; junk from it", () => {
    const p = M.clusterProfile(index.clusters.get("phone:+16505207069"))
    expect(p.statusSource.id).toBe("sms-in")
    expect(p).toMatchObject({ phone: "+16505207069", name: "Maryam Norton", property_address: "Severance Ct, San Jose, CA", source: "Website", source_type: "website", inheritedStatus: "active", junk: false, dnc: false })
    expect(M.clusterProfile(JUNK).junk).toBe(true)
  })
})

describe("matchLeadClusters", () => {
  it("sent: To on a lead → that card, with the address as written", () => {
    const m = M.matchLeadClusters(index, { direction: "sent", to: ["davidlevitt@gmail.com"], threadId: "1a1eb41ae31153e9" })
    expect(m.matches).toEqual([{ key: "phone:+17073183456", address: "davidlevitt@gmail.com", via: "thread" }])
  })
  it("sent: the thread alone is not enough (a forward of the lead's thread to someone else)", () => {
    expect(M.matchLeadClusters(index, { direction: "sent", to: ["attorney@law.com"], threadId: "1a1d6be335d9de09" }).matches).toEqual([])
  })
  it("sent: two leads → both cards, the thread's card first; a blast is skipped", () => {
    const m = M.matchLeadClusters(index, { direction: "sent", to: ["davidlevitt@gmail.com", "maryamjnorton@gmail.com"], threadId: "1a1d6be335d9de09" })
    expect(m.matches.map((x: { key: string }) => x.key)).toEqual(["phone:+16505207069", "phone:+17073183456"])
    const blast = M.matchLeadClusters(index, { direction: "sent", to: ["maryamjnorton@gmail.com", "a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"], threadId: null })
    expect(blast.blast).toBe(6)
  })
  it("inbound: the sender's card; Gmail dots don't matter", () => {
    const m = M.matchLeadClusters(index, { direction: "inbound", from: "david.levitt@gmail.com", to: [], threadId: "zzz" })
    expect(m.matches).toEqual([{ key: "phone:+17073183456", address: "david.levitt@gmail.com", via: "address" }])
  })
  it("inbound: an unknown address on a lead's thread → that card, unless the lead is on To/Cc (a third party replying all)", () => {
    expect(M.matchLeadClusters(index, { direction: "inbound", from: "maryam@work.com", to: [], threadId: "1a1d6be335d9de09" }).matches).toEqual([{ key: "phone:+16505207069", address: "maryam@work.com", via: "thread" }])
    expect(M.matchLeadClusters(index, { direction: "inbound", from: "agent@realty.com", to: ["maryamjnorton@gmail.com"], threadId: "1a1d6be335d9de09" }).matches).toEqual([])
  })
  it("junk cards are skipped and said so; no lead → nothing", () => {
    const m = M.matchLeadClusters(index, { direction: "inbound", from: "spam@example.com", to: [], threadId: null })
    expect(m.matches).toEqual([])
    expect(m.skipped).toEqual([{ key: "thread:t-junk", reason: "junk" }])
    expect(M.isLeadMessage(index, { direction: "inbound", from: "stranger@x.com", to: [], threadId: null })).toBe(false)
  })
})

describe("planLeadWrite (dedupe + hand-added rows)", () => {
  const maryam = index.clusters.get("phone:+16505207069")
  const sent = { direction: "sent", at: "2026-11-13T21:11:13.000Z", threadId: "1a1d6be335d9de09" }
  it("Maryam's hand-added offer row is recognised → stamp, not a second row", () => {
    expect(M.planLeadWrite(sent, "1a1d6c00e8d5bcea", maryam, { mailboxLine: SYNC_MAILBOX_LINE })).toEqual({ kind: "stamp", leadId: "hand" })
  })
  it("David's hand-added referral row is recognised (other spelling of his address)", () => {
    const david = index.clusters.get("phone:+17073183456")
    expect(M.planLeadWrite({ direction: "sent", at: "2026-11-17T20:45:12.000Z", threadId: "1a1eb41ae31153e9" }, "1a1eb41ae31153e9", david, { mailboxLine: SYNC_MAILBOX_LINE })).toEqual({ kind: "stamp", leadId: "d-hand" })
  })
  it("a row already carrying the id = duplicate", () => {
    const rows = [{ ...maryam[1], id: "had", gmail_message_id: "g1" }]
    expect(M.planLeadWrite(sent, "g1", rows, { mailboxLine: SYNC_MAILBOX_LINE })).toEqual({ kind: "duplicate", leadId: "had" })
  })
  it("too far apart, another thread, an outbound call or an inbound row → insert", () => {
    expect(M.planLeadWrite({ ...sent, at: "2026-11-13T21:40:00Z" }, "g", maryam, { mailboxLine: SYNC_MAILBOX_LINE })).toEqual({ kind: "insert" })
    expect(M.planLeadWrite({ ...sent, threadId: "other" }, "g", maryam, { mailboxLine: SYNC_MAILBOX_LINE })).toEqual({ kind: "insert" })
    expect(M.planLeadWrite({ ...sent, at: "2026-11-17T20:28:57Z", threadId: "t9" }, "g", maryam, { mailboxLine: SYNC_MAILBOX_LINE })).toEqual({ kind: "insert" })
    expect(M.planLeadWrite({ direction: "inbound", at: "2026-11-13T21:11:13Z", threadId: "1a1d6be335d9de09" }, "g", maryam, { mailboxLine: SYNC_MAILBOX_LINE })).toEqual({ kind: "insert" })
  })
  it("a card / drip send with no thread on its row, minutes before → stamp", () => {
    const rows = [{ id: "drip", created_at: "2026-11-13T21:10:00Z", lead_type: "drip_email", twilio_number: null, gmail_thread_id: null, gmail_message_id: null }]
    expect(M.planLeadWrite(sent, "g", rows, { mailboxLine: SYNC_MAILBOX_LINE })).toEqual({ kind: "stamp", leadId: "drip" })
  })
  it("an inbound row added by hand on the ryan@ line → stamp", () => {
    const rows = [{ id: "in", created_at: "2026-11-18T01:00:30Z", lead_type: "email", twilio_number: "email:ryan@lrghomes.com", gmail_thread_id: "t", gmail_message_id: null }]
    expect(M.planLeadWrite({ direction: "inbound", at: "2026-11-18T01:00:00Z", threadId: "t" }, "g", rows, { mailboxLine: SYNC_MAILBOX_LINE })).toEqual({ kind: "stamp", leadId: "in" })
  })
  it("the first card a send matched carries the Gmail id; others a stable suffix", () => {
    expect(M.leadRowMessageId("g1", 0, "phone:+1")).toBe("g1")
    expect(M.leadRowMessageId("g1", 1, "phone:+1")).toBe("g1:phone:+1")
  })
})

describe("rows and the alert (lib/leadEmailSync)", () => {
  const p = M.clusterProfile(index.clusters.get("phone:+16505207069"))
  const msg: SyncMessage = { gmailId: "g9", threadId: "1a1d6be335d9de09", direction: "inbound", at: "2026-11-18T01:00:00.000Z", from: "maryamjnorton@gmail.com", to: [], subject: "Re: Offer for 5122 Severance Ct", text: "Thanks Ryan, we'll review.\n\nOn Thu, Nov 13, 2026 at 1:11 PM Ryan LaRocca <ryan@lrghomes.com> wrote:\n> Hi Maryam", failedRecipient: null }
  it("inbound row: the ryan@ line, inherited status, the card's identity, the email's own time, quoted thread cut", () => {
    expect(buildLeadRow(msg, p, { address: "maryamjnorton@gmail.com", rowMessageId: "g9" })).toEqual({
      lead_type: "email", twilio_number: "email:ryan@lrghomes.com", status: "active", caller_phone: "+16505207069", name: "Maryam Norton",
      property_address: "Severance Ct, San Jose, CA", source: "Website", source_type: "website", email: "maryamjnorton@gmail.com",
      message: "Re: Offer for 5122 Severance Ct\n\nThanks Ryan, we'll review.", gmail_message_id: "g9", gmail_thread_id: "1a1d6be335d9de09", created_at: "2026-11-18T01:00:00.000Z",
    })
  })
  it("sent row: Ryan out (no line), contacted", () => {
    const row = buildLeadRow({ ...msg, direction: "sent", from: "ryan@lrghomes.com" }, p, { address: "maryamjnorton@gmail.com", rowMessageId: "g9" })
    expect(row).toMatchObject({ twilio_number: null, status: "contacted", lead_type: "email" })
    expect(M.isRyanOutRow(row)).toBe(true)
  })
  it("alert: who, the card, the subject, the new text; DNC + opt-out said; records the lead", () => {
    const text = leadEmailAlertText(p, msg, "Thanks Ryan, we'll review <soon>.")
    expect(text).toBe([
      "📧 <b>Email from a lead</b> (ryan@)", "[Website]", "👤 Maryam Norton · Severance Ct, San Jose, CA", "📧 maryamjnorton@gmail.com", "📞 (650) 520-7069",
      "<b>Re: Offer for 5122 Severance Ct</b>", "\"Thanks Ryan, we'll review &lt;soon&gt;.\"",
    ].join("\n"))
    expect(leadEmailAlertText(p, msg, "Remove me", { dnc: true, optOut: true })).toMatch(/do-not-contact[\s\S]*asked to be removed/)
    expect(leadEmailAlertAbout("row1", "maryamjnorton@gmail.com", "+16505207069")).toEqual({ kind: "lead", leadId: "row1", email: "maryamjnorton@gmail.com", phone: "+16505207069" })
  })
  it("outside recipients drop Ryan's own domains", () => {
    expect(outsideRecipients(["ryan@lrghomes.com", "info@lrghomesoffers.com", "x@y.com"])).toEqual(["x@y.com"])
  })
})

describe("the mini (leadmail.mjs)", () => {
  const since = "2026-11-10T00:00:00Z"
  it("inbound candidates: this mailbox, human | deal_lead, in the window, a lead's address or thread", () => {
    const rows = [
      { gmail_id: "a", thread_id: "t", mailbox: "ryan@lrghomes.com", internal_date: "2026-11-18T00:00:00Z", sender: "MaryamJNorton@gmail.com", subject: "Re", kind: "human" },
      { gmail_id: "b", thread_id: "1a1eb41ae31153e9", mailbox: "ryan@lrghomes.com", internal_date: "2026-11-18T00:00:00Z", sender: "dl@work.com", subject: "Re", kind: "deal_lead" },
      { gmail_id: "c", thread_id: "t", mailbox: "ryan@lrghomes.com", internal_date: "2026-11-18T00:00:00Z", sender: "maryamjnorton@gmail.com", subject: "x", kind: "automated" },
      { gmail_id: "d", thread_id: "t", mailbox: "ryan@lrghomes.com", internal_date: "2026-11-01T00:00:00Z", sender: "maryamjnorton@gmail.com", subject: "old", kind: "human" },
      { gmail_id: "e", thread_id: "t", mailbox: "ryan@lrghomes.com", internal_date: "2026-11-18T00:00:00Z", sender: "stranger@x.com", subject: "x", kind: "human" },
      { gmail_id: "f", thread_id: "t", mailbox: "ryan@lrghomes.com", internal_date: "2026-11-18T00:00:00Z", sender: "spam@example.com", subject: "x", kind: "human" },
    ]
    expect(L.leadInboundCandidates(rows, { index, sinceIso: since, mailbox: "ryan@lrghomes.com" }).map((c: { gmailId: string }) => c.gmailId)).toEqual(["a", "b"])
  })
  it("sent candidates: a lead in To/Cc; the rest remembered as no-lead", () => {
    const metas = [
      { id: "s1", threadId: "1a1d6be335d9de09", internalDate: "2026-11-13T21:11:13Z", to: "maryamjnorton@gmail.com", cc: "" },
      { id: "s2", threadId: "x", internalDate: "2026-11-13T21:11:13Z", to: "Bob <bob@x.com>", cc: "ryan@lrghomes.com" },
      { id: "s3", threadId: "1a1d6be335d9de09", internalDate: "2026-11-13T21:11:13Z", to: "lawyer@x.com", cc: "" },
    ]
    const out = L.leadSentCandidates(metas, { index, sinceIso: since, mailbox: "ryan@lrghomes.com" })
    expect(out.matches.map((m: { gmailId: string }) => m.gmailId)).toEqual(["s1"])
    expect(out.noLead).toEqual(["s2", "s3"])
  })
  it("the Relationships hand-off: lead row → quiet; not done yet → hold; lead side done with nothing → as before", () => {
    expect(L.leadGateDecision({ isLead: true, hasRow: true, leadDone: true })).toBe("lead")
    expect(L.leadGateDecision({ isLead: true, hasRow: false, leadDone: false })).toBe("hold")
    expect(L.leadGateDecision({ isLead: true, hasRow: false, leadDone: true })).toBe(null)
    expect(L.leadGateDecision({ isLead: false, hasRow: false, leadDone: false })).toBe(null)
  })
  it("the dry-run preview shows the stamp on Maryam's hand-added row", () => {
    const preview = L.previewPlan(index, { gmailId: "1a1d6c00e8d5bcea", direction: "sent", at: "2026-11-13T21:11:13Z", threadId: "1a1d6be335d9de09", from: "ryan@lrghomes.com", to: ["maryamjnorton@gmail.com"] }, "ryan@lrghomes.com")
    expect(preview).toEqual([{ card: "phone:+16505207069", name: "Maryam Norton", via: "thread", action: "stamp row hand" }])
  })
  it("failure line reads plainly", () => {
    expect(L.leadAlertText("Mission Control answered HTTP 500")).toBe("⚠️ Lead email sync is failing — Mission Control answered HTTP 500. Nothing is lost; it will catch up.")
  })
})

describe("one alert per email across Leads and Relationships", () => {
  const base = { gmailId: "g", threadId: "t", direction: "inbound" as const, at: "2026-11-18T00:00:00Z", from: "maryamjnorton@gmail.com", to: [], subject: "Re", text: "hi", failedRecipient: null }
  it("cards.mjs posts leadCard only when true, only inbound", () => {
    const msg = { id: "g", threadId: "t", internalDate: "2026-11-18T00:00:00.000Z", from: { email: "maryamjnorton@gmail.com" }, to: "ryan@lrghomes.com", cc: "", subject: "Re", text: "hi" }
    expect(C.buildPayload(msg, "inbound", { kind: "human", leadCard: true }).leadCard).toBe(true)
    expect("leadCard" in C.buildPayload(msg, "inbound", { kind: "human" })).toBe(false)
    expect("leadCard" in C.buildPayload(msg, "sent", { leadCard: true })).toBe(false)
  })
  it("the Relationships sync parses leadCard and doesn't alert for it", () => {
    const parsed = parseSyncMessage({ ...base, leadCard: true })
    expect(parsed.ok && parsed.msg.leadCard).toBe(true)
    const logged = [{ relationshipId: "r1", name: "M", status: "logged" as const, note: null }]
    expect(emailAlertCard({ ...base, leadCard: true }, logged, false)).toBe(null)
    expect(emailAlertCard(base, logged, false)).toBe("r1")
  })
})
