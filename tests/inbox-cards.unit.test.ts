// Inbox agent — Relationships email sync (briefs/BRIEF_RELATIONSHIP_EMAIL_SYNC_2026-11-11.md, work package B).
// Pure pieces only: address parsing, own-domain stripping, candidate filtering, bounce recipients,
// result handling, done-list trimming, batching, the alert throttle. No network.
import { describe, expect, it } from "vitest"
import * as cardsModule from "../scripts/inbox-agent/cards.mjs"
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const {
  alertDecision, alertText, bounceBriefLine, bounceCandidates, bounceRecipients, bounceTarget, buildPayload, cardEmailMap, chunk,
  dropDone, inboundCandidates, interpretResults, isBounce, isOwnAddress, nextStreak, parseAddressList, parseEmailList, parseSince,
  queueBounces, recipientsOf, sentCandidates, sinceWindow, trimDone,
} = cardsModule as unknown as Record<string, any>

const MAILBOX = "ryan@lrghomes.com"
const cards = cardEmailMap([
  { id: "1", name: "Ashley Cao", email: "ACao@OldCapitalLending.com" },
  { id: "2", name: "Bob", email: "bob@example.com" },
  { id: "3", name: "No Email", email: null },
  { id: "4", name: "Bad", email: "not-an-email" },
])

describe("parseAddressList", () => {
  it("lower-cases, handles names, quoted commas and bare addresses", () => {
    expect(parseAddressList('Ashley Cao <ACao@OldCapitalLending.com>, bob@example.com')).toEqual(["acao@oldcapitallending.com", "bob@example.com"])
    expect(parseAddressList('"Cao, Ashley" <a@b.com>, "x" <c@d.org>')).toEqual(["a@b.com", "c@d.org"])
    expect(parseAddressList("a@b.com, A@B.com")).toEqual(["a@b.com"])
  })
  it("ignores groups, empties and junk", () => {
    expect(parseAddressList("undisclosed-recipients:;")).toEqual([])
    expect(parseAddressList("")).toEqual([])
    expect(parseAddressList(undefined)).toEqual([])
    expect(parseAddressList("nonsense")).toEqual([])
  })
  it("reads an X-Failed-Recipients style list", () => {
    expect(parseAddressList("one@a.com,two@b.com")).toEqual(["one@a.com", "two@b.com"])
  })
})

describe("own-domain stripping", () => {
  it("knows Ryan's domains and the mailbox", () => {
    expect(isOwnAddress("ryan@lrghomes.com")).toBe(true)
    expect(isOwnAddress("ryan@lrghomesbuys.com")).toBe(true)
    expect(isOwnAddress("Ryan@LRGHomesOffers.com")).toBe(true)
    expect(isOwnAddress("someone@gmail.com")).toBe(false)
    expect(isOwnAddress("x@notlrghomes.com")).toBe(false)
    expect(isOwnAddress("custom@box.com", "custom@box.com")).toBe(true)
  })
  it("removes own addresses from To + Cc and de-duplicates", () => {
    expect(recipientsOf("Ashley <acao@oldcapitallending.com>, ryan@lrghomes.com", "info@lrghomes.com, BOB@example.com, acao@oldcapitallending.com", MAILBOX)).toEqual(["acao@oldcapitallending.com", "bob@example.com"])
    expect(recipientsOf("ryan@lrghomes.com", "", MAILBOX)).toEqual([])
  })
})

describe("cardEmailMap", () => {
  it("lower-cases, skips empty/invalid, keeps id + name", () => {
    expect([...cards.keys()].sort()).toEqual(["acao@oldcapitallending.com", "bob@example.com"])
    expect(cards.get("acao@oldcapitallending.com")).toEqual({ id: "1", name: "Ashley Cao" })
  })
  it("narrows to a hand-picked list (never adds people)", () => {
    const only = parseEmailList("BOB@example.com, stranger@x.com; nope")
    expect([...only]).toEqual(["bob@example.com", "stranger@x.com"])
    const m = cardEmailMap([{ id: "1", email: "a@b.com" }, { id: "2", email: "bob@example.com" }], only)
    expect([...m.keys()]).toEqual(["bob@example.com"])
  })
})

describe("window", () => {
  const now = Date.parse("2026-11-20T12:00:00Z")
  it("parses 2d / 36h / dates and rejects junk", () => {
    expect(parseSince("2d", now)).toBe("2026-11-18T12:00:00.000Z")
    expect(parseSince("36h", now)).toBe("2026-11-19T00:00:00.000Z")
    expect(parseSince("2026-11-10", now)).toBe("2026-11-10T00:00:00.000Z")
    expect(parseSince("soon", now)).toBeNull()
    expect(parseSince("", now)).toBeNull()
  })
  it("start line wins when recent, 8 days is the floor, --cards-since beats both", () => {
    expect(sinceWindow({ startLine: "2026-11-19T00:00:00.000Z", now })).toBe("2026-11-19T00:00:00.000Z")
    expect(sinceWindow({ startLine: "2026-11-01T00:00:00.000Z", now })).toBe("2026-11-12T12:00:00.000Z")
    expect(sinceWindow({ startLine: "2026-11-19T00:00:00.000Z", cliSince: "2026-11-01T00:00:00.000Z", now })).toBe("2026-11-01T00:00:00.000Z")
  })
})

describe("inboundCandidates", () => {
  const since = "2026-11-10T00:00:00.000Z"
  const row = (o: object) => ({ gmail_id: "g1", thread_id: "t1", mailbox: MAILBOX, internal_date: "2026-11-11T21:33:53Z", sender: "acao@oldcapitallending.com", subject: "Re: hi", kind: "human", ...o })
  it("keeps human / deal_lead mail from a card email since the window", () => {
    const out = inboundCandidates([row({}), row({ gmail_id: "g2", kind: "deal_lead", sender: "bob@example.com" })], { cardEmails: cards, sinceIso: since })
    expect(out.map((c: { gmailId: string }) => c.gmailId)).toEqual(["g1", "g2"])
    expect(out[0]).toMatchObject({ direction: "inbound", from: "acao@oldcapitallending.com", threadId: "t1" })
  })
  it("drops other kinds, strangers, other mailboxes, old mail and our own sender", () => {
    const rows = [
      row({ gmail_id: "a", kind: "broker_blast" }),
      row({ gmail_id: "b", kind: "automated" }),
      row({ gmail_id: "c", sender: "stranger@x.com" }),
      row({ gmail_id: "d", mailbox: "info@lrghomes.com" }),
      row({ gmail_id: "e", internal_date: "2026-11-09T23:00:00Z" }),
      row({ gmail_id: "f", sender: "ryan@lrghomes.com" }),
    ]
    expect(inboundCandidates(rows, { cardEmails: cards, sinceIso: since })).toEqual([])
  })
  it("matches a sender typed with capitals", () => {
    expect(inboundCandidates([row({ sender: "ACao@OldCapitalLending.com" })], { cardEmails: cards, sinceIso: since })).toHaveLength(1)
  })
})

describe("sentCandidates", () => {
  const since = "2026-11-10T00:00:00.000Z"
  const meta = (o: object) => ({ id: "s1", threadId: "t", internalDate: "2026-11-11T20:00:00.000Z", to: "Ashley <acao@oldcapitallending.com>", cc: "", ...o })
  it("needs at least one To/Cc on a card; reports the rest as noCard", () => {
    const { matches, noCard } = sentCandidates([
      meta({}),
      meta({ id: "s2", to: "stranger@x.com", cc: "bob@example.com" }),
      meta({ id: "s3", to: "stranger@x.com" }),
      meta({ id: "s4", to: "ryan@lrghomes.com, info@lrghomes.com" }),
    ], { cardEmails: cards, sinceIso: since })
    expect(matches.map((m: { gmailId: string }) => m.gmailId)).toEqual(["s1", "s2"])
    expect(noCard).toEqual(["s3", "s4"])
    expect(matches[1].recipients).toEqual(["stranger@x.com", "bob@example.com"])
    expect(matches[1].cardRecipients).toEqual(["bob@example.com"])
  })
  it("ignores mail before the window", () => {
    expect(sentCandidates([meta({ internalDate: "2026-11-01T00:00:00.000Z" })], { cardEmails: cards, sinceIso: since })).toEqual({ matches: [], noCard: [] })
  })
})

describe("dropDone", () => {
  it("skips the done-list, the skipped list and ids that already have a touch", () => {
    const c = [{ gmailId: "a" }, { gmailId: "b" }, { gmailId: "c" }, { gmailId: "d" }]
    expect(dropDone(c, { done: new Set(["a"]), touched: new Set(["b"]), skipped: new Set(["c"]) })).toEqual([{ gmailId: "d" }])
    expect(dropDone(c)).toHaveLength(4)
  })
})

describe("bounces", () => {
  it("spots delivery failures by sender or subject", () => {
    expect(isBounce({ sender: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Failure)" })).toBe(true)
    expect(isBounce({ sender: "postmaster@example.com", subject: "hi" })).toBe(true)
    expect(isBounce({ sender: "bob@example.com", subject: "Undeliverable: hello" })).toBe(true)
    expect(isBounce({ sender: "bob@example.com", subject: "Lunch?" })).toBe(false)
  })
  it("trusts X-Failed-Recipients first", () => {
    expect(bounceRecipients({ header: "Bob@Example.com", text: "Your message wasn't delivered to other@x.com because" })).toEqual(["bob@example.com", "other@x.com"])
  })
  it("reads Gmail's own bounce wording", () => {
    const text = "Delivery incomplete\n\nYour message wasn't delivered to acao@oldcapitallending.com because the address couldn't be found.\n\nThe response was: 550 5.1.1"
    expect(bounceRecipients({ text })).toEqual(["acao@oldcapitallending.com"])
  })
  it("reads 'Delivery to the following recipient failed permanently'", () => {
    const text = "Delivery to the following recipient failed permanently:\n\n     bob@example.com\n\nTechnical details of permanent failure:"
    expect(bounceRecipients({ text })).toEqual(["bob@example.com"])
  })
  it("reads DSN Final-Recipient and Postfix '<x>:' lines", () => {
    expect(bounceRecipients({ text: "Final-Recipient: rfc822; Bob@Example.com\nAction: failed" })).toEqual(["bob@example.com"])
    expect(bounceRecipients({ text: "This is the mail system.\n\n<bob@example.com>: host mx.example.com said: 550 no such user" })).toEqual(["bob@example.com"])
  })
  it("falls back to the first outside address and never returns our own or system addresses", () => {
    const text = "mailer-daemon@googlemail.com reports a problem sending from ryan@lrghomes.com to carol@elsewhere.org (ref x)."
    expect(bounceRecipients({ text })).toEqual(["carol@elsewhere.org"])
    expect(bounceRecipients({ text: "nothing useful" })).toEqual([])
  })
  it("only a card email becomes the target", () => {
    expect(bounceTarget(["x@y.com", "bob@example.com"], cards)).toBe("bob@example.com")
    expect(bounceTarget(["x@y.com"], cards)).toBeNull()
    expect(bounceTarget([], cards)).toBeNull()
  })
  it("bounceCandidates picks system mail inside the window", () => {
    const rows = [
      { gmail_id: "b1", mailbox: MAILBOX, internal_date: "2026-11-11T10:00:00Z", sender: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Failure)" },
      { gmail_id: "b2", mailbox: MAILBOX, internal_date: "2026-11-01T10:00:00Z", sender: "mailer-daemon@googlemail.com", subject: "old" },
      { gmail_id: "b3", mailbox: MAILBOX, internal_date: "2026-11-11T10:00:00Z", sender: "dmarc@google.com", subject: "report" },
    ]
    expect(bounceCandidates(rows, { sinceIso: "2026-11-10T00:00:00.000Z" }).map((c: { gmailId: string }) => c.gmailId)).toEqual(["b1"])
  })
})

describe("buildPayload", () => {
  const msg = {
    id: "g1", threadId: "t1", internalDate: "2026-11-11T21:33:53.000Z", from: { email: "ACao@OldCapitalLending.com", name: "A" },
    to: "Ryan <ryan@lrghomes.com>", cc: "bob@example.com", subject: "Re: hi", text: "x".repeat(60_000),
  }
  it("matches the contract and strips own addresses", () => {
    const p = buildPayload(msg, "inbound")
    expect(p).toMatchObject({ gmailId: "g1", threadId: "t1", direction: "inbound", at: "2026-11-11T21:33:53Z", from: "acao@oldcapitallending.com", to: ["bob@example.com"], subject: "Re: hi", failedRecipient: null })
    expect(p.text.length).toBe(50_000)
  })
  it("a bounce carries the failed recipient and no To", () => {
    const p = buildPayload({ ...msg, from: { email: "mailer-daemon@googlemail.com" } }, "bounce", { failedRecipient: "bob@example.com" })
    expect(p).toMatchObject({ direction: "bounce", to: [], failedRecipient: "bob@example.com" })
  })
  it("an inbound message carries how the poll classified it; sent mail never does", () => {
    expect(buildPayload(msg, "inbound", { kind: "deal_lead" }).kind).toBe("deal_lead")
    expect(buildPayload(msg, "inbound").kind).toBeNull()
    expect(buildPayload(msg, "sent", { kind: "human" }).kind).toBeNull()
  })
})

describe("batching and the done-list", () => {
  it("splits into batches of at most 10", () => {
    expect(chunk(Array.from({ length: 25 }, (_, i) => i)).map((b: number[]) => b.length)).toEqual([10, 10, 5])
    expect(chunk([])).toEqual([])
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]])
  })
  it("keeps the newest 500, collapses repeats", () => {
    const ids = Array.from({ length: 520 }, (_, i) => `m${i}`)
    const t = trimDone(ids)
    expect(t).toHaveLength(500)
    expect(t[0]).toBe("m20")
    expect(t[499]).toBe("m519")
    expect(trimDone(["a", "b", "a", "", "c"])).toEqual(["b", "a", "c"])
    expect(trimDone(undefined)).toEqual([])
  })
})

describe("interpretResults", () => {
  const sent = [
    { gmailId: "a", direction: "inbound", failedRecipient: null },
    { gmailId: "b", direction: "sent", failedRecipient: null },
    { gmailId: "c", direction: "bounce", failedRecipient: "bob@example.com" },
    { gmailId: "d", direction: "bounce", failedRecipient: "x@y.com" },
    { gmailId: "e", direction: "sent", failedRecipient: null },
  ]
  it("done:true is finished, done:false and missing stay queued, only a logged bounce is queued for the brief", () => {
    const out = interpretResults(sent, [
      { gmailId: "a", cards: [], done: true },
      { gmailId: "b", cards: [], done: false },
      { gmailId: "c", cards: [{ relationshipId: "2", name: "Bob", status: "logged" }], done: true },
      { gmailId: "d", cards: [{ relationshipId: "9", name: "Zed", status: "skipped", reason: "dnc" }], done: true },
    ])
    expect(out.done).toEqual(["a", "c", "d"])
    expect(out.retry).toEqual(["b", "e"])
    expect(out.bounces).toEqual([{ gmailId: "c", name: "Bob", addr: "bob@example.com" }])
  })
  it("a garbage response retries everything", () => {
    expect(interpretResults(sent, null).retry).toHaveLength(5)
    expect(interpretResults(sent, "oops").done).toEqual([])
  })
  it("a duplicate bounce is finished but not announced again", () => {
    const out = interpretResults([sent[2]], [{ gmailId: "c", cards: [{ name: "Bob", status: "duplicate" }], done: true }])
    expect(out).toEqual({ done: ["c"], retry: [], bounces: [] })
  })
})

describe("alert throttle", () => {
  it("counts failed passes in a row and resets on success", () => {
    expect(nextStreak(0, true)).toBe(1)
    expect(nextStreak(2, true)).toBe(3)
    expect(nextStreak(2, false)).toBe(0)
    expect(nextStreak(undefined, true)).toBe(1)
  })
  it("alerts only from the third failed pass, once per Pacific day", () => {
    expect(alertDecision({ streak: 1, alertedDate: null, today: "2026-11-11" })).toBe(false)
    expect(alertDecision({ streak: 2, alertedDate: null, today: "2026-11-11" })).toBe(false)
    expect(alertDecision({ streak: 3, alertedDate: null, today: "2026-11-11" })).toBe(true)
    expect(alertDecision({ streak: 9, alertedDate: "2026-11-11", today: "2026-11-11" })).toBe(false)
    expect(alertDecision({ streak: 9, alertedDate: "2026-11-10", today: "2026-11-11" })).toBe(true)
    expect(alertDecision({ streak: 0, alertedDate: null, today: "2026-11-11" })).toBe(false)
  })
  it("uses the wording from the brief and escapes the reason", () => {
    expect(alertText("Mission Control answered HTTP 500")).toBe("⚠️ Relationships email sync is failing — Mission Control answered HTTP 500. Nothing is lost; it will catch up.")
    expect(alertText("a <b> & c")).toContain("a &lt;b&gt; &amp; c")
  })
})

describe("morning brief line", () => {
  it("says who and which address", () => {
    expect(bounceBriefLine({ name: "Ashley Cao", addr: "acao@oldcapitallending.com" })).toBe("📭 Your email to Ashley Cao (acao@oldcapitallending.com) bounced — the address on their card may be wrong.")
  })
  it("queues once per message + address and caps the queue", () => {
    const q = queueBounces([], [{ gmailId: "c", name: "Bob", addr: "bob@example.com" }], "2026-11-11T00:00:00Z")
    expect(queueBounces(q, [{ gmailId: "c", name: "Bob", addr: "bob@example.com" }])).toHaveLength(1)
    expect(queueBounces(q, [{ gmailId: "d", name: "Bob", addr: "bob@example.com" }])).toHaveLength(2)
    expect(queueBounces([], Array.from({ length: 80 }, (_, i) => ({ gmailId: `g${i}`, name: "n", addr: "a@b.com" })))).toHaveLength(50)
  })
})
