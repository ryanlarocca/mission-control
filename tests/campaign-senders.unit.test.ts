import { describe, it, expect } from "vitest"
// The engine's per-sender ramp/health logic is plain ESM; vitest loads it
// directly. tsc infers types from its JSDoc defaults (e.g. `hours = null`)
// that are narrower than the runtime contract, so loosen them here.
import * as sendersModule from "../scripts/campaign-senders.mjs"
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { evaluateSenderDay, canaryGate, isSenderPaused, withPause, withResume, withCanaryVerdict, freshState, DEFAULT_GATES } = sendersModule as unknown as Record<string, any>

const buys = { email: "ryan@lrghomesbuys.com", label: "buys", role: "workhorse", ramp: [5, 10, 20, 35, 50, 75, 100], ceiling: 100 }
const gates = { ...DEFAULT_GATES }
const greenDay = (sent: number) => ({ sent, failed: 0, bounces: 0, replies: 1, unsubs: 0, autoReplies: 0 })

describe("per-sender pause (item 3)", () => {
  it("an engine pause expires on its own; a manual pause does not", () => {
    const engine = withPause(freshState(), { reason: "bounce", by: "engine", hours: 48 })
    expect(isSenderPaused(engine)).toBe(true)
    expect(isSenderPaused(engine, Date.now() + 49 * 3_600_000)).toBe(false)
    const manual = withPause(freshState(), { reason: "manual", by: "ryan", hours: null })
    expect(isSenderPaused(manual, Date.now() + 365 * 86_400_000)).toBe(true)
    const resumed = withResume(manual, { by: "ryan" })
    expect(isSenderPaused(resumed)).toBe(false)
    expect(resumed.paused_reason).toBeNull()
  })

  it("a red bounce day recommends an auto-pause and drops a rung; a pause alone only holds", () => {
    const st = { ...freshState(), step: 2, entered_step: "2026-10-01", healthy_days: 2 }
    const red = evaluateSenderDay({ sender: buys, state: st, day: "2026-10-06", metrics: { ...greenDay(20), bounces: 1 }, trailing: { sent: 60, bounces: 0, replies: 2 }, gates })
    expect(red.status).toBe("🔴")
    expect(red.decision).toBe("drop")
    expect(red.autoPause?.reason).toMatch(/bounce rate/)
    expect(red.state.step).toBe(1)
    const held = evaluateSenderDay({ sender: buys, state: st, day: "2026-10-06", metrics: greenDay(20), trailing: { sent: 60, bounces: 0, replies: 2 }, gates, extra: { paused: "manual (ryan)" } })
    expect(held.status).toBe("🟡")
    expect(held.decision).toBe("hold")
    expect(held.autoPause).toBeNull()
    expect(held.state.step).toBe(2)
  })

  it("below 10 sends, two bounces is red but one is not", () => {
    const st = { ...freshState(), entered_step: "2026-10-01" }
    const one = evaluateSenderDay({ sender: buys, state: st, day: "2026-10-02", metrics: { ...greenDay(5), bounces: 1 }, trailing: {}, gates })
    expect(one.status).toBe("🟡")
    expect(one.autoPause).toBeNull()
    const two = evaluateSenderDay({ sender: buys, state: st, day: "2026-10-02", metrics: { ...greenDay(5), bounces: 2 }, trailing: {}, gates })
    expect(two.status).toBe("🔴")
    expect(two.autoPause?.hours).toBe(gates.autoPauseHours)
  })
})

describe("canary gate (brief: Primary 3 days running)", () => {
  it("needs three primary verdicts, the newest recent", () => {
    let st = freshState()
    expect(canaryGate(st, "2026-10-03", gates).pass).toBe(false)
    st = withCanaryVerdict(st, "2026-10-01", "primary")
    st = withCanaryVerdict(st, "2026-10-02", "primary")
    expect(canaryGate(st, "2026-10-03", gates).pass).toBe(false) // 2/3
    st = withCanaryVerdict(st, "2026-10-03", "primary")
    expect(canaryGate(st, "2026-10-03", gates).pass).toBe(true)
    expect(canaryGate(st, "2026-10-20", gates).pass).toBe(false) // stale
    st = withCanaryVerdict(st, "2026-10-04", "promotions")
    expect(canaryGate(st, "2026-10-04", gates).pass).toBe(false)
    expect(() => withCanaryVerdict(st, "2026-10-05", "inbox")).toThrow()
  })

  it("blocks advancement until the verdicts exist, then lets a healthy streak through", () => {
    const base = { ...freshState(), entered_step: "2026-10-01", healthy_days: 2, history: [{ day: "2026-09-24", step: 0, cap: 5, sent: 5, bounces: 0, replies: 0, status: "🟢", decision: "hold" }] }
    const blocked = evaluateSenderDay({ sender: buys, state: base, day: "2026-10-03", metrics: greenDay(5), trailing: { sent: 10, bounces: 0, replies: 1 }, gates })
    expect(blocked.decision).toBe("hold")
    expect(blocked.checks.find((c: { name: string }) => c.name.startsWith("canary"))?.pass).toBe(false)
    let st = base
    for (const d of ["2026-10-01", "2026-10-02", "2026-10-03"]) st = withCanaryVerdict(st, d, "primary")
    const advanced = evaluateSenderDay({ sender: buys, state: st, day: "2026-10-03", metrics: greenDay(5), trailing: { sent: 10, bounces: 0, replies: 1 }, gates })
    expect(advanced.decision).toBe("advance")
    expect(advanced.state.step).toBe(1)
    const advisory = evaluateSenderDay({ sender: buys, state: base, day: "2026-10-03", metrics: greenDay(5), trailing: { sent: 10, bounces: 0, replies: 1 }, gates: { ...gates, requireCanaryVerdict: false } })
    expect(advisory.decision).toBe("advance")
  })

  it("Spam two days running pauses; one Spam day only warns", () => {
    let st = { ...freshState(), step: 1, entered_step: "2026-10-01" }
    st = withCanaryVerdict(st, "2026-10-06", "spam")
    const one = evaluateSenderDay({ sender: buys, state: st, day: "2026-10-06", metrics: greenDay(10), trailing: {}, gates })
    expect(one.status).toBe("🟡")
    expect(one.autoPause).toBeNull()
    st = withCanaryVerdict(st, "2026-10-07", "spam")
    const two = evaluateSenderDay({ sender: buys, state: st, day: "2026-10-07", metrics: greenDay(10), trailing: {}, gates })
    expect(two.status).toBe("🔴")
    expect(two.autoPause?.reason).toMatch(/Spam 2 days/)
    expect(two.decision).toBe("drop")
  })
})

describe("consistency rule", () => {
  it("counts gap days and warns after two", () => {
    const st = { ...freshState(), step: 1, entered_step: "2026-10-01", healthy_days: 2 }
    const g1 = evaluateSenderDay({ sender: buys, state: st, day: "2026-10-06", metrics: greenDay(0), trailing: {}, gates })
    expect(g1.decision).toBe("gap")
    expect(g1.state.gap_days).toBe(1)
    expect(g1.state.healthy_days).toBe(0)
    expect(g1.status).toBe("🟢")
    const g2 = evaluateSenderDay({ sender: buys, state: g1.state, day: "2026-10-07", metrics: greenDay(0), trailing: {}, gates })
    expect(g2.state.gap_days).toBe(2)
    expect(g2.warnings.join()).toMatch(/no sends for 2 weekdays/)
    const back = evaluateSenderDay({ sender: buys, state: g2.state, day: "2026-10-08", metrics: greenDay(10), trailing: {}, gates })
    expect(back.state.gap_days).toBe(0)
  })
})
