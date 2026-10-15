import { describe, it, expect } from "vitest"
import {
  leadRowsToThread, mergeThread, formatThread, describeContact, speakerLabel, isFromThem,
  MAX_TEXT, MAX_CALL_TEXT, MAX_THREAD_CHARS, type ThreadItem,
} from "@/lib/reply/context"
import { herbRows, herbContext, buildHerbTranscript, FLOOR_SENTENCE, PROMISE_SENTENCE } from "./fixtures/reply-coach-herb"

// Coached-draft brief §A (2026-10-15): the call transcript must survive whole
// and be labelled as a two-voice call, not as Ryan speaking.

describe("reply context — Herb's thread", () => {
  it("fixture puts the floor and the promise past the old 4,000-char clip", () => {
    const t = buildHerbTranscript()
    expect(t.length).toBeGreaterThan(7000)
    expect(t.length).toBeLessThanOrEqual(8000)
    expect(t.indexOf(FLOOR_SENTENCE)).toBeGreaterThan(MAX_TEXT)
    expect(t.indexOf(PROMISE_SENTENCE)).toBeGreaterThan(t.indexOf(FLOOR_SENTENCE))
  })

  it("keeps the whole outbound call transcript, floor sentence included", () => {
    const thread = mergeThread(leadRowsToThread(herbRows()))
    const call = thread.find((t) => t.channel === "call")
    expect(call).toBeDefined()
    expect(call!.text.length).toBeGreaterThan(MAX_TEXT)
    expect(call!.text).toContain(FLOOR_SENTENCE)
    expect(call!.text).toContain(PROMISE_SENTENCE)
  })

  it("tags the call as both voices placed by Ryan, the voicemail as them", () => {
    const thread = mergeThread(leadRowsToThread(herbRows()))
    const [call, vm, sms] = thread
    expect(call.from).toBe("call")
    expect(call.direction).toBe("outbound")
    expect(vm.from).toBe("them")
    expect(vm.channel).toBe("voicemail")
    expect(sms.from).toBe("them")
    expect(isFromThem(call)).toBe(false)
    expect(isFromThem(vm)).toBe(true)
  })

  it("renders the right labels in formatThread", () => {
    const ctx = herbContext(mergeThread(leadRowsToThread(herbRows())))
    const out = formatThread(ctx, 16)
    expect(out).toContain("call transcript, both voices — Ryan placed this call:")
    expect(out).toContain("them (voicemail):")
    expect(out).toContain("them (sms): Yes")
    expect(out).toContain(FLOOR_SENTENCE)
    expect(out).toContain(PROMISE_SENTENCE)
    expect(out).not.toMatch(/\] ryan \(call\)/)
  })

  it("labels an answered inbound call as an inbound transcript", () => {
    const [row] = leadRowsToThread([{ created_at: "2026-10-01T00:00:00Z", lead_type: "call", twilio_number: "+16502043247", message: "Ryan: Hello?\nHerb: Hi, calling about the letter." }])
    expect(row.from).toBe("call")
    expect(row.direction).toBe("inbound")
    expect(speakerLabel(row)).toBe("inbound call transcript")
    expect(isFromThem(row)).toBe(true)
  })

  it("still clips texts and emails at MAX_TEXT", () => {
    const [row] = mergeThread(leadRowsToThread([{ created_at: "2026-10-01T00:00:00Z", lead_type: "email", twilio_number: "+1", message: "x".repeat(MAX_TEXT + 500) }]))
    expect(row.text.length).toBe(MAX_TEXT)
  })

  it("caps a call transcript at MAX_CALL_TEXT, not MAX_TEXT", () => {
    const [row] = mergeThread(leadRowsToThread([{ created_at: "2026-10-01T00:00:00Z", lead_type: "call", twilio_number: null, message: "y".repeat(MAX_CALL_TEXT + 500) }]))
    expect(row.text.length).toBe(MAX_CALL_TEXT)
  })

  it("drops the OLDEST items when the thread blows the budget, never the newest transcript", () => {
    const items: ThreadItem[] = []
    for (let i = 0; i < 6; i++) {
      items.push({ at: `2026-09-0${i + 1}T00:00:00Z`, from: "call", channel: "call", text: `old-${i} ` + "z".repeat(15000), direction: "outbound" })
    }
    items.push({ at: "2026-10-12T00:00:00Z", from: "call", channel: "call", text: buildHerbTranscript(), direction: "outbound" })
    items.push({ at: "2026-10-14T00:00:00Z", from: "them", channel: "sms", text: "Yes" })
    const out = mergeThread(items)
    const total = out.reduce((n, t) => n + t.text.length, 0)
    expect(total).toBeLessThanOrEqual(MAX_THREAD_CHARS)
    expect(out[0].text.startsWith("old-0")).toBe(false)
    expect(out.some((t) => t.text.includes(FLOOR_SENTENCE))).toBe(true)
    expect(out[out.length - 1].text).toBe("Yes")
  })
})

describe("describeContact — money facts on the card", () => {
  it("surfaces offer_amount, offer_verbalized_at and the full notes for a lead", () => {
    const ctx = herbContext(mergeThread(leadRowsToThread(herbRows())))
    const out = describeContact(ctx)
    expect(out).toContain("Offer on file (Ryan's last verbalized number to them): $1,100,000 on 2026-10-12")
    expect(out).toContain("Offer 1.1")
    expect(out).toContain("he is firm on 1.6 but listened")
  })
  it("omits the offer line when nothing is on file", () => {
    const ctx = { ...herbContext([]), offer_amount: null, offer_verbalized_at: null, notes: null }
    expect(describeContact(ctx)).not.toContain("Offer on file")
    expect(describeContact(ctx)).not.toContain("Ryan's notes")
  })
})
