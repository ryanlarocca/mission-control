import { describe, it, expect } from "vitest"
// Plain ESM loaded directly (see tests/campaign-senders.unit.test.ts) — the
// engine's autopilot gates, pure and credential-free.
import * as gatesModule from "../scripts/campaign-gates.mjs"
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { resolveAutoSend, withTouchRegated, withTouchAuto, parseEnvTouches, AUTO_SEND_KEY, removeTripwire, describeRemovedSends, touchesOfRemoves, bounceBreaker, isDayStopped, withDayStop } = gatesModule as unknown as Record<string, any>

const V5 = "v5-2026-10-02"
const V6 = "v6-2026-11-01"
const now = new Date("2026-10-15T18:00:00Z")

describe("Task 1 — auto-approve lives in the database", () => {
  it("parses the legacy env list", () => {
    expect(parseEnvTouches("1")).toEqual([1])
    expect(parseEnvTouches(" 2, 1 ,1,x")).toEqual([1, 2])
    expect(parseEnvTouches("")).toEqual([])
    expect(parseEnvTouches(undefined)).toEqual([])
    expect(AUTO_SEND_KEY).toBe("auto_send_touches")
  })

  it("absent row → env fallback, and the row gets written so the env var retires", () => {
    const r = resolveAutoSend({ row: null, envValue: "1", promptVersion: V5, now })
    expect([...r.touches]).toEqual([1])
    expect(r.source).toBe("env")
    expect(r.write).toMatchObject({ touches: [1], pinned_prompt_version: V5, changed_by: "engine", changed_at: now.toISOString() })
    expect(r.alert).toBeNull()
    expect(r.logLine).toMatch(/env fallback/)
    const none = resolveAutoSend({ row: null, envValue: "", promptVersion: V5, now })
    expect(none.touches.size).toBe(0)
    expect(none.write.touches).toEqual([])
  })

  it("db row pinned to the live prompt → auto, nothing written, log names the pin", () => {
    const row = { touches: [1], pinned_prompt_version: V5, engine_prompt_version: V5, changed_by: "seed", changed_at: "2026-10-15T00:00:00Z", reason: "seed" }
    const r = resolveAutoSend({ row, envValue: "", promptVersion: V5, now })
    expect([...r.touches]).toEqual([1])
    expect(r.source).toBe("db")
    expect(r.write).toBeNull()
    expect(r.alert).toBeNull()
    expect(r.logLine).toBe(`auto T1 (db, pinned ${V5})`)
    // the env var is ignored once the row exists
    const r2 = resolveAutoSend({ row: { ...row, touches: [] }, envValue: "1", promptVersion: V5, now })
    expect(r2.touches.size).toBe(0)
    expect(r2.logLine).toMatch(/^auto none \(db/)
  })

  it("records the engine's prompt version on the row (so Telegram 'on' can re-pin) without alerting", () => {
    const row = { touches: [1], pinned_prompt_version: V5, changed_by: "seed", changed_at: "x", reason: "seed" }
    const r = resolveAutoSend({ row, envValue: "", promptVersion: V5, now })
    expect(r.write).toMatchObject({ touches: [1], engine_prompt_version: V5 })
    expect(r.alert).toBeNull()
  })

  it("prompt change re-gates the touch, leaves the reason on the row, and tells Ryan", () => {
    const row = { touches: [1], pinned_prompt_version: V5, engine_prompt_version: V5, changed_by: "ryan", changed_at: "x", reason: "manual" }
    const r = resolveAutoSend({ row, envValue: "1", promptVersion: V6, now })
    expect(r.touches.size).toBe(0)
    expect(r.write).toMatchObject({ touches: [], regated_touches: [1], pinned_prompt_version: V5, engine_prompt_version: V6, changed_by: "engine", reason: `prompt changed ${V5} → ${V6}` })
    expect(r.alert).toBe(`T1 re-gated: prompt changed ${V5} → ${V6} — review today's drafts, then reply \`auto T1 on\``)
    // once re-gated (touches empty) a later pass is quiet
    const again = resolveAutoSend({ row: r.write, envValue: "1", promptVersion: V6, now })
    expect(again.touches.size).toBe(0)
    expect(again.alert).toBeNull()
    expect(again.write).toBeNull()
  })

  it("a tripwire re-gates one touch and keeps the others", () => {
    const row = { touches: [1, 2], pinned_prompt_version: V5 }
    const { row: next, changed } = withTouchRegated(row, 1, "5 removes (16.7%) today", now)
    expect(changed).toBe(true)
    expect(next).toMatchObject({ touches: [2], regated_touches: [1], reason: "5 removes (16.7%) today", changed_by: "engine" })
    expect(withTouchRegated(next, 1, "again", now).changed).toBe(false)
    expect(withTouchRegated(null, 1, "nothing", now)).toEqual({ row: null, changed: false })
  })

  it("'auto T1 on' re-pins to the current prompt; 'off' keeps the pin", () => {
    const regated = { touches: [], regated_touches: [1], pinned_prompt_version: V5, engine_prompt_version: V6, reason: "prompt changed" }
    const on = withTouchAuto(regated, 1, true, { promptVersion: V6, now })
    expect(on).toMatchObject({ touches: [1], pinned_prompt_version: V6, regated_touches: [], changed_by: "ryan", reason: "manual: auto T1 on (Telegram)" })
    const two = withTouchAuto(on, 2, true, { promptVersion: V6, now })
    expect(two.touches).toEqual([1, 2])
    const off = withTouchAuto(two, 1, false, { promptVersion: V6, now })
    expect(off).toMatchObject({ touches: [2], pinned_prompt_version: V6, reason: "manual: auto T1 off (Telegram)" })
    // no promptVersion given → fall back to what the engine last reported
    expect(withTouchAuto(regated, 1, true, { now }).pinned_prompt_version).toBe(V6)
    expect(withTouchAuto(null, 1, true, { promptVersion: V5, now })).toMatchObject({ touches: [1], pinned_prompt_version: V5 })
  })
})

describe("Task 2 — floored remove tripwire (removes never hold the ramp on their own)", () => {
  it("2/8 → no trip; 3/20 → yellow; 5/30 → red", () => {
    expect(removeTripwire({ sent: 8, unsubs: 2 }).level).toBe("none")
    expect(removeTripwire({ sent: 20, unsubs: 3 })).toMatchObject({ level: "yellow", removes: 3, sent: 20 })
    expect(removeTripwire({ sent: 30, unsubs: 5 })).toMatchObject({ level: "red", removes: 5, sent: 30 })
  })
  it("both floors must clear: a small share on a big day, or a big share on a tiny day, is nothing", () => {
    expect(removeTripwire({ sent: 100, unsubs: 4 }).level).toBe("none") // 4% < 10%
    expect(removeTripwire({ sent: 100, unsubs: 9 }).level).toBe("none") // 9 ≥ 5 but 9% < 15% and < 10% → none
    expect(removeTripwire({ sent: 100, unsubs: 10 }).level).toBe("yellow") // 10% but < 15%
    expect(removeTripwire({ sent: 100, unsubs: 15 }).level).toBe("red")
    expect(removeTripwire({ sent: 3, unsubs: 1 }).level).toBe("none") // 33% but only 1 (the 2026-10-14 offers day)
    expect(removeTripwire({ sent: 3, unsubs: 2 }).level).toBe("none")
    expect(removeTripwire({ sent: 0, unsubs: 0 }).level).toBe("none")
    expect(removeTripwire({ sent: 40, unsubs: 4 }).level).toBe("yellow") // 10% exactly
    expect(removeTripwire({ sent: 40, unsubs: 6 }).level).toBe("red") // 15% exactly
    expect(removeTripwire({ sent: 20, unsubs: 3 }).text).toBe("3 removes (15.0% of 20 sent) ≥ 3 and ≥ 10%")
  })
  it("groups the removed sends by copy for the 'check the copy' line", () => {
    const details = [
      { touch_number: 1, prompt_version: "v5-2026-10-02", variant: "D", subject: "Buying in the South Bay again" },
      { touch_number: 1, prompt_version: "v5-2026-10-02", variant: "D", subject: "Still buying in the South Bay" },
      { touch_number: 2, prompt_version: null, variant: null, subject: "The buyer who actually closes" },
      null,
    ]
    expect(describeRemovedSends(details)).toBe('T1 v5-2026-10-02/D ×2: "Buying in the South Bay again", "Still buying in the South Bay" · T2 template ×1: "The buyer who actually closes"')
    expect(touchesOfRemoves(details)).toEqual([1, 2])
    expect(describeRemovedSends([])).toBe("")
    expect(touchesOfRemoves(undefined)).toEqual([])
  })
})

describe("Task 3 — intraday bounce circuit breaker", () => {
  it("1/3 → nothing; 2/8 → day-stop; 1/40 → nothing; 3/40 → red", () => {
    expect(bounceBreaker({ sent: 3, bounces: 1 }).level).toBe("none")
    expect(bounceBreaker({ sent: 8, bounces: 2 })).toMatchObject({ level: "day_stop", text: "2 bounces on 8 sent (2nd bounce below 10)" })
    expect(bounceBreaker({ sent: 40, bounces: 1 }).level).toBe("none")
    expect(bounceBreaker({ sent: 40, bounces: 3 })).toMatchObject({ level: "red", text: "bounce rate 7.5% (3/40) ≥ 5%" })
  })
  it("percentages only apply at ≥ 10 sent; below that only the absolute counts do", () => {
    expect(bounceBreaker({ sent: 50, bounces: 2 })).toMatchObject({ level: "day_stop", text: "bounce rate 4.0% (2/50) ≥ 2%" })
    expect(bounceBreaker({ sent: 100, bounces: 2 }).level).toBe("day_stop") // 2% exactly
    expect(bounceBreaker({ sent: 200, bounces: 2 }).level).toBe("none") // 1% — below the line at volume
    expect(bounceBreaker({ sent: 100, bounces: 5 }).level).toBe("red") // 5% exactly
    expect(bounceBreaker({ sent: 9, bounces: 2 }).level).toBe("day_stop")
    expect(bounceBreaker({ sent: 0, bounces: 0 }).level).toBe("none")
    expect(bounceBreaker({ sent: 0, bounces: 2 }).level).toBe("day_stop")
  })
  it("3 bounces inside the first hour of sending is red at any volume", () => {
    expect(bounceBreaker({ sent: 5, bounces: 3, bouncesFirstHour: 3 })).toMatchObject({ level: "red" })
    expect(bounceBreaker({ sent: 200, bounces: 3, bouncesFirstHour: 3 }).level).toBe("red")
    expect(bounceBreaker({ sent: 200, bounces: 3, bouncesFirstHour: 2 }).level).toBe("none")
  })
  it("honours the config's bounceRedRate as the day-stop line and bounceBreakerRate as red", () => {
    expect(bounceBreaker({ sent: 100, bounces: 3 }, { bounceRedRate: 0.02, bounceBreakerRate: 0.05 }).level).toBe("day_stop")
    expect(bounceBreaker({ sent: 100, bounces: 3 }, { bounceRedRate: 0.02, bounceBreakerRate: 0.03 }).level).toBe("red")
  })
  it("day-stop is a per-day sender state that the calendar clears", () => {
    const st = withDayStop({ step: 1 }, { day: "2026-10-15", reason: "2 bounces on 8 sent", now })
    expect(st).toMatchObject({ step: 1, day_stop: { day: "2026-10-15", reason: "2 bounces on 8 sent", at: now.toISOString() } })
    expect(isDayStopped(st, "2026-10-15")).toBe(true)
    expect(isDayStopped(st, "2026-10-16")).toBe(false)
    expect(isDayStopped(null, "2026-10-15")).toBe(false)
    expect(isDayStopped({ day_stop: null }, "2026-10-15")).toBe(false)
  })
})

describe("Task 6 — touch one takes the budget first", () => {
  const { partitionTouchOne, t1Supply, describeT1Supply } = gatesModule as unknown as Record<string, any>
  it("stable-partitions T1-due ahead of T2+ regardless of next_touch_at, keeping priority order within each half", () => {
    // already sorted by priority (repliers → Relationships → everyone else), then due date
    const sorted = [
      { id: "replier-t2", touch_number: 1, next_touch_at: "2026-09-01" },
      { id: "rel-t1", touch_number: 0, next_touch_at: "2026-10-10" },
      { id: "stranger-t2-old", touch_number: 1, next_touch_at: "2026-09-15" },
      { id: "stranger-t1-a", touch_number: 0, next_touch_at: "2026-10-01" },
      { id: "stranger-t1-b", touch_number: 0, next_touch_at: "2026-10-12" },
      { id: "stranger-t3", touch_number: 2, next_touch_at: "2026-09-20" },
    ]
    expect(partitionTouchOne(sorted).map((c: { id: string }) => c.id)).toEqual(["rel-t1", "stranger-t1-a", "stranger-t1-b", "replier-t2", "stranger-t2-old", "stranger-t3"])
    // the day the T1 queue is empty, T2 simply comes through oldest first — no mode switch
    const noT1 = sorted.filter((c) => c.touch_number > 0)
    expect(partitionTouchOne(noT1)).toEqual(noT1)
    expect(partitionTouchOne([])).toEqual([])
    expect(partitionTouchOne(undefined)).toEqual([])
    expect(partitionTouchOne([{ id: "x" }]).map((c: { id: string }) => c.id)).toEqual(["x"]) // missing touch_number reads as 0
  })
  it("days of T1 supply at current caps rounds up and copes with no cap", () => {
    expect(t1Supply({ remaining: 2255, capTotal: 8 })).toEqual({ remaining: 2255, capTotal: 8, days: 282 })
    expect(t1Supply({ remaining: 40, capTotal: 8 })).toEqual({ remaining: 40, capTotal: 8, days: 5 })
    expect(t1Supply({ remaining: 41, capTotal: 8 }).days).toBe(6)
    expect(t1Supply({ remaining: 0, capTotal: 8 }).days).toBe(0)
    expect(t1Supply({ remaining: 10, capTotal: 0 })).toEqual({ remaining: 10, capTotal: 0, days: null })
    expect(describeT1Supply(t1Supply({ remaining: 41, capTotal: 8 }))).toBe("T1 remaining: 41 · ~6 weekdays of supply at 8/day")
    expect(describeT1Supply(t1Supply({ remaining: 8, capTotal: 8 }))).toBe("T1 remaining: 8 · ~1 weekday of supply at 8/day")
    expect(describeT1Supply(t1Supply({ remaining: 10, capTotal: 0 }))).toBe("T1 remaining: 10 (no cap — supply unknown)")
  })
})
