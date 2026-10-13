import { describe, it, expect } from "vitest"
// Plain ESM loaded directly (see tests/campaign-senders.unit.test.ts). The
// Gmail read lives in the same module but is never touched here.
import * as judgeModule from "../scripts/canary-judge.mjs"
import * as sendersModule from "../scripts/campaign-senders.mjs"
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { verdictFromLabels, parseCanarySubject, parseSenderAddress, ptDayFromInternalDate, judgeQueryFor, decideVerdict, canaryOldEnough, planBackfill, stallReason, upsertEnvLine, isJudgeAuthError, verdictWord } = judgeModule as unknown as Record<string, any>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { evaluateSenderDay, withCanaryVerdict, freshState, DEFAULT_GATES } = sendersModule as unknown as Record<string, any>

const buys = { email: "ryan@lrghomesbuys.com", label: "buys", role: "workhorse", ramp: [5, 10, 20, 35, 50, 75, 100], ceiling: 100 }
const offers = { email: "ryan@lrghomesoffers.com", label: "offers", role: "understudy", ramp: [3, 5, 10, 20, 30, 40], ceiling: 40 }
const gates = { ...DEFAULT_GATES }
const greenDay = (sent: number) => ({ sent, failed: 0, bounces: 0, replies: 1, unsubs: 0, autoReplies: 0 })

describe("verdictFromLabels", () => {
  it("SPAM wins over everything", () => {
    expect(verdictFromLabels(["SPAM", "INBOX", "CATEGORY_PROMOTIONS"])).toBe("spam")
    expect(verdictFromLabels(["UNREAD", "SPAM"])).toBe("spam")
  })
  it("any non-Primary tab is promotions", () => {
    expect(verdictFromLabels(["INBOX", "CATEGORY_PROMOTIONS", "UNREAD"])).toBe("promotions")
    expect(verdictFromLabels(["INBOX", "CATEGORY_SOCIAL"])).toBe("promotions")
    expect(verdictFromLabels(["INBOX", "CATEGORY_UPDATES"])).toBe("promotions")
    expect(verdictFromLabels(["INBOX", "CATEGORY_FORUMS"])).toBe("promotions")
  })
  it("INBOX without a tab is primary (CATEGORY_PERSONAL included)", () => {
    expect(verdictFromLabels(["INBOX", "UNREAD", "CATEGORY_PERSONAL"])).toBe("primary")
    expect(verdictFromLabels(["inbox"])).toBe("primary")
  })
  it("archived / trashed / unknown is null, never a verdict", () => {
    expect(verdictFromLabels(["UNREAD", "CATEGORY_PERSONAL"])).toBeNull()
    expect(verdictFromLabels(["TRASH"])).toBeNull()
    expect(verdictFromLabels([])).toBeNull()
    expect(verdictFromLabels(undefined)).toBeNull()
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
  it("derives the PT day from internalDate (epoch ms, string or number)", () => {
    // 2026-10-06T02:30:00Z is still Oct 5 in Los Angeles (PDT, UTC-7).
    expect(ptDayFromInternalDate(String(Date.UTC(2026, 9, 6, 2, 30)))).toBe("2026-10-05")
    expect(ptDayFromInternalDate(Date.UTC(2026, 9, 6, 7, 0))).toBe("2026-10-06")
    // 2026-01-15T07:59:00Z is Jan 14 in PST (UTC-8).
    expect(ptDayFromInternalDate(Date.UTC(2026, 0, 15, 7, 59))).toBe("2026-01-14")
    expect(ptDayFromInternalDate("garbage")).toBeNull()
    expect(ptDayFromInternalDate(0)).toBeNull()
  })
  it("the daily query targets one sender's canary by its subject tag", () => {
    expect(judgeQueryFor("ryan@lrghomesbuys.com", "C8", "buys")).toBe('from:ryan@lrghomesbuys.com subject:"[C8 buys]" newer_than:3d')
  })
  it("plans one verdict per (sender, PT day), newest message winning, unknown senders skipped", () => {
    const t = (d: number, h: number) => Date.UTC(2026, 9, d, h)
    const messages = [
      { from: "Ryan LaRocca <ryan@lrghomesbuys.com>", subject: "[C5 buys] a", internalDate: t(5, 17), labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] },
      { from: "Ryan LaRocca <ryan@lrghomesbuys.com>", subject: "[C5 buys] a (resent)", internalDate: t(5, 18), labelIds: ["INBOX"] },
      { from: "Ryan LaRocca <ryan@lrghomesoffers.com>", subject: "[C5 offers] b", internalDate: t(5, 17), labelIds: ["SPAM"] },
      { from: "Ryan LaRocca <ryan@lrghomesoffers.com>", subject: "[C6 offers] c", internalDate: t(6, 17), labelIds: ["UNREAD"] },
      { from: "someone@else.example", subject: "[C9 buys] spoof", internalDate: t(6, 17), labelIds: ["INBOX"] },
      { from: "Ryan LaRocca <ryan@lrghomesbuys.com>", subject: "[C6 offers] mislabeled", internalDate: t(6, 17), labelIds: ["INBOX"] },
      { from: "Ryan LaRocca <ryan@lrghomesbuys.com>", subject: "no tag", internalDate: t(6, 17), labelIds: ["INBOX"] },
    ]
    const states = new Map([[buys.email, freshState()], [offers.email, withCanaryVerdict(freshState(), "2026-10-05", "promotions")]])
    const rows = planBackfill({ messages, senders: [buys, offers], states })
    const key = (r: { sender: string; day: string }) => `${r.day} ${r.sender}`
    const byKey = Object.fromEntries(rows.map((r: { sender: string; day: string }) => [key(r), r]))
    // newest buys message on Oct 5 wins → primary
    expect(byKey["2026-10-05 ryan@lrghomesbuys.com"]).toMatchObject({ action: "record", verdict: "primary", code: "C5" })
    // Ryan already recorded offers Oct 5 → never overwritten
    expect(byKey["2026-10-05 ryan@lrghomesoffers.com"]).toMatchObject({ action: "skip", reason: "already recorded", existing: "promotions" })
    // archived → not found, nothing recorded
    expect(byKey["2026-10-06 ryan@lrghomesoffers.com"]).toMatchObject({ action: "skip", reason: "not found" })
    expect(rows.find((r: { sender: string }) => r.sender === "someone@else.example")).toMatchObject({ action: "skip", reason: "unknown sender" })
    expect(rows.find((r: { reason?: string }) => /label mismatch/.test(r.reason ?? ""))).toMatchObject({ sender: buys.email, label: "offers" })
    expect(rows.filter((r: { action: string }) => r.action === "record")).toHaveLength(1)
  })
})

describe("decideVerdict never overwrites an existing verdict", () => {
  it("Ryan's Telegram verdict for the day wins, whatever Gmail says", () => {
    const st = withCanaryVerdict(freshState(), "2026-10-12", "promotions")
    expect(decideVerdict({ state: st, day: "2026-10-12", labelIds: ["INBOX"] })).toEqual({ action: "skip", reason: "already recorded", existing: "promotions" })
    expect(decideVerdict({ state: st, day: "2026-10-12", labelIds: ["SPAM"] })).toMatchObject({ action: "skip" })
    // another day is still open
    expect(decideVerdict({ state: st, day: "2026-10-13", labelIds: ["INBOX"] })).toEqual({ action: "record", verdict: "primary" })
  })
  it("no message, or a message without a placement label, records nothing", () => {
    expect(decideVerdict({ state: freshState(), day: "2026-10-13", labelIds: [], found: false })).toEqual({ action: "skip", reason: "not found" })
    expect(decideVerdict({ state: freshState(), day: "2026-10-13", labelIds: ["TRASH"] })).toEqual({ action: "skip", reason: "not found" })
    expect(decideVerdict({ state: null, day: "2026-10-13", labelIds: ["SPAM"] })).toEqual({ action: "record", verdict: "spam" })
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
    expect(reason).toBe('ramp stalled: buys has 7 healthy days but only 1/3 canary verdicts — the judge is not recording. Check CANARY_JUDGE_OAUTH_REFRESH_TOKEN or reply "canary buys primary|promotions|spam".')
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

describe("consent helpers", () => {
  it("upsertEnvLine replaces an existing line, else appends, single-quoted", () => {
    expect(upsertEnvLine("A=1\nCANARY_JUDGE_OAUTH_REFRESH_TOKEN='old'\nB=2\n", "CANARY_JUDGE_OAUTH_REFRESH_TOKEN", "new")).toBe("A=1\nCANARY_JUDGE_OAUTH_REFRESH_TOKEN='new'\nB=2\n")
    expect(upsertEnvLine("A=1", "CANARY_JUDGE_OAUTH_REFRESH_TOKEN", "tok")).toBe("A=1\nCANARY_JUDGE_OAUTH_REFRESH_TOKEN='tok'\n")
    expect(upsertEnvLine("", "K", "v")).toBe("K='v'\n")
    expect(() => upsertEnvLine("", "K", "it's")).toThrow(/single quote/)
  })
  it("recognises re-consent errors", () => {
    expect(isJudgeAuthError(new Error("invalid_grant"))).toBe(true)
    expect(isJudgeAuthError(new Error("Request had insufficient authentication scopes."))).toBe(true)
    expect(isJudgeAuthError(new Error("ECONNRESET"))).toBe(false)
    expect(verdictWord("promotions")).toBe("Promotions")
  })
})
