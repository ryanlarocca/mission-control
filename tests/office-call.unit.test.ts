import { describe, it, expect, vi, beforeEach } from "vitest"

// Office line, 2026-11-11: a contact who rang and left no voicemail gets ONE
// "Missed call … No voicemail." alert (lib/office-inbound), and "call him"
// from Telegram shares the card's Call button implementation (lib/officeCall).

const { sent, state, fakeSb } = vi.hoisted(() => {
  const sent: { text: string; opts: unknown }[] = []
  // One relationship_touches row + one card, enough for the claim and the
  // relay-call flow. Filters are applied for real so the once-only claim is
  // actually exercised.
  const state = {
    touch: { id: "t1", relationship_id: "rel-1", action: "inbound", call_status: "voicemail" as string | null, transcript: null as string | null },
    card: { name: "Ashley Cao", category: "Investor", phone: "+14085551212", use_card_line: false } as Record<string, unknown> | null,
    inserted: [] as Record<string, unknown>[],
    deleted: 0,
    updates: [] as Record<string, unknown>[],
  }
  const fakeSb = () => ({
    from(table: string) {
      const filters: [string, string, unknown][] = []
      let patch: Record<string, unknown> | null = null
      let inserting: Record<string, unknown> | null = null
      let deleting = false
      const chain: Record<string, unknown> = {}
      const matches = () => filters.every(([op, col, v]) => {
        const row = (table === "relationship_touches" ? state.touch : state.card) as Record<string, unknown> | null
        if (!row) return false
        if (op === "eq") return row[col] === v
        if (op === "in") return (v as unknown[]).includes(row[col])
        if (op === "is") return row[col] === v
        return true
      })
      for (const op of ["eq", "in", "is"]) chain[op] = (col: string, v: unknown) => { filters.push([op, col, v]); return chain }
      chain.update = (p: Record<string, unknown>) => { patch = p; return chain }
      chain.insert = (p: Record<string, unknown>) => { inserting = p; return chain }
      chain.delete = () => { deleting = true; return chain }
      chain.select = () => chain
      const run = () => {
        if (deleting) { state.deleted += 1; return { data: null, error: null } }
        if (inserting) { state.inserted.push(inserting); return { data: { id: "touch-new" }, error: null } }
        if (patch) {
          state.updates.push(patch)
          if (table === "relationship_touches" && matches()) { Object.assign(state.touch, patch); return { data: [{ relationship_id: state.touch.relationship_id }], error: null } }
          return { data: [], error: null }
        }
        return { data: null, error: null }
      }
      chain.single = async () => run()
      chain.maybeSingle = async () => {
        if (table === "relationship_touches") return { data: { call_status: state.touch.call_status }, error: null }
        return { data: state.card, error: null }
      }
      chain.then = (res: (v: unknown) => unknown) => Promise.resolve(run()).then(res)
      return chain
    },
  })
  return { sent, state, fakeSb }
})

vi.mock("@/lib/leads", () => ({
  getLeadsClient: () => fakeSb(),
  sendTelegramAlert: async (text: string, opts: unknown) => { sent.push({ text, opts }); return true },
  OFFICE_NUMBERS: new Set(["+14084585442"]),
  isOwnedNumber: (n: string) => n === "+14084585442",
  getTwilioNumber: () => "+14084585442",
  CARD_LINE: "+14084585442",
  FORWARD_TO: "+14085006293",
}))
vi.mock("@/lib/relationships", () => ({ normalizeAltPhones: () => [], relationshipsByAnyPhone: async () => [], settleNewRelationship: async (_s: unknown, id: string) => id }))
vi.mock("@/lib/inboundFacts", () => ({ queueInboundNote: () => {} }))
vi.mock("@/lib/relationship-calls", () => ({ PROD_BASE: "https://example.test", relationshipCallerId: () => "+14085006293" }))
vi.mock("@/lib/card-line", () => ({ getCardLineFlag: async () => false }))
vi.mock("@/lib/dnc", () => ({ checkContactDnc: async () => ({ dnc: false }) }))

import {
  alertMissedOfficeCall,
  callerHungUpWhileRinging,
  isEmptyVoicemail,
  missedCallAlertText,
  missedClaimState,
  callIsOver,
} from "@/lib/office-inbound"
import { bridgeUrlFor, normalizeDialE164, pickDialNumber, startOfficeRelayCall } from "@/lib/officeCall"

beforeEach(() => {
  sent.length = 0
  state.touch = { id: "t1", relationship_id: "rel-1", action: "inbound", call_status: "voicemail", transcript: null }
  state.card = { name: "Ashley Cao", category: "Investor", phone: "+14085551212", use_card_line: false }
  state.inserted.length = 0
  state.updates.length = 0
  state.deleted = 0
})

describe("callerHungUpWhileRinging", () => {
  it("is true for a canceled dial or a parent that is already over", () => {
    expect(callerHungUpWhileRinging("canceled", "in-progress")).toBe(true)
    expect(callerHungUpWhileRinging("no-answer", "completed")).toBe(true)
  })
  it("is false when it rang out with the caller still on (voicemail follows) or was answered", () => {
    expect(callerHungUpWhileRinging("no-answer", "in-progress")).toBe(false)
    expect(callerHungUpWhileRinging("busy", "")).toBe(false)
    expect(callerHungUpWhileRinging("completed", "completed")).toBe(false)
  })
})

describe("isEmptyVoicemail", () => {
  it("no recording is empty; a recording under the floor is empty; a real one is not", () => {
    expect(isEmptyVoicemail({ hasRecording: false, durationSec: null, floorSec: 3 })).toBe(true)
    expect(isEmptyVoicemail({ hasRecording: true, durationSec: 0, floorSec: 3 })).toBe(true)
    expect(isEmptyVoicemail({ hasRecording: true, durationSec: 2, floorSec: 3 })).toBe(true)
    expect(isEmptyVoicemail({ hasRecording: true, durationSec: 3, floorSec: 3 })).toBe(false)
    expect(isEmptyVoicemail({ hasRecording: true, durationSec: 41, floorSec: 3 })).toBe(false)
  })
  it("an unknown duration with a recording is left to the transcriber", () => {
    expect(isEmptyVoicemail({ hasRecording: true, durationSec: null, floorSec: 3 })).toBe(false)
  })
})

describe("missedClaimState", () => {
  it("ringing and voicemail may alert; missed already did; answered never", () => {
    expect(missedClaimState("ringing")).toBe("claimable")
    expect(missedClaimState("voicemail")).toBe("claimable")
    expect(missedClaimState("missed")).toBe("already")
    expect(missedClaimState("completed")).toBe("ineligible")
    expect(missedClaimState("dialing")).toBe("ineligible")
    expect(missedClaimState(null)).toBe("ineligible")
  })
})

describe("callIsOver (greeting re-check)", () => {
  it("a caller still on the line is recording — not over; an ended call is; unknown never alerts", () => {
    expect(callIsOver("in-progress")).toBe(false)
    expect(callIsOver("ringing")).toBe(false)
    expect(callIsOver("completed")).toBe(true)
    expect(callIsOver("no-answer")).toBe(true)
    expect(callIsOver(null)).toBe(false)
    expect(callIsOver("")).toBe(false)
  })
})

describe("missedCallAlertText", () => {
  it("matches the spec", () => {
    expect(missedCallAlertText({ name: "Ashley Cao", category: "Investor", number: "+14083092868", placeholderName: false })).toBe(
      "📵 <b>Missed call</b> — office line — <b>Ashley Cao</b> (Investor) — (408) 309-2868\nNo voicemail."
    )
  })
  it("leaves out a missing category, escapes the name, and calls an unnamed number a new contact", () => {
    expect(missedCallAlertText({ name: "A&B <Realty>", category: null, number: "+14083092868", placeholderName: false })).toContain("<b>A&amp;B &lt;Realty&gt;</b> — (408)")
    expect(missedCallAlertText({ name: "(408) 309-2868", category: "Agent", number: "+14083092868", placeholderName: true })).toBe(
      "📵 <b>Missed call</b> — office line — <b>New contact</b> — (408) 309-2868\nNo voicemail."
    )
  })
})

describe("alertMissedOfficeCall", () => {
  it("alerts once with the person recorded, then stays quiet on a retry", async () => {
    const sb = fakeSb() as never
    expect(await alertMissedOfficeCall(sb, "t1", { callerPhone: "+14083092868" })).toBe("alerted")
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toContain("<b>Missed call</b> — office line — <b>Ashley Cao</b> (Investor) — (408) 309-2868")
    expect(sent[0].text).toContain("No voicemail.")
    expect(sent[0].opts).toEqual({ about: { kind: "relationship", relationshipId: "rel-1", phone: "+14083092868", line: "office" } })
    expect(state.touch.call_status).toBe("missed")
    // Twilio retries the callback (or the other callback fires): nothing more.
    expect(await alertMissedOfficeCall(sb, "t1", { callerPhone: "+14083092868" })).toBe("already")
    expect(sent).toHaveLength(1)
  })
  it("falls back to the card's number when the caller's is unknown", async () => {
    await alertMissedOfficeCall(fakeSb() as never, "t1")
    expect(sent[0].text).toContain("(408) 555-1212")
    expect((sent[0].opts as { about: { phone: string } }).about.phone).toBe("+14085551212")
  })
  it("never alerts for an answered call or one that has a transcript", async () => {
    state.touch.call_status = "completed"
    expect(await alertMissedOfficeCall(fakeSb() as never, "t1")).toBe("ineligible")
    state.touch.call_status = "voicemail"
    state.touch.transcript = "Hi it's Ashley"
    expect(await alertMissedOfficeCall(fakeSb() as never, "t1")).toBe("ineligible")
    expect(sent).toHaveLength(0)
  })
  it("applies the touch patch with the claim", async () => {
    await alertMissedOfficeCall(fakeSb() as never, "t1", { patch: { message: "📵 hung up", call_duration_sec: 7 } })
    expect(state.touch).toMatchObject({ call_status: "missed", message: "📵 hung up", call_duration_sec: 7 })
  })
})

describe("dial helpers", () => {
  it("normalizes numbers like the card route always did", () => {
    expect(normalizeDialE164("(408) 555-1212")).toBe("+14085551212")
    expect(normalizeDialE164("1 408 555 1212")).toBe("+14085551212")
    expect(normalizeDialE164("+14085551212")).toBe("+14085551212")
    expect(normalizeDialE164("555-1212")).toBeNull()
  })
  it("dials the number given, else the card's", () => {
    expect(pickDialNumber("(650) 910-4007", "+14085551212")).toBe("+16509104007")
    expect(pickDialNumber(null, "+14085551212")).toBe("+14085551212")
    expect(pickDialNumber("", "(408) 555-1212")).toBe("+14085551212")
    expect(pickDialNumber("garbage", "+14085551212")).toBeNull()
    expect(pickDialNumber(null, null)).toBeNull()
  })
  it("builds the bridge URL, card line only when asked", () => {
    expect(bridgeUrlFor("t1", "+14085551212", false)).toBe("https://example.test/api/crms/call/bridge?touchId=t1&to=%2B14085551212")
    expect(bridgeUrlFor("t1", "+14085551212", true)).toMatch(/&line=card$/)
  })
})

describe("startOfficeRelayCall", () => {
  beforeEach(() => {
    process.env.TWILIO_ACCOUNT_SID = "ACtest"
    process.env.TWILIO_AUTH_TOKEN = "tok"
  })
  it("rings Ryan, labels the card, and returns what the route needs", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sid: "CA123" }), { status: 201 }))
    vi.stubGlobal("fetch", fetchMock)
    const out = await startOfficeRelayCall({ relationshipId: "rel-1" })
    expect(out).toMatchObject({ ok: true, label: "Ashley Cao", touchId: "touch-new", callSid: "CA123" })
    expect(state.inserted[0]).toMatchObject({ relationship_id: "rel-1", modality: "call", action: "call", call_status: "dialing" })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }]
    const form = new URLSearchParams(init.body)
    expect(form.get("To")).toBe("+14085006293")
    expect(form.get("Url")).toContain("to=%2B14085551212") // the card's main phone
    vi.unstubAllGlobals()
  })
  it("dials the number given instead of the card's", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ sid: "CA9" }), { status: 201 })))
    const out = await startOfficeRelayCall({ relationshipId: "rel-1", phone: "(650) 910-4007" })
    expect(out.ok).toBe(true)
    vi.unstubAllGlobals()
  })
  it("refuses our own numbers and a card with no phone, without touching Twilio", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    expect(await startOfficeRelayCall({ relationshipId: "rel-1", phone: "+14084585442" })).toMatchObject({ ok: false, status: 400 })
    state.card = { name: "No Phone", phone: null }
    expect(await startOfficeRelayCall({ relationshipId: "rel-1" })).toMatchObject({ ok: false, status: 400, error: "no phone on this card — nothing to call" })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(state.inserted).toHaveLength(0)
    vi.unstubAllGlobals()
  })
  it("removes the touch when Twilio refuses the call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "bad" }), { status: 400 })))
    const out = await startOfficeRelayCall({ relationshipId: "rel-1" })
    expect(out).toMatchObject({ ok: false, error: "bad", status: 502 })
    expect(state.deleted).toBe(1)
    vi.unstubAllGlobals()
  })
})
