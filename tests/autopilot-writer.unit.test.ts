import { describe, it, expect } from "vitest"
import { createRequire } from "node:module"

// Autopilot writer (2026-11-13): Opus edits each slot's fixed text to fit the
// person's card; the guardrails are enforced in code. Made-up people only.
const require = createRequire(import.meta.url)
const writer = require("../scripts/autopilot-writer.js")
const autopilot = require("../scripts/autopilot.js")

const BASE = "Pat, checking back on 12 Elm St. Still yours? If you ever want a cash number, just reply here. – Ryan LaRocca"
const LEAD = { name: "Pat Example", caller_phone: "+15550100", property_address: "12 Elm St, Springfield, CA" }

// A fake Anthropic client that answers with the given replies in order
// (a thinking block first, like the real model), or throws an Error reply.
function fakeAnthropic(...replies: (string | Error)[]) {
  const calls: any[] = []
  return {
    calls,
    messages: {
      create: async (params: any) => {
        calls.push(JSON.parse(JSON.stringify(params)))
        const r = replies.shift()
        if (r instanceof Error) throw r
        return { content: [{ type: "thinking", thinking: "{not the answer}" }, { type: "text", text: r }] }
      },
    },
  }
}
const reply = (text: string | null, changed = "nothing") => JSON.stringify({ text, changed })
const write = (anthropic: any) => writer.writeTouch({
  anthropic, lead: LEAD, rows: [], personal: [], verdict: null, touch: 2, base: BASE, today: new Date("2026-12-02T20:00:00Z"),
})

describe("nextDue", () => {
  const lead = { drip_touch_number: 1, last_drip_sent_at: "2026-10-01T20:00:00.000Z", autopilot_since: "2026-10-01T20:00:00.000Z" }

  it("runs on the schedule without autopilot_next_at (#2 = 30 days after #1)", () => {
    const nd = autopilot.nextDue(lead)
    expect(nd.touch).toBe(2)
    expect(nd.due.toISOString()).toBe("2026-10-31T20:00:00.000Z")
  })
  it("autopilot_next_at is the exact due time", () => {
    const nd = autopilot.nextDue({ ...lead, autopilot_next_at: "2026-11-20T18:00:00.000Z" })
    expect(nd.touch).toBe(2)
    expect(nd.due.toISOString()).toBe("2026-11-20T18:00:00.000Z")
  })
  it("a later hold still wins over autopilot_next_at", () => {
    const nd = autopilot.nextDue({ ...lead, autopilot_next_at: "2026-11-20T18:00:00.000Z", autopilot_hold_until: "2026-12-01T20:00:00.000Z" })
    expect(nd.due.toISOString()).toBe("2026-12-01T20:00:00.000Z")
  })
  it("an earlier hold doesn't pull autopilot_next_at forward", () => {
    const nd = autopilot.nextDue({ ...lead, autopilot_next_at: "2026-11-20T18:00:00.000Z", autopilot_hold_until: "2026-11-01T20:00:00.000Z" })
    expect(nd.due.toISOString()).toBe("2026-11-20T18:00:00.000Z")
  })
})

describe("checkText", () => {
  it("passes a clean edit", () => {
    expect(writer.checkText("Pat, checking back on 12 Elm St, the duplex you called me about. If you ever want a cash number, just reply here. – Ryan LaRocca", { base: BASE, lead: LEAD })).toEqual([])
  })
  it("flags Ryan named twice, but not an owner who shares the name", () => {
    const twice = "Pat, it's Ryan LaRocca, checking back on 12 Elm St. – Ryan LaRocca"
    expect(writer.checkText(twice, { base: BASE, lead: LEAD })).toContain("names Ryan more than once")
    expect(writer.checkText("Ryan, checking back on 12 Elm St, the duplex you called me about. – Ryan LaRocca", { base: BASE, lead: { ...LEAD, name: "Ryan Example" } })).toEqual([])
  })
  it("doesn't take street numbers for a phone number", () => {
    const lead = { ...LEAD, property_address: "1402-1404 Elm Dr, Springfield, CA" }
    expect(writer.checkText("Checking back on 1402-1404 Elm Dr, the duplex you texted me about. – Ryan LaRocca", { base: "Checking back on 1402-1404 Elm Dr. Still yours? – Ryan LaRocca", lead })).toEqual([])
    const lead2 = { ...LEAD, property_address: "210/212 Oak St" }
    expect(writer.checkText("Pat, checking back on 210/212 Oak St in Springfield. – Ryan LaRocca", { base: "Pat, checking back on 210/212 Oak St. – Ryan LaRocca", lead: lead2 })).toEqual([])
    // "205 1550" is a phone shape; it's fine only because the address has those digits.
    const text = "Pat, checking back on Apt 205 1550 Elm St. – Ryan LaRocca"
    expect(writer.checkText(text, { base: "Checking back on your property. – Ryan LaRocca", lead: { ...LEAD, property_address: "Apt 205 1550 Elm St" } })).toEqual([])
    expect(writer.checkText(text, { base: "Checking back on your property. – Ryan LaRocca", lead: { ...LEAD, property_address: null } })).toContain("has a phone number")
  })
  it("flags a real phone number", () => {
    for (const t of ["Text me at 408-555-0142 any time. – Ryan", "Call (408) 555-0142. – Ryan", "Reach me on +14085550142", "My cell is 555-0142."]) {
      expect(writer.checkText(t, { base: BASE, lead: LEAD })).toContain("has a phone number")
    }
  })
  it("allows a dollar amount that's in the scheduled text, flags a new one", () => {
    const base = "Quick one: last time we talked you mentioned $3M for 12 Elm St. Is that still about where you're at? – Ryan LaRocca"
    expect(writer.checkText("Pat, last time we talked you mentioned $3M for 12 Elm St. Is that still about where you're at? – Ryan LaRocca", { base, lead: LEAD })).toEqual([])
    const p = writer.checkText("Pat, you mentioned $3M and I offered $2.5M for 12 Elm St. – Ryan LaRocca", { base, lead: LEAD })
    expect(p.join(" ")).toMatch(/dollar amount.*\$2\.5M/)
    expect(writer.checkText("Pat, I could do 1.2 million on 12 Elm St. – Ryan LaRocca", { base: BASE, lead: LEAD }).join(" ")).toMatch(/dollar amount/)
    expect(writer.checkText("Pat, a 5% cap still works for me. – Ryan LaRocca", { base: BASE, lead: LEAD }).join(" ")).toMatch(/percentage/)
  })
  it("flags a banned phrase, case-insensitive", () => {
    expect(writer.checkText("No pressure, Pat. Still yours? – Ryan LaRocca", { base: BASE, lead: LEAD }).join(" ")).toMatch(/banned phrase: "no pressure"/)
    expect(writer.checkText("Glad we talked, Pat. – Ryan LaRocca", { base: BASE, lead: LEAD }).join(" ")).toMatch(/"glad"/)
    expect(writer.checkText("Hope you’re well, Pat. – Ryan LaRocca", { base: BASE, lead: LEAD }).join(" ")).toMatch(/"hope you're well"/)
  })
  it("flags an exclamation point, an emoji, a link and length", () => {
    expect(writer.checkText("Still yours, Pat! – Ryan", { base: BASE, lead: LEAD })).toContain("has an exclamation point")
    expect(writer.checkText("Still yours, Pat? 🏠 – Ryan", { base: BASE, lead: LEAD })).toContain("has an emoji")
    expect(writer.checkText("See lrghomes.com – Ryan", { base: BASE, lead: LEAD })).toContain("has a link")
    expect(writer.checkText("a".repeat(321), { base: BASE, lead: LEAD })[0]).toMatch(/too long \(321/)
    expect(writer.checkText("   ", { base: BASE, lead: LEAD })).toEqual(["empty text"])
  })
})

describe("buildCard", () => {
  const rows = [
    { created_at: "2026-01-05T20:00:00.000Z", lead_type: "call", twilio_number: "+15550199", message: "Caller asked what Ryan would pay for the duplex.", notes: "Seemed motivated.\n[Skip trace 2026-01-06] phones: +15550123, +15550124" },
    { created_at: "2026-03-05T20:00:00.000Z", lead_type: "drip_imessage", twilio_number: null, message: BASE, notes: "[autopilot #1 · SMabc123]" },
    // Bulk-imported legacy row: created_at is the import moment, not the contact.
    { created_at: "2026-04-30T04:01:00.000Z", lead_type: "voicemail", twilio_number: "+15550199", message: "Wants to sell after the tenant moves out.", notes: "[historic-sellers import 2026-04-30]" },
    { created_at: "2026-06-01T20:00:00.000Z", lead_type: "call", twilio_number: "+15550199", message: "", ai_summary: "From your notes: talked about the roof" },
    { created_at: "2026-07-01T20:00:00.000Z", lead_type: "sms", twilio_number: "+15550199", message: "", offer_amount: 850000, offer_verbalized_at: "2026-07-01T20:00:00.000Z", notes: "#callblock 2026-07-01 left vm" },
  ]
  const personal = [{ created_at: "2026-02-10T20:00:00.000Z", inbound: true, text: "Still thinking it over." }]
  const card = writer.buildCard({ lead: LEAD, rows, personal, verdict: { state: "none", reason: "On autopilot, no reply yet." } })

  it("renders import rows and 'From your notes' rows as undated", () => {
    expect(card).toContain("[date not recorded] Earlier contact\n  Wants to sell after the tenant moves out.")
    expect(card).toContain("[date not recorded] Earlier contact\n  (summary) From your notes: talked about the roof")
    expect(card).not.toMatch(/Apr (29|30), 2026/)
    expect(card).not.toContain("Jun 1, 2026")
  })
  it("strips the skip-trace block and the system tags from Ryan's notes", () => {
    expect(card).toContain("Ryan's own notes:\nSeemed motivated.")
    expect(card).not.toContain("Skip trace")
    expect(card).not.toContain("+15550123")
    expect(card).not.toContain("[autopilot")
    expect(card).not.toContain("historic-sellers import")
    expect(card).not.toContain("#callblock")
  })
  it("merges personal-phone texts into the history in time order", () => {
    const call = card.indexOf("[Jan 5, 2026] They called")
    const text = card.indexOf("[Feb 10, 2026] They texted Ryan's personal phone\n  Still thinking it over.")
    const drip = card.indexOf("[Mar 5, 2026] Automated check-in text sent as Ryan")
    expect(call).toBeGreaterThan(-1)
    expect(text).toBeGreaterThan(call)
    expect(drip).toBeGreaterThan(text)
  })
  it("shows the offer and the judge's verdict", () => {
    expect(card).toContain("Offer Ryan made: $850,000 on Jul 1, 2026")
    expect(card).toContain("Where it stands (the judge): none — On autopilot, no reply yet.")
  })
})

describe("writeTouch", () => {
  it("unchanged text → send, not edited, no checks", async () => {
    const a = fakeAnthropic(reply(BASE))
    expect(await write(a)).toEqual({ action: "send", text: BASE, changed: "nothing", edited: false })
    expect(a.calls).toHaveLength(1)
    const p = a.calls[0]
    expect(p.model).toBe("claude-opus-5-5")
    expect(p.max_tokens).toBe(6000)
    expect(p.__tag).toBe("[autopilot/write]")
    expect(p.temperature).toBeUndefined()
    expect(p.top_p).toBeUndefined()
    expect(p.system).toBe(writer.SYSTEM_PROMPT)
    expect(p.messages[0].content).toMatch(/^Today is Wednesday, December 2, 2026\./)
    expect(p.messages[0].content).toContain(`SCHEDULED TEXT (Ryan's approved wording):\n${BASE}`)
    expect(p.messages[0].content).toContain("THE CARD:\nName on the card: Pat Example")
  })
  it("a clean edit → send, edited", async () => {
    const text = "Pat, checking back on 12 Elm St, the duplex you called me about. If you ever want a cash number, just reply here. – Ryan LaRocca"
    const r = await write(fakeAnthropic(reply(text, "anchored in their call")))
    expect(r).toEqual({ action: "send", text, changed: "anchored in their call", edited: true })
  })
  it("null → hold with the reason", async () => {
    expect(await write(fakeAnthropic(reply(null, "they asked not to be contacted")))).toEqual({ action: "hold", reason: "they asked not to be contacted" })
  })
  it("breaks a rule, fixed on the retry → send", async () => {
    const fixed = "Pat, checking back on 12 Elm St. If you ever want a cash number, just reply here. – Ryan LaRocca"
    const a = fakeAnthropic(reply("Pat, no pressure! Checking back on 12 Elm St. – Ryan LaRocca", "x"), reply(fixed, "took out the banned phrase"))
    const r = await write(a)
    expect(r).toEqual({ action: "send", text: fixed, changed: "took out the banned phrase", edited: true })
    expect(a.calls).toHaveLength(2)
    const retry = a.calls[1].messages
    expect(retry).toHaveLength(3)
    expect(retry[1].role).toBe("assistant")
    expect(retry[2].content).toMatch(/exclamation point/)
    expect(retry[2].content).toMatch(/"no pressure"/)
  })
  it("breaks a rule twice → blocked", async () => {
    const bad = "Pat, call me at 408-555-0142 about 12 Elm St. – Ryan LaRocca"
    const r = await write(fakeAnthropic(reply(bad), reply(bad)))
    expect(r).toEqual({ action: "blocked", text: bad, problems: ["has a phone number"] })
  })
  it("garbage output throws", async () => {
    await expect(write(fakeAnthropic("I'd rather not."))).rejects.toThrow(/no JSON/)
    await expect(write(fakeAnthropic("{text: oops}"))).rejects.toThrow()
    await expect(write(fakeAnthropic(new Error("overloaded")))).rejects.toThrow("overloaded")
  })
})

describe("history-row note", () => {
  it("the edited tag can't break the [autopilot #N · … · SMsid] matchers", () => {
    const notes = `[autopilot #2 · SMabc123]${autopilot.editedTag("dropped [Still yours?] · added the call")}`
    expect(notes).toMatch(/^\[autopilot #\d/)
    expect((notes.match(/\[autopilot #\d.*· (SM\w+)\]/) || [])[1]).toBe("SMabc123")
    expect((notes.match(/· (SM\w+)\]/) || [])[1]).toBe("SMabc123")
  })
})
