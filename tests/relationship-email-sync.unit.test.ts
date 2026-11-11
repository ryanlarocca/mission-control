import { describe, it, expect, vi } from "vitest"

// 2026-11-11: ryan@ email with Relationships contacts lands on the card
// (briefs/BRIEF_RELATIONSHIP_EMAIL_SYNC_2026-11-11.md) — the pure parts of
// the sync (lib/relationshipEmailSync), the reply-thread choice
// (lib/relationshipEmail), the Personal skip (lib/inboundFacts) and notes
// from cell texts on card open (lib/cellTextNotes).

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }))
vi.mock("@/lib/leads", () => ({ getLeadsClient: vi.fn() }))
vi.mock("@/lib/llm", () => ({ completeText: vi.fn(), extractJsonObject: (t: string) => t, hasLlmKey: () => true, SONNET: "sonnet", HAIKU: "haiku", OPUS: "opus" }))

import {
  advancesContact,
  bounceNoteLine,
  cardsForMessage,
  indexCardsByEmail,
  normalEmail,
  normalizeSubject,
  parseSyncMessage,
  planTouchWrite,
  touchAction,
  touchBody,
  type SyncCard,
  type SyncMessage,
  type TouchLite,
} from "@/lib/relationshipEmailSync"
import { pickNewerThread, type EmailThreadRef } from "@/lib/relationshipEmail"
import { notesAllowed } from "@/lib/inboundFacts"
import { planCellTextNotes, MAX_BATCH_TEXTS } from "@/lib/cellTextNotes"

const card = (id: string, email: string | null, extra: Partial<SyncCard> = {}): SyncCard => ({
  id, name: id, email, status: "active", tier: "B", category: "Agent", last_contacted_at: null, ...extra,
})

const msg = (over: Partial<SyncMessage> = {}): SyncMessage => ({
  gmailId: "g1", threadId: "t1", direction: "inbound", at: "2026-11-11T21:33:53.000Z",
  from: "acao@oldcapitallending.com", to: [], subject: "Re: Great meeting you at the Mega Meetup",
  text: "Hi Ryan", failedRecipient: null, ...over,
})

describe("parseSyncMessage", () => {
  it("normalises a good entry", () => {
    const p = parseSyncMessage({
      gmailId: " 1a1c ", threadId: "1a1c", direction: "sent", at: "2026-11-11T21:33:53Z",
      from: "Ryan <RYAN@lrghomes.com>", to: ["A@B.com", "a@b.com", "not an address"], subject: " Hi ", text: "body",
    })
    expect(p).toEqual({ ok: true, msg: {
      gmailId: "1a1c", threadId: "1a1c", direction: "sent", at: "2026-11-11T21:33:53.000Z",
      from: "ryan@lrghomes.com", to: ["a@b.com"], subject: "Hi", text: "body", failedRecipient: null,
    } })
  })
  it("refuses a missing gmailId, a bad direction or a bad time", () => {
    expect(parseSyncMessage({ direction: "inbound", at: "2026-11-11T00:00:00Z" })).toMatchObject({ ok: false, gmailId: null })
    expect(parseSyncMessage({ gmailId: "x", direction: "reply", at: "2026-11-11T00:00:00Z" })).toMatchObject({ ok: false, gmailId: "x" })
    expect(parseSyncMessage({ gmailId: "x", direction: "inbound", at: "yesterday-ish" })).toMatchObject({ ok: false, gmailId: "x" })
  })
})

describe("card matching", () => {
  const byEmail = indexCardsByEmail([
    card("ashley", "ACao@OldCapitalLending.com"),
    card("tom", " tom@tran.cpa "),
    card("two", "a@x.com; b@x.com"),
    card("none", null),
  ])

  it("matches case-insensitively and indexes both addresses of a two-address field", () => {
    expect(normalEmail("Ashley <ACao@OldCapitalLending.com>")).toBe("acao@oldcapitallending.com")
    expect(byEmail.get("acao@oldcapitallending.com")?.map((c) => c.id)).toEqual(["ashley"])
    expect(byEmail.get("tom@tran.cpa")?.map((c) => c.id)).toEqual(["tom"])
    expect(byEmail.get("b@x.com")?.map((c) => c.id)).toEqual(["two"])
    expect(byEmail.size).toBe(4)
  })

  it("inbound → the sender's card; an unknown sender → no card (never add people)", () => {
    expect(cardsForMessage(msg(), byEmail).cards.map((c) => c.id)).toEqual(["ashley"])
    expect(cardsForMessage(msg({ from: "stranger@x.org" }), byEmail).cards).toEqual([])
  })

  it("sent → every To/Cc card; own mailboxes don't count toward a blast", () => {
    const m = msg({ direction: "sent", from: "ryan@lrghomes.com", to: ["acao@oldcapitallending.com", "tom@tran.cpa", "info@lrghomes.com", "x@y.com"] })
    const r = cardsForMessage(m, byEmail)
    expect(r.blast).toBeNull()
    expect(r.cards.map((c) => c.id).sort()).toEqual(["ashley", "tom"])
  })

  it("sent to 5 outside people is a conversation, 6 is a blast", () => {
    const five = ["acao@oldcapitallending.com", "a1@z.com", "a2@z.com", "a3@z.com", "a4@z.com"]
    expect(cardsForMessage(msg({ direction: "sent", to: five }), byEmail).blast).toBeNull()
    const six = cardsForMessage(msg({ direction: "sent", to: [...five, "a5@z.com"] }), byEmail)
    expect(six.blast).toBe(6)
    expect(six.cards.map((c) => c.id)).toEqual(["ashley"])
  })

  it("bounce → the card of the address that bounced, not the sender", () => {
    const m = msg({ direction: "bounce", from: "mailer-daemon@googlemail.com", failedRecipient: "tom@tran.cpa" })
    expect(cardsForMessage(m, byEmail).cards.map((c) => c.id)).toEqual(["tom"])
    expect(touchAction("bounce")).toBe("bounced")
  })
})

describe("planTouchWrite", () => {
  const touch = (over: Partial<TouchLite>): TouchLite => ({ id: "t", occurred_at: "2026-11-11T21:30:00.000Z", action: "inbound", message: "Subject\nbody", gmail_message_id: null, ...over })

  it("same Gmail id on the card = duplicate", () => {
    expect(planTouchWrite(msg(), [touch({ id: "d", gmail_message_id: "g1", occurred_at: "2026-10-01T00:00:00Z" })])).toEqual({ kind: "duplicate", touchId: "d" })
  })

  it("a hand-logged touch within 10 minutes is stamped; the closest wins", () => {
    const plan = planTouchWrite(msg(), [
      touch({ id: "far", occurred_at: "2026-11-11T21:25:00.000Z" }),
      touch({ id: "near", occurred_at: "2026-11-11T21:35:00.000Z" }),
    ])
    expect(plan).toEqual({ kind: "stamp", touchId: "near" })
  })

  it("same subject (Re:/Fwd: dropped) on the same Pacific day is stamped, hours apart", () => {
    // 1:33pm Pacific vs 9:05am Pacific, Nov 11.
    const t = touch({ id: "hand", occurred_at: "2026-11-11T17:05:00.000Z", message: "Great meeting you at the Mega Meetup\nhand-logged" })
    expect(planTouchWrite(msg(), [t])).toEqual({ kind: "stamp", touchId: "hand" })
  })

  it("an id-less email touch from after go-live is never stamped (a campaign-mailbox reply is a different email)", () => {
    const later = msg({ at: "2026-11-20T18:00:00Z" })
    const campaignReply = touch({ id: "campaign", occurred_at: "2026-11-20T18:02:00.000Z" })
    expect(planTouchWrite(later, [campaignReply])).toEqual({ kind: "insert" })
  })

  it("same subject on another Pacific day is a new email (UTC date would have said same day)", () => {
    // 2026-11-12T03:00Z is 7pm Nov 11 Pacific; 2026-11-12T17:00Z is 9am Nov 12 Pacific.
    const t = touch({ id: "hand", occurred_at: "2026-11-12T03:00:00.000Z", message: "Re: Great meeting you at the Mega Meetup\nx" })
    expect(planTouchWrite(msg({ at: "2026-11-12T17:00:00.000Z" }), [t])).toEqual({ kind: "insert" })
  })

  it("never stamps a touch of another action or one that already has a Gmail id", () => {
    expect(planTouchWrite(msg(), [touch({ action: "sent" }), touch({ gmail_message_id: "other" })])).toEqual({ kind: "insert" })
  })

  it("normalizeSubject collapses Re:/Fwd: chains and case", () => {
    expect(normalizeSubject("RE: Fwd: re:  Great   Meeting")).toBe("great meeting")
    expect(normalizeSubject(null)).toBe("")
  })
})

describe("contact clock + bodies", () => {
  it("last_contacted_at only moves forward", () => {
    expect(advancesContact(null, "2026-11-11T00:00:00Z")).toBe(true)
    expect(advancesContact("2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z")).toBe(true)
    expect(advancesContact("2026-11-12T00:00:00Z", "2026-11-11T00:00:00Z")).toBe(false)
    expect(advancesContact("2026-11-11T00:00:00Z", "2026-11-11T00:00:00Z")).toBe(false)
  })

  it("the touch keeps only the new text of a reply", () => {
    const text = "Sounds great, let's do lunch Tuesday.\n\nOn Tue, Nov 10, 2026 at 4:12 PM Ryan LaRocca <ryan@lrghomes.com> wrote:\n> Great meeting you"
    expect(touchBody(msg({ text }))).toBe("Sounds great, let's do lunch Tuesday.")
  })

  it("a bare forward keeps the forwarded text", () => {
    const text = "---------- Forwarded message ---------\nFrom: X <x@y.com>\nthe deal"
    expect(touchBody(msg({ text }))).toBe(text.trim())
  })

  it("bounce line", () => {
    expect(bounceNoteLine("Nov 11, 2026", "tom@tran.cpa")).toBe("[Nov 11, 2026 email] Email to tom@tran.cpa bounced — the address on this card may be wrong.")
    expect(touchBody(msg({ direction: "bounce", failedRecipient: "tom@tran.cpa" }))).toContain("tom@tran.cpa bounced")
  })
})

describe("notesAllowed", () => {
  it("skips Personal (and its legacy label) and do-not-contact", () => {
    expect(notesAllowed({ status: "active", category: "Agent" })).toBe(true)
    expect(notesAllowed({ status: "active", category: null })).toBe(true)
    expect(notesAllowed({ status: "active", category: "Personal" })).toBe(false)
    expect(notesAllowed({ status: "active", category: "Personal Contact" })).toBe(false)
    expect(notesAllowed({ status: "do_not_contact", category: "Investor" })).toBe(false)
  })
})

describe("pickNewerThread", () => {
  const ref = (threadId: string, campaignContactId: string | null): EmailThreadRef => ({ campaignContactId, mailbox: "ryan@lrghomes.com", threadId, gmailId: null, subject: null })
  const campaign = { ref: ref("camp", "cc1"), at: "2026-10-01T00:00:00Z" }
  const card = { ref: ref("ryan", null), at: "2026-11-11T00:00:00Z" }

  it("returns whichever of the two is newer", () => {
    expect(pickNewerThread(campaign, card)?.threadId).toBe("ryan")
    expect(pickNewerThread({ ...campaign, at: "2026-11-12T00:00:00Z" }, card)?.threadId).toBe("camp")
  })
  it("either alone, or neither", () => {
    expect(pickNewerThread(null, card)?.threadId).toBe("ryan")
    expect(pickNewerThread(campaign, null)?.threadId).toBe("camp")
    expect(pickNewerThread(null, null)).toBeNull()
  })
  it("a tie or an unknown time keeps the campaign thread", () => {
    expect(pickNewerThread({ ...campaign, at: card.at }, card)?.threadId).toBe("camp")
    expect(pickNewerThread(campaign, { ...card, at: null })?.threadId).toBe("camp")
  })
})

describe("planCellTextNotes", () => {
  const now = new Date("2026-11-11T22:00:00.000Z")
  const thread = [
    { at: "2026-11-11T18:00:00.000Z", fromMe: false, text: "Old text, already read" },
    { at: "2026-11-11T20:00:00.000Z", fromMe: true, text: "Ryan's own text" },
    { at: "2026-11-11T20:05:00.000Z", fromMe: false, text: "Business-line text", via: "+14084585442" },
    { at: "2026-11-11T20:10:00.000Z", fromMe: false, text: "Loved “Ryan's own text”" },
    { at: "2026-11-11T20:15:00.000Z", fromMe: false, text: "We just closed a 4-plex in Campbell, looking for another" },
  ]

  it("no marker → start the clock now, read nothing", () => {
    expect(planCellTextNotes(thread, null, now)).toEqual({ kind: "start", markTo: now.toISOString() })
  })

  it("reads only their cell texts newer than the marker, tapbacks dropped; marker → newest", () => {
    expect(planCellTextNotes(thread, "2026-11-11T19:00:00.000Z", now)).toEqual({
      kind: "read", markTo: "2026-11-11T20:15:00.000Z", texts: ["We just closed a 4-plex in Campbell, looking for another"],
    })
  })

  it("only tapbacks new → still moves the marker past them, nothing to read", () => {
    expect(planCellTextNotes(thread.slice(0, 4), "2026-11-11T19:00:00.000Z", now)).toEqual({ kind: "read", markTo: "2026-11-11T20:10:00.000Z", texts: [] })
  })

  it("nothing new → null", () => {
    expect(planCellTextNotes(thread, "2026-11-11T20:15:00.000Z", now)).toBeNull()
  })

  it("caps a long burst at the newest MAX_BATCH_TEXTS", () => {
    const burst = Array.from({ length: MAX_BATCH_TEXTS + 5 }, (_, i) => ({ at: new Date(Date.UTC(2026, 10, 11, 20, i)).toISOString(), fromMe: false, text: `text ${i}` }))
    const plan = planCellTextNotes(burst, "2026-11-11T19:00:00.000Z", now)
    expect(plan?.kind === "read" && plan.texts.length).toBe(MAX_BATCH_TEXTS)
    expect(plan?.kind === "read" && plan.texts[0]).toBe("text 5")
  })
})
