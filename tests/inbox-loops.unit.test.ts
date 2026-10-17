// Inbox agent — loop hygiene (briefs/BRIEF_INBOX_LOOP_HYGIENE_2026-10-17.md, Parts A–F).
// Pure pieces only, on the real 2026-10-12 → 10-16 sequences Ryan diagnosed:
//   A. a reply counts against the email's date, not the loop row's
//   B. a reply to the same person counts on any thread
//   C. HomeSentry paid / updated / report-filed and FreshBooks $0.00 close loops + loose ends
//   D. one ask = one loop (the three Quito emails)
//   E. relays are never "Unanswered"
//   F. owed_by → "Waiting on them"
// The last block replays the whole week in memory and checks the brief the digest would print.
import { describe, expect, it } from "vitest"
import {
  LOOP_KEY_WINDOW_MS, RELAY_SENDER_RE, SENT_LOOKBACK_DAYS,
  answeredBy, askKind, completionCloses, completionDismisses, completionEvent, completionMatch, envelopeMatches, foldSent, forwardOrigin, isLooseEnd,
  loopEligible, loopKey, loopKeyMatch, mergeLoop, owedBy, owedByFromReply, parseAddressList, parseLoopKey, replyResolves, reportFiledEvent, splitLoops, vendorFamilyOf,
} from "../scripts/inbox-agent/loops.mjs"
import { addressIn } from "../scripts/inbox-agent/fetch/providers.mjs"

type Msg = { id: string; threadId: string; from: { email: string; name?: string }; subject: string; internalDate: string; text: string; to?: string; cc?: string }
type Cls = { kind?: string; needs_reply?: boolean; ask?: string | null; property?: { label: string; address?: string } | null; due_on?: string | null; priority?: string; counterparty?: string; category?: string; owed_by?: "ryan" | "them" | null; document_links?: string[]; is_human?: boolean; solicitation?: boolean }
type Loop = Record<string, any>

const HOMESENTRY = { email: "inspections@tapinspect.com", name: "HomeSentry Inspections" }
const AMANDA = { email: "amanda@bakshirealestate.com", name: "Amanda Bakshi" }
const JUAN = { email: "juan@letterprinting.net", name: "Juan Muniz" }
const FRESHBOOKS = { email: "mail@fb02.freshbooks.com", name: "Kowi Chandra (via FreshBooks)" }
const HALLECK_SHARE = "d50c5c43-83cb-4f15-aac0-8e0cdf25de18"
const QUITO_SHARE = "78a00aee-dcfc-4ed0-9d2d-8d78319142e4"

// ---- 5764 Halleck Dr (HomeSentry) — gmail ids from the brief
const halleckSign: Msg = { id: "1a1317578e6f00b5", threadId: "t-halleck-sign", from: HOMESENTRY, subject: "Please sign agreement", internalDate: "2026-10-12T17:05:00.000Z", text: `HomeSentry Inspections has sent you an agreement to sign for the inspection of 5764 Halleck Dr, San Jose, CA 95123.\nhttps://app.tapinspect.com/shares/${HALLECK_SHARE}\nIf you have not signed pre-inspection or made payment results will not be viewable.` }
const halleckSignCls: Cls = { kind: "human", needs_reply: true, ask: "Sign the pre-inspection agreement and pay the invoice for 5764 Halleck Dr", property: { label: "5764 Halleck Dr" }, counterparty: "HomeSentry Inspections", category: "vendor", priority: "normal" }
const halleckResults: Msg = { id: "1a14056ab449524c", threadId: "t-halleck-results", from: HOMESENTRY, subject: "Inspection results for 5764 Halleck Dr, San Jose, CA 95123", internalDate: "2026-10-15T16:13:00.000Z", text: `Your inspection results are ready.\nView Report: https://app.tapinspect.com/shares/${HALLECK_SHARE}` }
const halleckResultsCls: Cls = { kind: "automated", needs_reply: true, ask: "Pay the HomeSentry invoice to unlock the 5764 Halleck Dr inspection report", property: { label: "5764 Halleck Dr" }, counterparty: "HomeSentry Inspections", category: "vendor", document_links: [`https://app.tapinspect.com/shares/${HALLECK_SHARE}`] }
const halleckPaid: Msg = { id: "1a14674c084ab8c7", threadId: "t-halleck-paid", from: HOMESENTRY, subject: "Thank you for your payment", internalDate: "2026-10-16T20:45:00.000Z", text: "We have received your payment for the inspection of 5764 Halleck Dr, San Jose, CA 95123.\n\nThank you,\nHomeSentry Inspections" }
const halleckUpdated: Msg = { id: "1a146754b76d30a8", threadId: "t-halleck-updated", from: HOMESENTRY, subject: "Inspection results for 5764 Halleck Dr, San Jose, CA 95123 have been updated", internalDate: "2026-10-16T20:52:00.000Z", text: `The inspection results have been updated.\nView Report: https://app.tapinspect.com/shares/${HALLECK_SHARE}` }
// Ryan's "Paid" on the results thread — sent 10-16 20:40, BEFORE the replay minted the loop row at 23:50.
const halleckPaidReply = { id: "1a146719cfe7f101", threadId: "t-halleck-results", internalDate: "2026-10-16T20:40:00.000Z", to: "HomeSentry Inspections <inspections@tapinspect.com>", cc: "" }
// The one real ask: the DocuSign disclosures envelope.
const halleckDisclosures: Msg = { id: "1a13d1s2c3l4o5s6", threadId: "t-halleck-disc", from: { email: "dse_NA4@docusign.net", name: "Lisa Nunes via DocuSign" }, subject: "Please Sign: 5764 Halleck Dr San Jose - Disclosures", internalDate: "2026-10-14T18:00:00.000Z", text: "Lisa Nunes sent you a document to review and sign.\nhttps://na4.docusign.net/Signing/EmailStart.aspx?a=1&etti=2&r=3" }
// Amanda's termite forward — the ball is in HER court (South Bay Termite has to release the report).
const amandaTermite: Msg = { id: "1a1455ab4b1bc7ef", threadId: "t-amanda-termite", from: AMANDA, subject: "Fwd: Termite Inspection Report | 5764 Halleck Dr", internalDate: "2026-10-16T15:30:00.000Z", text: "Ryan — they need the $300 before they release it. I'll chase them.\n\n---------- Forwarded message ---------\nFrom: South Bay Termite <southbaytermite@yahoo.com>\nDate: Thu, Oct 16, 2026\nSubject: Termite Inspection Report | 5764 Halleck Dr\nThe report is ready once the $300 inspection fee is paid." }
const amandaTermiteCls: Cls = { kind: "human", needs_reply: true, ask: "Pay $300 to South Bay Termite so they can release the 5764 Halleck Dr termite report", property: { label: "5764 Halleck Dr" }, counterparty: "Amanda Bakshi", category: "agent", owed_by: "them" }

// ---- 2116 Quito Rd — three emails within 10 seconds, one ask
const quitoBooking: Msg = { id: "1a145be09c1aae90", threadId: "t-quito-booking", from: HOMESENTRY, subject: "Inspection of 2116 Quito Rd, San Jose, CA 95130", internalDate: "2026-10-16T14:20:00.000Z", text: "Your inspection is scheduled for Monday, October 20, 2026 at 9:00 AM.\nPlease sign the agreement and pay the invoice prior to the inspection.\nhttps://app.tapinspect.com/shares/" + QUITO_SHARE }
const quitoBookingCls: Cls = { kind: "human", needs_reply: true, ask: "Sign the inspection agreement and pay the invoice before the 10/20 inspection of 2116 Quito Rd", property: { label: "2116 Quito Rd" }, due_on: "2026-10-20", counterparty: "HomeSentry Inspections", category: "vendor", priority: "normal" }
const quitoSign: Msg = { id: "1a145be12eff4a08", threadId: "t-quito-sign", from: HOMESENTRY, subject: "Please sign agreement", internalDate: "2026-10-16T14:20:05.000Z", text: `HomeSentry Inspections has sent you an agreement to sign for the inspection of 2116 Quito Rd, San Jose, CA 95130.\nhttps://app.tapinspect.com/shares/${QUITO_SHARE}` }
const quitoSignCls: Cls = { kind: "human", needs_reply: true, ask: "Sign the pre-inspection agreement for 2116 Quito Rd", property: { label: "2116 Quito Rd" }, counterparty: "HomeSentry Inspections", category: "vendor", priority: "high" }
const amandaQuitoFwd: Msg = { id: "1a145bee1ca7d82e", threadId: "t-quito-fwd", from: AMANDA, subject: "Fwd: Inspection of 2116 Quito Rd, San Jose, CA 95130", internalDate: "2026-10-16T14:20:10.000Z", text: "FYI — booked for Monday.\n\n---------- Forwarded message ---------\nFrom: HomeSentry Inspections <inspections@tapinspect.com>\nDate: Thu, Oct 16, 2026 at 7:20 AM\nSubject: Inspection of 2116 Quito Rd, San Jose, CA 95130\nTo: <amanda@bakshirealestate.com>\n\nYour inspection is scheduled for Monday, October 20, 2026 at 9:00 AM.\nPlease sign the agreement and pay the invoice prior to the inspection." }
const amandaQuitoFwdCls: Cls = { kind: "human", needs_reply: true, ask: "Sign HomeSentry's agreement and pay for the 2116 Quito Rd inspection", property: { label: "2116 Quito Rd" }, counterparty: "Amanda Bakshi", category: "agent", priority: "normal" }
const quitoPaid: Msg = { ...halleckPaid, id: "quito-paid", threadId: "t-quito-paid", internalDate: "2026-10-18T17:00:00.000Z", text: "We have received your payment for the inspection of 2116 Quito Rd, San Jose, CA 95130." }

// ---- Juan Muniz (ITI Direct Mail) — two threads, replies only on the newer one
const juanSoftQuote: Msg = { id: "1a0f98d70a4c7d1b", threadId: "1a0f98d70a4c7d1b", from: JUAN, subject: "RE: Soft quote absentee list", internalDate: "2026-10-13T19:24:00.000Z", text: "Ryan, here is the soft quote for the absentee list." }
const juanNoo: Msg = { id: "1a14686438fae4d0", threadId: "1a136cb10adfd480", from: JUAN, subject: "RE: NOO Absentee Q4", internalDate: "2026-10-16T21:02:00.000Z", text: "Attached is the revised invoice 243496." }
const juanNooCls: Cls = { kind: "human", needs_reply: true, ask: "Approve the revised ITI invoice 243496 for the NOO Absentee Q4 drop", property: null, counterparty: "Juan Muniz (ITI Direct Mail)", category: "vendor" }
const sentToJuan = [
  { id: "s1", threadId: "1a136cb10adfd480", internalDate: "2026-10-14T16:00:00.000Z", to: "Juan Muniz <juan@letterprinting.net>", cc: "alan@letterprinting.net" },
  { id: "s2", threadId: "1a136cb10adfd480", internalDate: "2026-10-15T17:30:00.000Z", to: "juan@letterprinting.net", cc: "" },
  { id: "1a146c635191327f", threadId: "1a136cb10adfd480", internalDate: "2026-10-16T22:12:00.000Z", to: "\"Muniz, Juan\" <Juan@LetterPrinting.net>", cc: "Ryan LaRocca <ryan@lrghomes.com>" },
]

// ---- FreshBooks (StyleMe staging invoice 080223UP)
const fbComment: Msg = { id: "1a135f9e00ed5f51", threadId: "t-fb-1", from: FRESHBOOKS, subject: "Kowi Chandra commented on invoice 080223UP ($2,985.00)", internalDate: "2026-10-13T15:55:00.000Z", text: "Kowi Chandra: Hi Ryan, please pay the staging invoice when you get a chance.\nView invoice 080223UP" }
const fbCommentCls: Cls = { kind: "human", needs_reply: true, ask: "Pay StyleMe staging invoice 080223UP ($2,985.00)", property: { label: "5764 Halleck Dr" }, counterparty: "Kowi Chandra (StyleMe)", category: "vendor", priority: "normal" }
const fbPaid: Msg = { id: "1a13712751de3137", threadId: "t-fb-2", from: FRESHBOOKS, subject: "Kowi Chandra commented on invoice 080223UP ($0.00)", internalDate: "2026-10-13T21:58:00.000Z", text: "Kowi Chandra: Thank you for your payment!\nView invoice 080223UP" }

// ---- an in-memory upsertLoop: the same three checks index.mjs runs (thread → envelope → loop_key), then mergeLoop or insert
function simulateUpsert(loops: Loop[], msg: Msg, cls: Cls, { kind = "human", createdAt = msg.internalDate }: { kind?: string; createdAt?: string } = {}) {
  if (!loopEligible(kind, msg, cls)) return null
  const isSig = kind === "docusign_request"
  const ask = isSig ? `Sign: ${msg.subject.replace(/^(reminder:\s*)?(please sign:?\s*)?/i, "")}` : cls.ask
  const priority = isSig ? "high" : cls.priority || "normal"
  const key = loopKey(msg, cls)
  const incoming = { gmail_id: msg.id, message_at: msg.internalDate, due_on: cls.due_on || null, priority, ask, loop_key: key, owed_by: owedBy(cls) }
  let loop = loops.find((l) => l.thread_id === msg.threadId && ["open", "snoozed"].includes(l.status)) || null
  let how = loop ? "thread" : null
  if (isSig) {
    const env = loops.find((l) => l.category === "signature" && ["open", "snoozed"].includes(l.status) && envelopeMatches(l.subject, msg.subject))
    if (env) (loop = env), (how = "envelope")
  }
  if (!loop) {
    loop = loopKeyMatch(loops, key, new Date(createdAt).getTime())
    if (loop) how = "key"
  }
  if (loop) {
    Object.assign(loop, mergeLoop(loop, incoming, { sameThread: how === "thread" }))
    return loop
  }
  const row: Loop = {
    id: `loop-${msg.id}`, thread_id: msg.threadId, gmail_id: msg.id, subject: msg.subject, counterparty: cls.counterparty || msg.from.name || msg.from.email, counterparty_email: msg.from.email,
    category: isSig ? "signature" : cls.category || "other", ask, due_on: cls.due_on || null, priority, status: "open", created_at: createdAt, message_at: msg.internalDate, loop_key: key, owed_by: owedBy(cls),
  }
  loops.push(row)
  return row
}
function applyCompletion(loops: Loop[], event: ReturnType<typeof completionEvent>, extraFor: (l: Loop) => { text?: string; propertyLabel?: string | null; shareIds?: string[] } = () => ({})) {
  const closed: string[] = []
  for (const l of loops) {
    if (!["open", "snoozed", "acknowledged"].includes(l.status)) continue
    if (completionCloses(event, l, extraFor(l))) {
      l.status = "resolved_by_event"
      closed.push(l.id)
    }
  }
  return closed
}
const openIds = (loops: Loop[]) => loops.filter((l) => l.status === "open").map((l) => l.id)

describe("Part A — resolve against the email's date, not the loop row's", () => {
  it("Halleck results: reply 20:40 vs loop row minted 23:50 → resolves; a reply before the email does not", () => {
    const loop = { thread_id: "t-halleck-results", message_at: halleckResults.internalDate, created_at: "2026-10-16T23:50:00.000Z" }
    expect(replyResolves(loop, halleckPaidReply.internalDate)).toBe(true)
    expect(replyResolves({ ...loop, message_at: null }, halleckPaidReply.internalDate)).toBe(false) // the old rule, for contrast
    expect(replyResolves(loop, "2026-10-15T12:00:00.000Z")).toBe(false) // before the email arrived
    expect(replyResolves(loop, halleckResults.internalDate)).toBe(false) // same instant is not after
  })
  it("Juan NOO Absentee Q4: received 21:02, replied 22:12, row 23:50 → resolves", () => {
    const loop = { thread_id: juanNoo.threadId, message_at: juanNoo.internalDate, created_at: "2026-10-16T23:50:00.000Z" }
    expect(replyResolves(loop, "2026-10-16T22:12:00.000Z")).toBe(true)
    expect(replyResolves(loop, "2026-10-16T20:00:00.000Z")).toBe(false)
  })
  it("falls back to created_at for rows without message_at; tolerates Postgres offsets and garbage", () => {
    expect(replyResolves({ created_at: "2026-10-16 23:50:00+00" }, "2026-10-17T01:00:00.000Z")).toBe(true)
    expect(replyResolves({ created_at: "2026-10-16T23:50:00+00:00" }, "2026-10-16T20:40:00.000Z")).toBe(false)
    expect(replyResolves({}, "2026-10-17T01:00:00.000Z")).toBe(false)
    expect(replyResolves({ created_at: "2026-10-16T23:50:00.000Z" }, null)).toBe(false)
    expect(replyResolves({ created_at: "nonsense" }, "2026-10-17T01:00:00.000Z")).toBe(false)
  })
  it("one shared sent-mail window for resolveLoops and the digest", () => {
    expect(SENT_LOOKBACK_DAYS).toBe(8)
  })
})

describe("Part B — a reply to the same person counts, on any thread", () => {
  it("parseAddressList: display names, angle brackets, quotes, several recipients, case", () => {
    expect(parseAddressList('"Muniz, Juan" <Juan@LetterPrinting.net>, alan@letterprinting.net')).toEqual(["juan@letterprinting.net", "alan@letterprinting.net"])
    expect(parseAddressList("Amanda Bakshi <amanda@bakshirealestate.com>; HomeSentry <inspections@tapinspect.com>")).toEqual(["amanda@bakshirealestate.com", "inspections@tapinspect.com"])
    expect(parseAddressList("juan@letterprinting.net, JUAN@letterprinting.net")).toEqual(["juan@letterprinting.net"])
    expect(parseAddressList("ryan.o'neil@example.com.")).toEqual(["ryan.o'neil@example.com"])
    expect(parseAddressList("")).toEqual([])
    expect(parseAddressList(null)).toEqual([])
    expect(parseAddressList("Undisclosed recipients:;")).toEqual([])
  })
  it("foldSent: latest send per thread and per recipient; Ryan's own address is never a recipient", () => {
    const sent = foldSent([...sentToJuan, halleckPaidReply], { self: "ryan@lrghomes.com" })
    expect(sent.byThread.get("1a136cb10adfd480")).toBe("2026-10-16T22:12:00.000Z")
    expect(sent.byThread.get("t-halleck-results")).toBe(halleckPaidReply.internalDate)
    expect(sent.byRecipient.get("juan@letterprinting.net")).toBe("2026-10-16T22:12:00.000Z")
    expect(sent.byRecipient.get("alan@letterprinting.net")).toBe("2026-10-14T16:00:00.000Z")
    expect(sent.byRecipient.get("inspections@tapinspect.com")).toBe(halleckPaidReply.internalDate)
    expect(sent.byRecipient.has("ryan@lrghomes.com")).toBe(false)
    expect(foldSent([]).byThread.size).toBe(0)
  })
  it("answeredBy: Juan's Soft quote thread is answered by the sends to juan@ on the NOO thread", () => {
    const sent = foldSent(sentToJuan, { self: "ryan@lrghomes.com" })
    const softQuoteRow = { thread_id: juanSoftQuote.threadId, sender: JUAN.email, internal_date: juanSoftQuote.internalDate }
    expect(answeredBy(softQuoteRow, sent)).toBe("recipient")
    const nooLoop = { thread_id: juanNoo.threadId, counterparty_email: JUAN.email, message_at: juanNoo.internalDate, created_at: "2026-10-16T23:50:00.000Z" }
    expect(answeredBy(nooLoop, sent)).toBe("thread")
    // A send to Juan BEFORE his email does not answer it.
    expect(answeredBy({ thread_id: "t-new", counterparty_email: JUAN.email, message_at: "2026-10-17T09:00:00.000Z" }, sent)).toBeNull()
    // Someone Ryan never wrote to.
    expect(answeredBy({ thread_id: "t-x", counterparty_email: "nobody@example.com", message_at: "2026-10-13T00:00:00.000Z" }, sent)).toBeNull()
    // The old thread-only Map still works.
    expect(answeredBy(nooLoop, sent.byThread)).toBe("thread")
    expect(answeredBy(softQuoteRow, sent.byThread)).toBeNull()
    expect(answeredBy(softQuoteRow, null)).toBeNull()
  })
  it("a forward's counterparty is the forwarder: writing Amanda answers Amanda's forward", () => {
    const sent = foldSent([{ threadId: "t-other", internalDate: "2026-10-16T18:00:00.000Z", to: AMANDA.email }])
    const fwdLoop = { thread_id: amandaQuitoFwd.threadId, counterparty_email: AMANDA.email, message_at: amandaQuitoFwd.internalDate }
    expect(answeredBy(fwdLoop, sent)).toBe("recipient")
  })
})

describe("Part E — relays are never loose ends", () => {
  it("RELAY_SENDER_RE covers the old list plus the billing / e-sign relays", () => {
    for (const s of ["noreply@x.com", "no-reply@docusign.net", "dse_NA4@docusign.net", "notification@authentisign.com", "mail@fb02.freshbooks.com", "inspections@tapinspect.com", "docs@email.pandadoc.net", "quickbooks@notification.intuit.com", "payments@bill.com", "invoicing@vendor.com", "statements@chase.com", "statement@bank.com"]) expect(RELAY_SENDER_RE.test(s), s).toBe(true)
    for (const s of ["juan@letterprinting.net", "amanda@bakshirealestate.com", "southbaytermite@yahoo.com", "lisa.nunes@ctt.com"]) expect(RELAY_SENDER_RE.test(s), s).toBe(false)
  })
  it("isLooseEnd: the FreshBooks comment and the HomeSentry agreement are never Unanswered; a real human thread is", () => {
    const NOW = Date.parse("2026-10-17T14:30:00.000Z")
    const sent = foldSent(sentToJuan, { self: "ryan@lrghomes.com" })
    const row = (m: Msg, cls: Cls = { is_human: true, needs_reply: true }) => ({ gmail_id: m.id, thread_id: m.threadId, sender: m.from.email, sender_name: m.from.name, subject: m.subject, internal_date: m.internalDate, classification: cls })
    expect(isLooseEnd(row(fbComment, fbCommentCls), { sent, now: NOW })).toBe(false)
    expect(isLooseEnd(row(halleckSign, halleckSignCls), { sent, now: NOW })).toBe(false)
    // Juan's Soft quote: a human thread with no reply on it — answered via the other thread (Part B).
    expect(isLooseEnd(row(juanSoftQuote), { sent, now: NOW })).toBe(false)
    expect(isLooseEnd(row(juanSoftQuote), { sent: foldSent([]), now: NOW })).toBe(true)
    // The usual exclusions still hold.
    expect(isLooseEnd(row(juanSoftQuote), { sent: null, now: NOW, openThreads: new Set([juanSoftQuote.threadId]) })).toBe(false)
    expect(isLooseEnd(row(juanSoftQuote), { sent: null, now: NOW, dismissed: { [juanSoftQuote.threadId]: "2026-10-17T00:00:00.000Z" } })).toBe(false)
    expect(isLooseEnd(row(juanSoftQuote, { is_human: true, needs_reply: false }), { now: NOW })).toBe(false)
    expect(isLooseEnd(row(juanSoftQuote, { is_human: true, needs_reply: true, solicitation: true }), { now: NOW })).toBe(false)
    expect(isLooseEnd(row(juanSoftQuote), { now: Date.parse("2026-10-14T12:00:00.000Z") })).toBe(false) // under 2 days old
    expect(isLooseEnd({ ...row(juanSoftQuote), thread_id: null }, { now: NOW })).toBe(false)
  })
})

describe("Part C — completion events", () => {
  it("HomeSentry: payment receipt → paid with the property from the body; results updated → updated with the share uuid", () => {
    expect(completionEvent(halleckPaid)).toEqual({ kind: "paid", vendor: "tapinspect", property: "5764 Halleck Dr", invoice: null, shareId: null })
    expect(completionEvent(halleckUpdated)).toEqual({ kind: "updated", vendor: "tapinspect", property: "5764 Halleck Dr", invoice: null, shareId: HALLECK_SHARE })
    expect(completionEvent({ ...halleckUpdated, subject: "Inspection results have been updated for 2116 Quito Rd, San Jose, CA 95130" })?.property).toBe("2116 Quito Rd")
    expect(completionEvent({ ...halleckPaid, text: "Thanks for paying." }, { property: { label: "5764 Halleck Dr" } })?.property).toBe("5764 Halleck Dr")
    // Not completions: the agreement ask, the first results, the booking.
    expect(completionEvent(halleckSign, halleckSignCls)).toBeNull()
    expect(completionEvent(halleckResults, halleckResultsCls)).toBeNull()
    expect(completionEvent(quitoBooking, quitoBookingCls)).toBeNull()
    // A forward of the receipt by a person is not the vendor's event.
    expect(completionEvent({ ...halleckPaid, from: AMANDA, subject: "Fwd: Thank you for your payment" })).toBeNull()
    expect(reportFiledEvent("5764 Halleck Dr")).toEqual({ kind: "report_filed", vendor: "tapinspect", property: "5764 Halleck Dr", invoice: null, shareId: null })
    expect(reportFiledEvent(null)).toBeNull()
  })
  it("FreshBooks: the $0.00 comment (or a 'thank you for your payment' body) → paid with the invoice number; a balance is not", () => {
    expect(completionEvent(fbPaid)).toEqual({ kind: "paid", vendor: "freshbooks", property: null, invoice: "080223UP", shareId: null })
    expect(completionEvent(fbComment, fbCommentCls)).toBeNull()
    expect(completionEvent({ ...fbPaid, subject: "Kowi Chandra commented on invoice 080223UP ($2,985.00)", text: "Thank you for your payment, Ryan!" })).toEqual({ kind: "paid", vendor: "freshbooks", property: null, invoice: "080223UP", shareId: null })
    expect(completionEvent({ ...fbPaid, subject: "Payment received", text: "Thank you for your payment." })?.invoice).toBeNull()
  })
  it("completion events are never loop-eligible, whatever the classifier said", () => {
    expect(loopEligible("human", halleckPaid, { needs_reply: true, ask: "Pay the invoice" })).toBe(false)
    expect(loopEligible("automated", halleckUpdated, null)).toBe(false)
    expect(loopEligible("human", fbPaid, { needs_reply: true })).toBe(false)
    expect(loopEligible("human", fbComment, fbCommentCls)).toBe(true)
    expect(loopEligible("human", halleckSign, halleckSignCls)).toBe(true)
    expect(loopEligible("docusign_completed")).toBe(false) // the 2026-10-12 rule, unchanged
    expect(loopEligible("docusign_request")).toBe(true)
  })
  it("the Halleck sequence: agreement loop + results loop → payment receipt, updated email and the filed report close everything", () => {
    const loops: Loop[] = []
    simulateUpsert(loops, halleckSign, halleckSignCls)
    simulateUpsert(loops, halleckResults, halleckResultsCls, { kind: "automated", createdAt: "2026-10-16T23:50:00.000Z" })
    simulateUpsert(loops, halleckDisclosures, { needs_reply: true }, { kind: "docusign_request" })
    simulateUpsert(loops, amandaTermite, amandaTermiteCls)
    expect(openIds(loops)).toHaveLength(4)
    // The payment receipt alone (no share uuid, property from the body) closes both HomeSentry loops …
    const paid = completionEvent(halleckPaid)
    expect(completionCloses(paid, loops[0])).toBe(true) // "Please sign agreement": counterparty tapinspect + classifier property (via the ask's address)
    expect(completionCloses(paid, loops[1])).toBe(true) // results loop: address in the subject
    // … never the DocuSign disclosures or Amanda's South Bay Termite ask on the same house.
    expect(completionCloses(paid, loops[2])).toBe(false)
    expect(completionCloses(paid, loops[3])).toBe(false)
    expect(completionMatch(paid, { senderEmail: AMANDA.email, vendorFamily: "southbaytermite@yahoo.com", subject: amandaTermite.subject, ask: amandaTermiteCls.ask })).toBeNull()
    expect(applyCompletion(loops, paid).sort()).toEqual(["loop-1a1317578e6f00b5", "loop-1a14056ab449524c"])
    expect(openIds(loops)).toEqual(["loop-1a13d1s2c3l4o5s6", "loop-1a1455ab4b1bc7ef"])
    // The updated email and the filed report find nothing left to close, and still leave the other two alone.
    expect(applyCompletion(loops, completionEvent(halleckUpdated))).toEqual([])
    expect(applyCompletion(loops, reportFiledEvent("5764 Halleck Dr"))).toEqual([])
    expect(openIds(loops)).toEqual(["loop-1a13d1s2c3l4o5s6", "loop-1a1455ab4b1bc7ef"])
  })
  it("a 'Please sign agreement' loop with no property anywhere still closes by the share uuid in its body", () => {
    const bare: Loop = { id: "l", thread_id: "t", gmail_id: halleckSign.id, subject: "Please sign agreement", ask: "Sign the agreement", counterparty_email: HOMESENTRY.email, status: "open", created_at: halleckSign.internalDate, loop_key: "tapinspect.com||signature" }
    const updated = completionEvent(halleckUpdated)
    expect(completionCloses(updated, bare)).toBe(false) // nothing to compare without context
    expect(completionCloses(updated, bare, { text: halleckSign.text })).toBe(true) // body carries the uuid
    expect(completionCloses(updated, bare, { shareIds: [HALLECK_SHARE.toUpperCase()] })).toBe(true) // inbox_fetches.url on its thread
    expect(completionCloses(updated, bare, { shareIds: [QUITO_SHARE] })).toBe(false)
    expect(completionCloses(updated, bare, { propertyLabel: "5764 Halleck Dr" })).toBe(true) // or the classifier's property
    expect(completionCloses(updated, bare, { propertyLabel: "2116 Quito Rd" })).toBe(false)
    expect(completionCloses(null, bare, { text: halleckSign.text })).toBe(false)
    expect(completionCloses(updated, null)).toBe(false)
  })
  it("Quito: nothing closes until a Quito receipt arrives; the Halleck receipt is not it", () => {
    const loops: Loop[] = []
    simulateUpsert(loops, quitoBooking, quitoBookingCls)
    simulateUpsert(loops, quitoSign, quitoSignCls)
    simulateUpsert(loops, amandaQuitoFwd, amandaQuitoFwdCls)
    expect(loops).toHaveLength(1) // Part D
    expect(applyCompletion(loops, completionEvent(halleckPaid))).toEqual([])
    expect(applyCompletion(loops, completionEvent(halleckUpdated))).toEqual([])
    expect(applyCompletion(loops, reportFiledEvent("5764 Halleck Dr"))).toEqual([])
    expect(openIds(loops)).toEqual(["loop-1a145be09c1aae90"])
    expect(completionEvent(quitoPaid)?.property).toBe("2116 Quito Rd")
    expect(applyCompletion(loops, completionEvent(quitoPaid))).toEqual(["loop-1a145be09c1aae90"])
    // Amanda's forward on its own (an inspection ask on the property, forward origin tapinspect) closes too.
    const fwdOnly: Loop[] = []
    simulateUpsert(fwdOnly, amandaQuitoFwd, amandaQuitoFwdCls)
    expect(fwdOnly[0].counterparty_email).toBe(AMANDA.email)
    expect(completionCloses(completionEvent(quitoPaid), fwdOnly[0])).toBe(true)
    // The same forward WITHOUT the quoted HomeSentry header still closes: "inspection" + the address, and no other inspector named.
    const bareFwd = { ...fwdOnly[0], loop_key: `${AMANDA.email.split("@")[1]}|2116quito|signature`, ask: "Sign the agreement and pay for the Quito inspection" }
    expect(completionMatch(completionEvent(quitoPaid), { senderEmail: AMANDA.email, vendorFamily: "bakshirealestate.com", subject: fwdOnly[0].subject, ask: bareFwd.ask })).toBe("inspection+property")
  })
  it("FreshBooks: 080223UP $2,985 → $0.00 closes it; a different invoice number does not", () => {
    const loops: Loop[] = []
    simulateUpsert(loops, fbComment, fbCommentCls)
    expect(loops).toHaveLength(1)
    expect(completionCloses(completionEvent({ ...fbPaid, subject: "Kowi Chandra commented on invoice 080224UP ($0.00)", text: "Thank you for your payment" }), loops[0])).toBe(false)
    expect(completionMatch(completionEvent(fbPaid), { senderEmail: FRESHBOOKS.email, subject: fbComment.subject, ask: fbCommentCls.ask })).toBe("invoice")
    expect(applyCompletion(loops, completionEvent(fbPaid))).toEqual(["loop-1a135f9e00ed5f51"])
    // A FreshBooks receipt never closes a property loop (no property on the event).
    const halleck: Loop[] = []
    simulateUpsert(halleck, halleckSign, halleckSignCls)
    expect(applyCompletion(halleck, completionEvent(fbPaid))).toEqual([])
  })
  it("completionDismisses: the same vendor's Unanswered threads for the property / share / invoice; never another sender's thread by address alone", () => {
    const row = (m: Msg, cls: Cls | null = null) => ({ thread_id: m.threadId, sender: m.from.email, subject: m.subject, classification: cls })
    const paid = completionEvent(halleckPaid)
    expect(completionDismisses(paid, row(halleckSign, halleckSignCls))).toBe(true) // tapinspect + classifier property
    expect(completionDismisses(paid, row(halleckSign), { shareIds: [HALLECK_SHARE] })).toBe(false) // no uuid on the receipt, no property on the row
    expect(completionDismisses(completionEvent(halleckUpdated), row(halleckSign), { shareIds: [HALLECK_SHARE] })).toBe(true) // the updated email carries the uuid
    expect(completionDismisses(paid, row(halleckResults))).toBe(true) // address in the subject
    expect(completionDismisses(paid, row(quitoSign, quitoSignCls))).toBe(false)
    expect(completionDismisses(paid, row(amandaTermite, amandaTermiteCls))).toBe(false)
    expect(completionDismisses(paid, row(amandaQuitoFwd, amandaQuitoFwdCls))).toBe(false)
    // Amanda's forward of the Halleck results is a vendor thread by forward origin.
    expect(completionDismisses(paid, row({ ...amandaQuitoFwd, subject: "Fwd: Inspection results for 5764 Halleck Dr, San Jose, CA 95123" }, { property: { label: "5764 Halleck Dr" } }), { vendorFamily: "tapinspect.com" })).toBe(true)
    expect(completionDismisses(completionEvent(fbPaid), row(fbComment, fbCommentCls))).toBe(true)
    expect(completionDismisses(completionEvent(fbPaid), row(juanNoo, juanNooCls))).toBe(false)
    expect(completionDismisses(paid, null)).toBe(false)
  })
})

describe("Part D — one ask, one loop", () => {
  it("loopKey: vendor family (forward origin for Fwd:), property, ask kind", () => {
    expect(loopKey(quitoBooking, quitoBookingCls)).toBe("tapinspect.com|2116quito|signature")
    expect(loopKey(quitoSign, quitoSignCls)).toBe("tapinspect.com|2116quito|signature")
    expect(loopKey(amandaQuitoFwd, amandaQuitoFwdCls)).toBe("tapinspect.com|2116quito|signature")
    expect(loopKey(halleckSign, halleckSignCls)).toBe("tapinspect.com|5764halleck|signature")
    expect(loopKey(amandaTermite, amandaTermiteCls)).toBe("southbaytermite@yahoo.com|5764halleck|payment")
    expect(loopKey(fbComment, fbCommentCls)).toBe("fb02.freshbooks.com|5764halleck|payment")
    expect(loopKey(juanNoo, juanNooCls)).toBe("letterprinting.net||payment")
    expect(parseLoopKey("tapinspect.com|2116quito|signature")).toEqual({ family: "tapinspect.com", propertyKey: "2116quito", askKind: "signature" })
    expect(parseLoopKey(null)).toBeNull()
  })
  it("forwardOrigin / vendorFamilyOf / askKind", () => {
    expect(forwardOrigin(amandaQuitoFwd)).toBe("inspections@tapinspect.com")
    expect(forwardOrigin(amandaTermite)).toBe("southbaytermite@yahoo.com")
    expect(forwardOrigin({ ...amandaQuitoFwd, text: "no header here" })).toBeNull()
    expect(forwardOrigin(quitoBooking)).toBeNull() // not a forward
    expect(forwardOrigin({ ...amandaQuitoFwd, subject: "FW: booking", text: "> *From:* HomeSentry <inspections@tapinspect.com>" })).toBe("inspections@tapinspect.com")
    expect(vendorFamilyOf("Inspections@TapInspect.com")).toBe("tapinspect.com")
    expect(vendorFamilyOf("southbaytermite@yahoo.com")).toBe("southbaytermite@yahoo.com")
    expect(vendorFamilyOf("")).toBe("")
    expect(askKind("Sign the pre-inspection agreement and pay the invoice")).toBe("signature")
    expect(askKind("Review the agreement")).toBe("agreement")
    expect(askKind("Pay StyleMe staging invoice 080223UP")).toBe("payment")
    expect(askKind("Confirm the inspection date")).toBe("other")
    expect(askKind(null)).toBe("other")
  })
  it("the three Quito emails in arrival order → one loop, counterparty HomeSentry, due 2026-10-20; Amanda's forward refreshes, never a second row", () => {
    const loops: Loop[] = []
    const a = simulateUpsert(loops, quitoBooking, quitoBookingCls)
    const b = simulateUpsert(loops, quitoSign, quitoSignCls)
    const c = simulateUpsert(loops, amandaQuitoFwd, amandaQuitoFwdCls)
    expect(loops).toHaveLength(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(loops[0]).toMatchObject({ counterparty: "HomeSentry Inspections", counterparty_email: HOMESENTRY.email, due_on: "2026-10-20", priority: "high", gmail_id: amandaQuitoFwd.id, message_at: amandaQuitoFwd.internalDate, created_at: quitoBooking.internalDate, status: "open", owed_by: "ryan" })
    expect(loops[0].ask).toBe(quitoBookingCls.ask) // a sibling email never rewrites the vendor's own wording
  })
  it("a genuinely different property on the same day (Halleck vs Quito) → two loops; the window and the empty-property guard", () => {
    const loops: Loop[] = []
    simulateUpsert(loops, quitoSign, quitoSignCls)
    simulateUpsert(loops, halleckSign, { ...halleckSignCls }, { createdAt: quitoSign.internalDate })
    expect(loops).toHaveLength(2)
    const key = loopKey(quitoSign, quitoSignCls)
    expect(loopKeyMatch(loops, key, Date.parse(quitoSign.internalDate) + LOOP_KEY_WINDOW_MS)).toBe(loops[0])
    expect(loopKeyMatch(loops, key, Date.parse(quitoSign.internalDate) + LOOP_KEY_WINDOW_MS + 1)).toBeNull()
    expect(loopKeyMatch(loops.map((l) => ({ ...l, status: "done" })), key, Date.parse(quitoSign.internalDate))).toBeNull()
    expect(loopKeyMatch([{ loop_key: "letterprinting.net||payment", status: "open", created_at: juanNoo.internalDate }], "letterprinting.net||payment", Date.parse(juanNoo.internalDate))).toBeNull()
    expect(LOOP_KEY_WINDOW_MS).toBe(48 * 3600_000)
  })
  it("mergeLoop: newest gmail_id / message_at, due_on kept unless new, priority high wins, reopened; ask follows only the same thread", () => {
    const existing = { gmail_id: "old", message_at: "2026-10-16T14:20:00.000Z", due_on: "2026-10-20", priority: "normal", ask: "A", status: "snoozed", snooze_until: "2026-10-18T00:00:00.000Z", loop_key: null, owed_by: "ryan" }
    const incoming = { gmail_id: "new", message_at: "2026-10-16T14:20:05.000Z", due_on: null, priority: "high", ask: "B", loop_key: "k", owed_by: "them" }
    expect(mergeLoop(existing, incoming)).toEqual({ gmail_id: "new", message_at: "2026-10-16T14:20:05.000Z", due_on: "2026-10-20", priority: "high", status: "open", snooze_until: null, loop_key: "k", owed_by: "them" })
    expect(mergeLoop(existing, incoming, { sameThread: true }).ask).toBe("B")
    expect(mergeLoop({ ...existing, priority: "high" }, { ...incoming, priority: "low" }).priority).toBe("high")
    expect(mergeLoop({ ...existing, due_on: null }, { ...incoming, due_on: "2026-10-21" }).due_on).toBe("2026-10-21")
    expect(mergeLoop({ ...existing, loop_key: "old" }, incoming).loop_key).toBeUndefined() // an existing key is never rewritten
  })
})

describe("Part F — Waiting on them", () => {
  it("owedBy defaults to ryan; splitLoops buckets; theirs/mine replies flip it", () => {
    expect(owedBy({ owed_by: "them" })).toBe("them")
    expect(owedBy({ owed_by: "ryan" })).toBe("ryan")
    expect(owedBy({ owed_by: null })).toBe("ryan")
    expect(owedBy(null)).toBe("ryan")
    const loops = [{ id: "a", owed_by: null }, { id: "b", owed_by: "them" }, { id: "c", owed_by: "ryan" }]
    expect(splitLoops(loops)).toEqual({ mine: [loops[0], loops[2]], theirs: [loops[1]] })
    expect(splitLoops(null)).toEqual({ mine: [], theirs: [] })
    for (const t of ["theirs", "Theirs — Amanda has to chase them", "them", "their ball", "waiting on them"]) expect(owedByFromReply(t), t).toBe("them")
    for (const t of ["mine", "Mine now", "me", "my ball", "on me"]) expect(owedByFromReply(t), t).toBe("ryan")
    for (const t of ["done", "snooze 3d", "theirsx", "the report is theirs", ""]) expect(owedByFromReply(t), t).toBeNull()
  })
})

describe("Definition of done — the week replayed, then the brief", () => {
  it("Waiting on you (1) Halleck disclosures · Waiting on them (1) Amanda / South Bay Termite · no Unanswered", () => {
    const NOW = Date.parse("2026-10-17T14:30:00.000Z")
    const loops: Loop[] = []
    const messages: Array<{ gmail_id: string; thread_id: string; sender: string; sender_name?: string; subject: string; internal_date: string; classification: Cls }> = []
    const dismissed: Record<string, string> = {}
    const arrive = (m: Msg, cls: Cls, kind = "human", createdAt?: string) => {
      messages.push({ gmail_id: m.id, thread_id: m.threadId, sender: m.from.email, sender_name: m.from.name, subject: m.subject, internal_date: m.internalDate, classification: { is_human: kind === "human", ...cls } })
      const event = completionEvent(m, cls)
      if (event) {
        applyCompletion(loops, event)
        for (const r of messages) if (r.thread_id !== m.threadId && !dismissed[r.thread_id] && completionDismisses(event, r)) dismissed[r.thread_id] = m.internalDate
        return
      }
      if (cls.needs_reply || kind === "docusign_request") simulateUpsert(loops, m, cls, { kind, createdAt })
    }
    // 10-12 → 10-16 in arrival order (the two late rows carry the replay's 23:50 created_at).
    arrive(halleckSign, halleckSignCls)
    arrive(fbComment, fbCommentCls)
    arrive(juanSoftQuote, { is_human: true, needs_reply: true, ask: "Reply to Juan about the soft quote" })
    arrive(fbPaid, {})
    arrive(halleckDisclosures, { needs_reply: true }, "docusign_request")
    arrive(halleckResults, halleckResultsCls, "automated", "2026-10-16T23:50:00.000Z")
    arrive(quitoBooking, quitoBookingCls)
    arrive(quitoSign, quitoSignCls)
    arrive(amandaQuitoFwd, amandaQuitoFwdCls)
    arrive(amandaTermite, amandaTermiteCls)
    arrive(halleckPaid, {}, "automated")
    arrive(halleckUpdated, {}, "automated")
    arrive(juanNoo, juanNooCls, "human", "2026-10-16T23:50:00.000Z")
    applyCompletion(loops, reportFiledEvent("5764 Halleck Dr"))
    // Before Ryan's sent mail is counted: the disclosures, the Quito ask (one loop for three emails) and Juan's two threads.
    expect(loops.filter((l) => l.status === "open")).toHaveLength(5)
    // Ryan's sent mail over the week (Parts A + B): Juan's two threads close (one by thread, one by recipient), and the
    // "Paid" he sent HomeSentry on 10-16 20:40 answers the Quito ask too (same counterparty, after the Quito emails) —
    // the operator hand-closed those three rows as well.
    const sent = foldSent([...sentToJuan, halleckPaidReply], { self: "ryan@lrghomes.com" })
    for (const l of loops) if (["open", "snoozed", "acknowledged"].includes(l.status) && answeredBy(l, sent)) l.status = "resolved_by_reply"
    expect(loops.find((l) => l.gmail_id === juanSoftQuote.id)?.status).toBe("resolved_by_reply")

    const { mine, theirs } = splitLoops(loops.filter((l) => l.status === "open"))
    expect(mine.map((l) => l.ask)).toEqual(["Sign: 5764 Halleck Dr San Jose - Disclosures"])
    expect(theirs.map((l) => `${l.counterparty} / ${l.ask}`)).toEqual([`Amanda Bakshi / ${amandaTermiteCls.ask}`])
    expect(loops.find((l) => l.gmail_id === amandaQuitoFwd.id)?.status).toBe("resolved_by_reply")
    // A later Quito receipt has nothing left to close and leaves the two survivors alone.
    expect(applyCompletion(loops, completionEvent(quitoPaid))).toEqual([])
    expect(splitLoops(loops.filter((l) => l.status === "open")).mine.map((l) => l.ask)).toEqual(["Sign: 5764 Halleck Dr San Jose - Disclosures"])

    const openThreads = new Set(loops.filter((l) => l.status === "open").map((l) => l.thread_id))
    const looseEnds = messages.filter((m) => isLooseEnd(m, { sent, openThreads, dismissed, now: NOW }))
    expect(looseEnds).toEqual([])
    // What closed what.
    expect(loops.find((l) => l.gmail_id === halleckSign.id)?.status).toBe("resolved_by_event")
    expect(loops.find((l) => l.thread_id === halleckResults.threadId)?.status).toBe("resolved_by_event")
    expect(loops.find((l) => l.gmail_id === fbComment.id)?.status).toBe("resolved_by_event")
    expect(loops.find((l) => l.gmail_id === juanNoo.id)?.status).toBe("resolved_by_reply")
    expect(Object.keys(dismissed).sort()).toEqual([fbComment.threadId, halleckResults.threadId, halleckSign.threadId].sort())
    expect(addressIn(halleckDisclosures.subject)).toBe("5764 Halleck Dr")
  })
})
