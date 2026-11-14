import { describe, expect, it } from "vitest"
import { countPassAlong, jackieCheckLine, type JackieCheck } from "@/lib/jackie"
import { replyTimingFromSegments, speechSegments } from "@/lib/coach/transcript"
import { CallMonitor, REASON_NOTE, asksReason } from "@/lib/voiceCallMonitor"
import { VOICE_TEST_INSTRUCTIONS, callerIdNote } from "@/lib/voiceTest"

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
  it("flags a question asked more than once (11-13), and reads calls graded before the field existed", () => {
    expect(jackieCheckLine({ ...clean, repeated_question: "why they called ×3" }, null)).toBe("🔎 Check: asked more than once: why they called ×3")
    expect(jackieCheckLine({ ...clean, repeated_question: null }, null)).toBeNull()
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
    expect(VOICE_TEST_INSTRUCTIONS).toContain("never ask about selling before they've said that")
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

// 11-10 (Cornwallis call): "Hello?" pickup, no spelling, concede fast.
describe("opener + wrap-up (11-10)", () => {
  const pickedUp = () => {
    const m = new CallMonitor(0)
    m.onEvent({ type: "session.output_transcript.delta", delta: "Hello?" }, 1_000)
    m.onEvent({ type: "session.output_audio.delta" }, 1_000)
    return m
  }
  const nudges = (m: CallMonitor, now: number) => m.tick(now).filter((a) => a.type === "commentary")

  it("prompts her to say who she is once when the caller stays silent after Hello", () => {
    const m = pickedUp()
    expect(nudges(m, 3_000)).toHaveLength(0)
    const out = nudges(m, 4_500)
    expect(out).toHaveLength(1)
    expect(out[0].type === "commentary" && out[0].content).toContain("This is Jackie with LRG Homes")
    expect(nudges(m, 8_000)).toHaveLength(0)
  })
  it("stays out of the way when the caller answers", () => {
    const m = pickedUp()
    m.onEvent({ type: "session.input_transcript.delta", delta: "Hi, I got your letter" }, 2_500)
    expect(nudges(m, 6_000)).toHaveLength(0)
  })
  it("never asks anyone to spell, and drops the address at the wrap-up", () => {
    expect(VOICE_TEST_INSTRUCTIONS).toContain("Never ask anyone to spell anything")
    expect(VOICE_TEST_INSTRUCTIONS).not.toContain("spell the street name")
    expect(VOICE_TEST_INSTRUCTIONS).toContain("Drop every question you still had, including the address")
    expect(VOICE_TEST_INSTRUCTIONS).not.toContain("even when they're short with you or trying to get off the phone")
  })
})

// 11-13 (hidden-number owner): "why did you call" asked three times, reworded.
describe("one open question (11-13)", () => {
  it("asks why they called once and takes any answer", () => {
    expect(VOICE_TEST_INSTRUCTIONS).toContain("you get exactly one question per call about their reasons")
    expect(VOICE_TEST_INSTRUCTIONS).toContain("Whatever they answer is the answer")
    expect(VOICE_TEST_INSTRUCTIONS).toContain("rewording it doesn't make it a new question")
  })
  it("has no separate what's-going-on / why-selling intake item", () => {
    expect(VOICE_TEST_INSTRUCTIONS).not.toContain("What's going on with the property, and why they're thinking about selling")
    expect(VOICE_TEST_INSTRUCTIONS).toContain("Try for three things")
  })
  it("moves forward after the AI answer instead of repeating her last question", () => {
    expect(VOICE_TEST_INSTRUCTIONS).not.toContain("pick up right where you left off")
    expect(VOICE_TEST_INSTRUCTIONS).toContain("that question is spent: don't go back to it")
  })
  it("doesn't stop to note or check a spoken number, and always asks a hidden caller for one", () => {
    expect(VOICE_TEST_INSTRUCTIONS).toContain("Ryan gets the number from the recording")
    expect(callerIdNote("Anonymous")).toContain("don't let the call end without asking once")
    expect(callerIdNote("+14085550142")).toContain("Don't ask them for a number")
  })
})

// 11-13: the watcher tells her the question is spent the moment she asks it.
describe("one-question reminder (11-13)", () => {
  const said = (m: CallMonitor, text: string, at: number) => m.onEvent({ type: "session.output_transcript.delta", delta: text }, at)
  const notes = (m: CallMonitor, now: number) => m.tick(now).filter((a) => a.type === "commentary" && a.content === REASON_NOTE)

  it("recognises her ways of asking why they called", () => {
    for (const q of ["What made you decide to give us a call today?", "Okay, Walter. What's on your mind with the place?", "So, what's going on with the property?", "What has you thinking about selling?"]) {
      expect(asksReason(q)).toBe(true)
    }
    for (const q of ["What's your name?", "When's a good time for Ryan to reach you?", "What's the property address?", "I know what made you call."]) {
      expect(asksReason(q)).toBe(false)
    }
  })
  it("sends the reminder once, the first time she asks", () => {
    const m = new CallMonitor(0)
    said(m, "Hello?", 1_000)
    expect(notes(m, 1_200)).toHaveLength(0)
    said(m, "Okay. What made you decide to give us a call today?", 9_000)
    expect(notes(m, 9_100)).toHaveLength(1)
    expect(notes(m, 9_300)).toHaveLength(0)
    said(m, "What's on your mind with the place?", 20_000)
    expect(notes(m, 20_100)).toHaveLength(0)
  })
  it("survives a watcher hand-off", () => {
    const first = new CallMonitor(0)
    said(first, "What made you call?", 5_000)
    const second = new CallMonitor(0, first.state)
    expect(notes(second, 5_100)).toHaveLength(1)
  })
})
