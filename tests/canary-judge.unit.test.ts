import { describe, it, expect } from "vitest"
// Plain ESM loaded directly (see tests/campaign-senders.unit.test.ts). The
// IMAP read lives in the same module but is never touched here.
import * as judgeModule from "../scripts/canary-judge.mjs"
import * as sendersModule from "../scripts/campaign-senders.mjs"
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { verdictFromLabels, parseCanarySubject, parseSenderAddress, ptDayFromInternalDate, judgeQueryFor, promotionsQueryFor, spamQueryFor, matchesCanaryTag, newestCanary, normalizeMessageId, placementOf, summarize, describePlacement, decideVerdict, canaryOldEnough, planBackfill, stallReason, judgeConfigured, judgeImapAuth, isJudgeAuthError, judgeErrorText, verdictWord } = judgeModule as unknown as Record<string, any>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { evaluateSenderDay, withCanaryVerdict, freshState, DEFAULT_GATES } = sendersModule as unknown as Record<string, any>

const buys = { email: "ryan@lrghomesbuys.com", label: "buys", role: "workhorse", ramp: [5, 10, 20, 35, 50, 75, 100], ceiling: 100 }
const offers = { email: "ryan@lrghomesoffers.com", label: "offers", role: "understudy", ramp: [3, 5, 10, 20, 30, 40], ceiling: 40 }
const gates = { ...DEFAULT_GATES }
const greenDay = (sent: number) => ({ sent, failed: 0, bounces: 0, replies: 1, unsubs: 0, autoReplies: 0 })
// Placement signals as the IMAP read produces them: in `[Gmail]/Spam`
// (matched by Message-ID), in the All-Mail `category:` search, Gmail labels.
const inbox = { inSpam: false, inPromotions: false, labels: ["\\Inbox"] }
const promo = { inSpam: false, inPromotions: true, labels: ["\\Inbox"] }
const spam = { inSpam: true, inPromotions: false, labels: [] as string[] }
const archived = { inSpam: false, inPromotions: false, labels: [] as string[] }

describe("verdictFromLabels", () => {
  it("the spam folder wins over everything", () => {
    expect(verdictFromLabels({ inSpam: true, inPromotions: true, labels: ["\\Inbox"] })).toBe("spam")
    expect(verdictFromLabels(spam)).toBe("spam")
  })
  it("any non-Primary tab (the category: search) is promotions", () => {
    expect(verdictFromLabels(promo)).toBe("promotions")
    expect(verdictFromLabels({ inSpam: false, inPromotions: true, labels: [] })).toBe("promotions")
  })
  it("\\Inbox without a tab is primary (\\Important and user labels don't matter)", () => {
    expect(verdictFromLabels(inbox)).toBe("primary")
    expect(verdictFromLabels({ inSpam: false, inPromotions: false, labels: ["\\Important", "\\Inbox"] })).toBe("primary")
    expect(verdictFromLabels({ inSpam: false, inPromotions: false, labels: new Set(["\\Inbox"]) })).toBe("primary")
    expect(verdictFromLabels({ labels: ["INBOX"] })).toBe("primary") // legacy label id spelling
  })
  it("archived / trashed / unknown is null, never a verdict", () => {
    expect(verdictFromLabels(archived)).toBeNull()
    expect(verdictFromLabels({ inSpam: false, inPromotions: false, labels: ["\\Important"] })).toBeNull()
    expect(verdictFromLabels({ inSpam: false, inPromotions: false, labels: ["\\Trash"] })).toBeNull()
    expect(verdictFromLabels({})).toBeNull()
    expect(verdictFromLabels(undefined)).toBeNull()
    expect(verdictFromLabels(["INBOX"])).toBeNull() // the old labelIds array is not a placement
  })
})

describe("IMAP read helpers (pure)", () => {
  it("searches by sender + age only — Gmail's tokenizer drops the [C7 buys] brackets", () => {
    expect(judgeQueryFor("ryan@lrghomesbuys.com")).toBe("from:ryan@lrghomesbuys.com newer_than:3d")
    expect(judgeQueryFor("ryan@lrghomesbuys.com", 30)).toBe("from:ryan@lrghomesbuys.com newer_than:30d")
    expect(promotionsQueryFor("ryan@lrghomesbuys.com")).toBe("from:ryan@lrghomesbuys.com newer_than:30d (category:promotions OR category:social OR category:updates OR category:forums)")
    expect(spamQueryFor("ryan@lrghomesbuys.com")).toBe("from:ryan@lrghomesbuys.com")
    expect(judgeQueryFor("x@y.z")).not.toMatch(/subject:/)
  })
  it("matches the [C<n> <label>] prefix client-side", () => {
    expect(matchesCanaryTag("[C8 buys] Quick question", "C8", "buys")).toBe(true)
    expect(matchesCanaryTag("Re: [C8 Buys] Quick question", "C8", "buys")).toBe(true)
    expect(matchesCanaryTag("[C7 buys] yesterday's", "C8", "buys")).toBe(false)
    expect(matchesCanaryTag("[C8 offers] other sender", "C8", "buys")).toBe(false)
    expect(matchesCanaryTag("Quick question [C8 buys]", "C8", "buys")).toBe(false)
  })
  it("newestCanary picks the newest message carrying this canary's tag", () => {
    const msgs = [
      { subject: "[C8 buys] a", internalDate: 100, ...inbox },
      { subject: "[C8 buys] a (resent)", internalDate: 200, ...promo },
      { subject: "[C7 buys] old", internalDate: 300, ...spam },
      { subject: "Thanks!", internalDate: 400, ...inbox },
    ]
    expect(newestCanary(msgs, "C8", "buys")).toMatchObject({ subject: "[C8 buys] a (resent)", inPromotions: true })
    expect(newestCanary(msgs, "C9", "buys")).toBeNull()
    expect(newestCanary([], "C8", "buys")).toBeNull()
  })
  it("spam is matched across folders by Message-ID, promotions by UID in the same folder", () => {
    expect(normalizeMessageId(" <ABC@mail.gmail.com> ")).toBe("abc@mail.gmail.com")
    expect(normalizeMessageId(undefined)).toBeNull()
    const spamIds = new Set(["abc@mail.gmail.com"])
    const promoUids = new Set([42])
    expect(placementOf({ uid: 7, messageId: "<abc@mail.gmail.com>", labels: new Set(["\\Inbox"]), spamMessageIds: spamIds, promotionUids: promoUids }))
      .toEqual({ inSpam: true, inPromotions: false, labels: ["\\Inbox"] })
    expect(placementOf({ uid: 42, messageId: "<def@mail.gmail.com>", labels: ["\\Inbox"], spamMessageIds: spamIds, promotionUids: promoUids }))
      .toEqual({ inSpam: false, inPromotions: true, labels: ["\\Inbox"] })
    expect(placementOf({ uid: 9, messageId: "<ghi@mail.gmail.com>", labels: ["\\Inbox"], spamMessageIds: spamIds, promotionUids: promoUids }))
      .toEqual({ inSpam: false, inPromotions: false, labels: ["\\Inbox"] })
    // UID 42 in Spam is a different message than UID 42 in All Mail — the folder read passes inSpam itself.
    expect(placementOf({ uid: 42, messageId: "<zzz@x>", labels: [], inSpam: true })).toEqual({ inSpam: true, inPromotions: false, labels: [] })
  })
  it("summarize flattens an imapflow fetch result (envelope + labels + internalDate only)", () => {
    const when = new Date("2026-10-13T17:00:00Z")
    const m = summarize({ uid: 5, envelope: { from: [{ name: "Ryan LaRocca", address: "ryan@lrghomesbuys.com" }], subject: "[C8 buys] hi", messageId: "<id1@mail>", date: when }, labels: new Set(["\\Inbox", "\\Important"]), internalDate: when })
    expect(m).toEqual({ uid: 5, messageId: "<id1@mail>", from: "Ryan LaRocca <ryan@lrghomesbuys.com>", subject: "[C8 buys] hi", internalDate: when.getTime(), labels: ["\\Inbox", "\\Important"] })
    expect(parseSenderAddress(m.from)).toBe("ryan@lrghomesbuys.com")
    expect(ptDayFromInternalDate(m.internalDate)).toBe("2026-10-13")
    const bare = summarize({ uid: 6, envelope: { from: [{ address: "a@b.c" }], subject: null }, labels: undefined, internalDate: undefined })
    expect(bare).toMatchObject({ from: "a@b.c", subject: "", internalDate: 0, labels: [] })
  })
  it("describePlacement names the signals for the log line and backfill table", () => {
    expect(describePlacement({ ...spam })).toBe("spam folder, no labels")
    expect(describePlacement({ ...promo })).toBe("category:promotions, labels \\Inbox")
    expect(describePlacement({ ...inbox })).toBe("labels \\Inbox")
    expect(describePlacement(null)).toBe("—")
  })
})

describe("backfill parsing", () => {
  it("reads the canary code + label off the subject", () => {
    expect(parseCanarySubject("[C8 buys] Quick question about your listing")).toEqual({ n: 8, label: "buys" })
    expect(parseCanarySubject("Re: [C12 Offers] hello")).toEqual({ n: 12, label: "offers" })
    expect(parseCanarySubject("Quick question [C8 buys]")).toBeNull()
    expect(parseCanarySubject("[Cx buys] nope")).toBeNull()
    expect(parseCanarySubject("")).toBeNull()
  })
  it("derives the sender from the From header", () => {
    expect(parseSenderAddress("Ryan LaRocca <ryan@lrghomesbuys.com>")).toBe("ryan@lrghomesbuys.com")
    expect(parseSenderAddress("Ryan@LRGHomesOffers.com")).toBe("ryan@lrghomesoffers.com")
    expect(parseSenderAddress("not an address")).toBeNull()
    expect(parseSenderAddress("")).toBeNull()
  })
  it("derives the PT day from internalDate (epoch ms as string or number, or imapflow's Date)", () => {
    // 2026-10-06T02:30:00Z is still Oct 5 in Los Angeles (PDT, UTC-7).
    expect(ptDayFromInternalDate(String(Date.UTC(2026, 9, 6, 2, 30)))).toBe("2026-10-05")
    expect(ptDayFromInternalDate(new Date(Date.UTC(2026, 9, 6, 2, 30)))).toBe("2026-10-05")
    expect(ptDayFromInternalDate(Date.UTC(2026, 9, 6, 7, 0))).toBe("2026-10-06")
    // 2026-01-15T07:59:00Z is Jan 14 in PST (UTC-8).
    expect(ptDayFromInternalDate(Date.UTC(2026, 0, 15, 7, 59))).toBe("2026-01-14")
    expect(ptDayFromInternalDate("garbage")).toBeNull()
    expect(ptDayFromInternalDate(0)).toBeNull()
  })
  it("plans one verdict per (sender, PT day), newest message winning, unknown senders skipped", () => {
    const t = (d: number, h: number) => Date.UTC(2026, 9, d, h)
    const messages = [
      { from: "Ryan LaRocca <ryan@lrghomesbuys.com>", subject: "[C5 buys] a", internalDate: t(5, 17), ...promo },
      { from: "Ryan LaRocca <ryan@lrghomesbuys.com>", subject: "[C5 buys] a (resent)", internalDate: new Date(t(5, 18)), ...inbox },
      { from: "Ryan LaRocca <ryan@lrghomesoffers.com>", subject: "[C5 offers] b", internalDate: t(5, 17), ...spam },
      { from: "Ryan LaRocca <ryan@lrghomesoffers.com>", subject: "[C6 offers] c", internalDate: t(6, 17), ...archived },
      { from: "someone@else.example", subject: "[C9 buys] spoof", internalDate: t(6, 17), ...inbox },
      { from: "Ryan LaRocca <ryan@lrghomesbuys.com>", subject: "[C6 offers] mislabeled", internalDate: t(6, 17), ...inbox },
      { from: "Ryan LaRocca <ryan@lrghomesbuys.com>", subject: "no tag", internalDate: t(6, 17), ...inbox },
    ]
    const states = new Map([[buys.email, freshState()], [offers.email, withCanaryVerdict(freshState(), "2026-10-05", "promotions")]])
    const rows = planBackfill({ messages, senders: [buys, offers], states })
    const key = (r: { sender: string; day: string }) => `${r.day} ${r.sender}`
    const byKey = Object.fromEntries(rows.map((r: { sender: string; day: string }) => [key(r), r]))
    // newest buys message on Oct 5 wins → primary
    expect(byKey["2026-10-05 ryan@lrghomesbuys.com"]).toMatchObject({ action: "record", verdict: "primary", code: "C5", inPromotions: false, labels: ["\\Inbox"] })
    // Ryan already recorded offers Oct 5 → never overwritten
    expect(byKey["2026-10-05 ryan@lrghomesoffers.com"]).toMatchObject({ action: "skip", reason: "already recorded", existing: "promotions" })
    // archived → not found, nothing recorded
    expect(byKey["2026-10-06 ryan@lrghomesoffers.com"]).toMatchObject({ action: "skip", reason: "not found" })
    expect(rows.find((r: { sender: string }) => r.sender === "someone@else.example")).toMatchObject({ action: "skip", reason: "unknown sender" })
    expect(rows.find((r: { reason?: string }) => /label mismatch/.test(r.reason ?? ""))).toMatchObject({ sender: buys.email, label: "offers" })
    expect(rows.filter((r: { action: string }) => r.action === "record")).toHaveLength(1)
    // a spam-filed canary on an open day records spam
    const open = planBackfill({ messages, senders: [buys, offers], states: new Map([[offers.email, freshState()]]) })
    expect(open.find((r: { sender: string; day: string }) => r.sender === offers.email && r.day === "2026-10-05")).toMatchObject({ action: "record", verdict: "spam", inSpam: true })
  })
})

describe("decideVerdict never overwrites an existing verdict", () => {
  it("Ryan's Telegram verdict for the day wins, whatever the mailbox says", () => {
    const st = withCanaryVerdict(freshState(), "2026-10-12", "promotions")
    expect(decideVerdict({ state: st, day: "2026-10-12", placement: inbox })).toEqual({ action: "skip", reason: "already recorded", existing: "promotions" })
    expect(decideVerdict({ state: st, day: "2026-10-12", placement: spam })).toMatchObject({ action: "skip" })
    // another day is still open
    expect(decideVerdict({ state: st, day: "2026-10-13", placement: inbox })).toEqual({ action: "record", verdict: "primary" })
  })
  it("no message, or a message without a placement signal, records nothing", () => {
    expect(decideVerdict({ state: freshState(), day: "2026-10-13", placement: null, found: false })).toEqual({ action: "skip", reason: "not found" })
    expect(decideVerdict({ state: freshState(), day: "2026-10-13", placement: archived })).toEqual({ action: "skip", reason: "not found" })
    expect(decideVerdict({ state: freshState(), day: "2026-10-13", placement: { inSpam: false, inPromotions: false, labels: ["\\Trash"] } })).toEqual({ action: "skip", reason: "not found" })
    expect(decideVerdict({ state: null, day: "2026-10-13", placement: spam })).toEqual({ action: "record", verdict: "spam" })
    expect(decideVerdict({ state: null, day: "2026-10-13", placement: promo })).toEqual({ action: "record", verdict: "promotions" })
  })
  it("gives Gmail a 20-minute beat after the canary leaves", () => {
    const sent = new Date("2026-10-13T17:00:00Z")
    expect(canaryOldEnough(sent.toISOString(), sent.getTime() + 5 * 60_000)).toBe(false)
    expect(canaryOldEnough(sent.toISOString(), sent.getTime() + 20 * 60_000)).toBe(true)
    expect(canaryOldEnough(undefined, sent.getTime())).toBe(true) // legacy day without canary_at
  })
})

describe("stallReason (ramp stalled on the judge)", () => {
  const trailing = { sent: 30, bounces: 0, replies: 2 }
  it("held with healthy days banked and only the canary gate failing → stalled", () => {
    const st = { ...freshState(), step: 0, entered_step: "2026-10-01", healthy_days: 6, canary_verdicts: { "2026-10-02": "primary" } }
    const ev = evaluateSenderDay({ sender: buys, state: st, day: "2026-10-12", metrics: greenDay(5), trailing, gates })
    expect(ev.decision).toBe("hold")
    expect(ev.state.healthy_days).toBe(7)
    const reason = stallReason(ev, gates, "buys")
    expect(reason).toBe('ramp stalled: buys has 7 healthy days but only 1/3 canary verdicts — the judge is not recording. Check CANARY_JUDGE_IMAP_USER / CANARY_JUDGE_IMAP_PASSWORD or reply "canary buys primary|promotions|spam".')
  })
  it("stale verdicts stall too (the judge stopped recording)", () => {
    const st = { ...freshState(), entered_step: "2026-09-01", healthy_days: 5, canary_verdicts: { "2026-09-20": "primary", "2026-09-21": "primary", "2026-09-22": "primary" } }
    const ev = evaluateSenderDay({ sender: buys, state: st, day: "2026-10-12", metrics: greenDay(5), trailing, gates })
    expect(ev.decision).toBe("hold")
    expect(stallReason(ev, gates, "buys")).toMatch(/newest canary verdict is 20 days old/)
  })
  it("held on bounces (or anything besides the canary gate) is not a stall", () => {
    const st = { ...freshState(), entered_step: "2026-10-01", healthy_days: 4, canary_verdicts: { "2026-10-02": "primary" } }
    const ev = evaluateSenderDay({ sender: buys, state: st, day: "2026-10-12", metrics: { ...greenDay(5), bounces: 2 }, trailing, gates })
    expect(ev.decision).not.toBe("advance")
    expect(stallReason(ev, gates, "buys")).toBeNull()
    const paused = evaluateSenderDay({ sender: buys, state: st, day: "2026-10-12", metrics: greenDay(5), trailing, gates, extra: { paused: "manual (ryan)" } })
    expect(paused.decision).toBe("hold")
    expect(stallReason(paused, gates, "buys")).toBeNull()
  })
  it("held on recorded non-Primary verdicts is a placement problem, not a judge stall", () => {
    const st = { ...freshState(), entered_step: "2026-10-01", healthy_days: 4, canary_verdicts: { "2026-10-08": "primary", "2026-10-09": "promotions", "2026-10-12": "primary" } }
    const ev = evaluateSenderDay({ sender: buys, state: st, day: "2026-10-12", metrics: greenDay(5), trailing, gates })
    expect(ev.decision).toBe("hold")
    expect(ev.checks.filter((c: { pass: boolean }) => !c.pass).map((c: { name: string }) => c.name)).toEqual(["canary Primary 3 days"])
    expect(stallReason(ev, gates, "buys")).toBeNull()
  })
  it("not enough healthy days yet is not a stall; advancing is not a stall", () => {
    const young = { ...freshState(), entered_step: "2026-10-10", healthy_days: 1 }
    const held = evaluateSenderDay({ sender: buys, state: young, day: "2026-10-12", metrics: greenDay(5), trailing, gates })
    expect(held.decision).toBe("hold")
    expect(stallReason(held, gates, "buys")).toBeNull()
    const ready = { ...freshState(), entered_step: "2026-10-01", healthy_days: 2, canary_verdicts: { "2026-10-08": "primary", "2026-10-09": "primary", "2026-10-12": "primary" } }
    const adv = evaluateSenderDay({ sender: buys, state: ready, day: "2026-10-12", metrics: greenDay(5), trailing, gates })
    expect(adv.decision).toBe("advance")
    expect(stallReason(adv, gates, "buys")).toBeNull()
    expect(stallReason(null, gates, "buys")).toBeNull()
  })
})

describe("IMAP config + failures", () => {
  it("is configured only when both IMAP vars are set; the app password loses its spaces", () => {
    expect(judgeConfigured({})).toBe(false)
    expect(judgeConfigured({ CANARY_JUDGE_IMAP_USER: "judge@gmail.com" })).toBe(false)
    expect(judgeConfigured({ CANARY_JUDGE_IMAP_PASSWORD: "abcd efgh ijkl mnop" })).toBe(false)
    expect(judgeConfigured({ CANARY_JUDGE_IMAP_USER: "judge@gmail.com", CANARY_JUDGE_IMAP_PASSWORD: "abcd efgh ijkl mnop" })).toBe(true)
    expect(judgeImapAuth({ CANARY_JUDGE_IMAP_USER: " judge@gmail.com ", CANARY_JUDGE_IMAP_PASSWORD: "abcd efgh ijkl mnop" })).toEqual({ user: "judge@gmail.com", pass: "abcdefghijklmnop" })
    expect(() => judgeImapAuth({ CANARY_JUDGE_IMAP_USER: "judge@gmail.com" })).toThrow(/CANARY_JUDGE_IMAP_PASSWORD/)
  })
  it("recognises login failures (rerun the app password) vs transient read errors", () => {
    expect(isJudgeAuthError(Object.assign(new Error("Command failed"), { authenticationFailed: true, response: "NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)" }))).toBe(true)
    expect(isJudgeAuthError(new Error("[AUTHENTICATIONFAILED] Invalid credentials (Failure)"))).toBe(true)
    expect(isJudgeAuthError(new Error("Application-specific password required"))).toBe(true)
    expect(isJudgeAuthError(new Error("ECONNRESET"))).toBe(false)
    expect(isJudgeAuthError(new Error("Mailbox doesn't exist: [Gmail]/Spam"))).toBe(false)
    expect(judgeErrorText(Object.assign(new Error("Command failed"), { response: "NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)", serverResponseCode: "AUTHENTICATIONFAILED" }))).toBe("Command failed · NO [AUTHENTICATIONFAILED] Invalid credentials (Failure) · AUTHENTICATIONFAILED")
    expect(judgeErrorText(new Error("ECONNRESET"))).toBe("ECONNRESET")
    expect(judgeErrorText(null)).toBe("")
    expect(verdictWord("promotions")).toBe("Promotions")
  })
})
