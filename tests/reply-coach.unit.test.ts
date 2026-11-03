import { describe, it, expect } from "vitest"
import { buildCoachPrompt, coachChannelRules, COACH_SYSTEM, AUTO_SYSTEM } from "@/lib/reply/coach"
import { coachNoteLine, appendNote } from "@/lib/reply/facts"
import { channelRules } from "@/lib/reply/draft"
import { leadRowsToThread, mergeThread } from "@/lib/reply/context"
import type { Plan } from "@/lib/reply/plan"
import { herbRows, herbContext, FLOOR_SENTENCE, PROMISE_SENTENCE } from "./fixtures/reply-coach-herb"

// Coached-draft brief §C + §G: the prompt Opus sees must carry the whole
// call (floor + promise), the card's money facts ("Offer 1.1"), and the
// gist, with the text ceiling lifted and email rules unchanged.

const GIST = "I'm at 950, renovated comps 1.2 to 1.3, he's at 1.6, keep the door open"
const plan: Plan = { moment: "offer_requested", temperature: "warm", next_action: "schedule_call", reason: "He asked for a number and Ryan promised to text one", source: "ai" }

function ctx() {
  return herbContext(mergeThread(leadRowsToThread(herbRows())))
}

describe("coach prompt assembly — Herb", () => {
  const prompt = buildCoachPrompt({ ctx: ctx(), plan, channel: "sms", gist: GIST, turns: [], principles: null, exemplarText: "(none yet)", today: "2026-10-15" })

  it("carries the whole call: the $1.6M floor and the promised text", () => {
    expect(prompt).toContain(FLOOR_SENTENCE)
    expect(prompt).toContain(PROMISE_SENTENCE)
    expect(prompt).toContain("call transcript, both voices — Ryan placed this call:")
    expect(prompt).toContain("them (voicemail):")
    expect(prompt).toContain("them (sms): Yes")
  })

  it("carries the card's money facts and the Offer 1.1 history line", () => {
    expect(prompt).toContain("$1,100,000 on 2026-10-12")
    expect(prompt).toContain("Offer 1.1")
  })

  it("carries the gist as authoritative and asks for a read + body", () => {
    expect(prompt).toContain("RYAN'S GIST (dictated; authoritative on numbers, decisions and intent; rough speech — apply the meaning, never quote it)")
    expect(prompt).toContain(`"${GIST}"`)
    expect(prompt).toMatch(/"read": "\.\.\.", "subject": null, "body": "\.\.\."/)
    expect(prompt).toContain("If the gist conflicts with the record, say so plainly here and still draft to the gist.")
    expect(prompt).not.toContain("THE DRAFTS SO FAR")
  })

  it("lifts the three-sentence ceiling for a coached text but keeps email rules", () => {
    expect(coachChannelRules("sms")).not.toContain("One to three sentences")
    expect(coachChannelRules("sms")).toContain("three-sentence ceiling does not apply")
    expect(coachChannelRules("sms")).toContain("No sign-off")
    expect(coachChannelRules("email")).toBe(channelRules("email"))
    expect(COACH_SYSTEM).toContain("COACH MODE")
    expect(COACH_SYSTEM).toContain("never a bracketed placeholder for something he said")
  })

  it("renders refinement turns with the original gist first and the latest follow-up last", () => {
    const turns = [
      { gist: GIST, body: "Hi Herb, it's Ryan. I ran the numbers... about $950K... no pressure at all." },
      { gist: "shorter", body: "Hi Herb, Ryan here. I'm at about $950K, all cash, you pick the date. No pressure." },
    ]
    const p = buildCoachPrompt({ ctx: ctx(), plan, channel: "sms", gist: "make it 925", turns, principles: null, exemplarText: "(none yet)", today: "2026-10-15" })
    expect(p).toContain(`RYAN'S GIST (dictated; authoritative on numbers, decisions and intent; rough speech — apply the meaning, never quote it)\n"${GIST}"`)
    expect(p).toContain("THE DRAFTS SO FAR IN THIS COACHING SESSION")
    expect(p.indexOf("Draft 1 (from the gist above):")).toBeLessThan(p.indexOf("Draft 2:"))
    expect(p).toContain(`Ryan's follow-up: "shorter"`)
    expect(p).toContain(`Ryan's follow-up: "make it 925"`)
    expect(p.lastIndexOf(`Ryan's follow-up: "make it 925"`)).toBeGreaterThan(p.indexOf(`Ryan's follow-up: "shorter"`))
    expect(p).toContain("The original gist still governs the numbers and the intent unless a follow-up changes them.")
  })

  it("writes the dated facts line the brief shows, appended under existing notes", () => {
    const line = coachNoteLine("2026-10-15", "At $950K; renovated comps $1.2–1.3M; he is at $1.6M.")
    expect(line).toBe("[Coach 2026-10-15] At $950K; renovated comps $1.2–1.3M; he is at $1.6M.")
    expect(appendNote("Offer 1.1", line)).toBe(`Offer 1.1\n${line}`)
    expect(appendNote(null, line)).toBe(line)
  })

  it("asks for an email subject on the email channel", () => {
    const p = buildCoachPrompt({ ctx: ctx(), plan, channel: "email", gist: GIST, turns: [], principles: null, exemplarText: "(none yet)", today: "2026-10-15" })
    expect(p).toContain('"subject": "..."')
    expect(p).toContain("Reply channel: EMAIL")
  })
})

// Auto = the coach writer with no gist (2026-11-03). "Not right" notes stack
// as turns so an earlier fix survives the next redraft (Arthur, 2026-11-02:
// the intro fix was lost when he asked for a new second part).
describe("auto prompt assembly — the coach writer with no gist", () => {
  it("drafts from the record with no gist block and the normal text ceiling", () => {
    const p = buildCoachPrompt({ ctx: ctx(), plan, channel: "sms", gist: "", turns: [], principles: null, exemplarText: "(none yet)", today: "2026-11-03" })
    expect(p).toContain("NO GIST — Ryan has not said what he wants to say.")
    expect(p).not.toContain("RYAN'S GIST")
    expect(p).toContain(FLOOR_SENTENCE)
    expect(p).toContain("One to three sentences")
    expect(p).not.toContain("THE DRAFTS SO FAR")
    expect(p).toMatch(/"read": "\.\.\.", "subject": null, "body": "\.\.\."/)
    expect(AUTO_SYSTEM).toContain("AUTO MODE")
    expect(AUTO_SYSTEM).toContain("Every note he gave still stands")
  })

  it("keeps every Not right note in order, the latest last", () => {
    const turns = [
      { gist: "", body: "Hi Arthur, got your message about the fourplex." },
      { gist: "the dates are years old, don't act like he just called", body: "Hi Arthur, I sent you a letter a while back about the fourplex." },
    ]
    const p = buildCoachPrompt({ ctx: ctx(), plan, channel: "sms", gist: "rework the second part, ask if he still owns it", turns, principles: null, exemplarText: "(none yet)", today: "2026-11-03" })
    expect(p).toContain("NO GIST")
    expect(p).toContain("WHAT RYAN SAID WAS OFF AFTER EACH")
    expect(p).not.toContain("(from the gist above)")
    const first = p.indexOf(`Ryan's note: "the dates are years old`)
    const latest = p.indexOf(`Ryan's note: "rework the second part`)
    expect(first).toBeGreaterThan(-1)
    expect(latest).toBeGreaterThan(first)
    expect(p).toContain("a problem he already flagged must not come back")
  })

  it("a coached root keeps coach semantics on a later Not right", () => {
    const turns = [{ gist: GIST, body: "Hi Herb, I'm at about $950K." }]
    const p = buildCoachPrompt({ ctx: ctx(), plan, channel: "sms", gist: "warmer", turns, principles: null, exemplarText: "(none yet)", today: "2026-11-03" })
    expect(p).toContain(`"${GIST}"`)
    expect(p).not.toContain("NO GIST")
  })

  it("carries lead notes and the drip touch brief when given", () => {
    const p = buildCoachPrompt({ ctx: ctx(), plan, channel: "sms", gist: "", turns: [], principles: null, exemplarText: "(none yet)", today: "2026-11-03", notes: "tenant in unit B", touchBrief: "ANGLE — terms: lead with the concrete offer" })
    expect(p).toContain("RYAN'S NOTES ON THIS CONTACT")
    expect(p).toContain("tenant in unit B")
    expect(p).toContain("DRIP TOUCH BRIEF")
    expect(p).toContain("ANGLE — terms")
  })
})
