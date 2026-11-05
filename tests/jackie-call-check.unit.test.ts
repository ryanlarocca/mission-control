import { describe, expect, it } from "vitest"
import { countPassAlong, jackieCheckLine, type JackieCheck } from "@/lib/jackie"
import { replyTimingFromSegments, speechSegments } from "@/lib/coach/transcript"
import { CallMonitor } from "@/lib/voiceCallMonitor"
import { VOICE_TEST_INSTRUCTIONS } from "@/lib/voiceTest"

// Per-call grade + reply timing (2026-11-05, Ryan: "5 seconds of pause is
// like insane"; a caller who said "why would I sell it?" got dead air).

const clean: JackieCheck = {
  answered_first_question: true, asked_selling_too_early: false, pushed_after_no: false,
  offered_removal_unprompted: false, pass_along: 1,
}

describe("jackieCheckLine", () => {
  it("is silent on a clean call", () => {
    expect(jackieCheckLine(clean, { slowest_s: 1.4, slowest_at_s: 20 })).toBeNull()
    expect(jackieCheckLine(null, null)).toBeNull()
  })
  it("lists only what went wrong, with the slow spot's time", () => {
    const line = jackieCheckLine(
      { ...clean, answered_first_question: false, asked_selling_too_early: true, pushed_after_no: true, pass_along: 3 },
      { slowest_s: 5, slowest_at_s: 31.9 },
    )
    expect(line).toBe(`🔎 Check: didn't answer their first question · asked about selling too early · kept asking after they said no · "pass along" ×3 · 5.0 s pause at 0:31`)
  })
  it("doesn't flag a question the caller never asked", () => {
    expect(jackieCheckLine({ ...clean, answered_first_question: null }, null)).toBeNull()
  })
  it("flags a removal offer nobody asked for", () => {
    expect(jackieCheckLine({ ...clean, offered_removal_unprompted: true }, null)).toBe("🔎 Check: offered removal unprompted")
  })
})

describe("countPassAlong", () => {
  it("counts only Jackie's lines", () => {
    const t = [
      "Jackie: I can pass along your information.",
      "Caller: Can you pass that along to him?",
      "Jackie: Sure, I'll pass that along. Let me make sure to pass it along to Ryan.",
    ].join("\n")
    expect(countPassAlong(t)).toBe(3)
  })
  it("is null on an unlabelled transcript", () => {
    expect(countPassAlong("Hey this is Jackie I'll pass that along")).toBeNull()
  })
})

describe("reply timing", () => {
  // A real 11-05 call, from the recording: "Why would I sell it?" ended at
  // 31.9 s and he spoke again at 36.9 s — she never answered.
  const jackie: Array<[number, number]> = [[1.3, 3.8], [10.9, 11.2], [12.2, 13.9], [18.1, 18.3], [20.1, 20.4], [21.1, 22.1], [25.6, 26.4], [27.6, 29.2], [41.2, 43.1], [44.9, 47.7]]
  const caller: Array<[number, number]> = [[5.5, 8.9], [14.5, 16.2], [23.4, 23.7], [30.9, 31.9], [36.9, 39.1]]

  it("finds the dead air where the caller had to fill the silence", () => {
    const t = replyTimingFromSegments(jackie, caller)
    expect(t.slowest_s).toBe(5)
    expect(t.slowest_at_s).toBe(31.9)
    expect(t.over_3s).toBe(1)
    expect(t.greeting_s).toBe(1.3)
    expect(t.replies).toBe(4)
  })
  it("doesn't count a caller catching a breath mid-story", () => {
    const t = replyTimingFromSegments([[0.5, 2], [20, 21]], [[3, 8], [10.5, 15], [16, 19]])
    expect(t.over_3s).toBe(0)
    expect(t.slowest_s).toBe(1) // 19 → 20, her answer
  })
  it("ignores a caller line she was already talking over", () => {
    const t = replyTimingFromSegments([[0, 5]], [[1, 2]])
    expect(t.replies).toBe(0)
    expect(t.slowest_s).toBeNull()
  })
  it("reads speech off a mono WAV", () => {
    const rate = 8000
    const samples = new Int16Array(rate * 3) // 1 s silence, 1 s tone, 1 s silence
    for (let i = rate; i < 2 * rate; i++) samples[i] = i % 2 ? 3000 : -3000
    const data = Buffer.from(samples.buffer)
    const h = Buffer.alloc(44)
    h.write("RIFF", 0, "ascii"); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8, "ascii")
    h.write("fmt ", 12, "ascii"); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
    h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
    h.write("data", 36, "ascii"); h.writeUInt32LE(data.length, 40)
    const segs = speechSegments(Buffer.concat([h, data]))
    expect(segs).toHaveLength(1)
    expect(segs[0][0]).toBeCloseTo(1, 1)
    expect(segs[0][1]).toBeCloseTo(2, 1)
  })
})

describe("call monitor hand-offs", () => {
  it("records when she hands work to the backend", () => {
    const m = new CallMonitor(1_000)
    m.onEvent({ type: "session.delegation.created", target: "responses" }, 13_500)
    m.onEvent({ type: "session.delegation.created", target: "responses" }, 40_000)
    expect(m.state.delegations).toEqual([12.5, 39])
  })
  it("takes over state from a watcher that predates the field", () => {
    const prior = new CallMonitor(0).state
    delete prior.delegations
    const m = new CallMonitor(0, prior)
    m.onEvent({ type: "session.delegation.created" }, 2_000)
    expect(m.state.delegations).toEqual([2])
  })
})

describe("script (11-05)", () => {
  it("answers first, asks about selling only once they might", () => {
    expect(VOICE_TEST_INSTRUCTIONS).toContain("answer it before you ask them for anything")
    expect(VOICE_TEST_INSTRUCTIONS).toContain("never ask why they're selling, or what's changed, before that")
  })
  it("carries Ryan's wording for owners who aren't selling", () => {
    expect(VOICE_TEST_INSTRUCTIONS).toContain("Want me to have Ryan give you a call with a number?")
  })
  it("only offers removal to callers who complain", () => {
    expect(VOICE_TEST_INSTRUCTIONS).toContain("don't offer to take them off the list just because they asked")
  })
  it("states the license history and the counties", () => {
    expect(VOICE_TEST_INSTRUCTIONS).toContain("Ryan was licensed at one point, but these days he only invests")
    expect(VOICE_TEST_INSTRUCTIONS).toContain("all cash, as-is, with no commissions")
    expect(VOICE_TEST_INSTRUCTIONS).toContain("Santa Clara, San Mateo, and Santa Cruz counties")
  })
  it("has no quoted stock deferral line left", () => {
    expect(VOICE_TEST_INSTRUCTIONS).not.toContain(`"That's a great question for Ryan. I'll make sure he covers it when he calls."`)
  })
})
