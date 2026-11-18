import { describe, it, expect } from "vitest"
import { createRequire } from "node:module"

// Ryan, 2026-11-17: a real person who isn't selling (Matt from a meetup) goes to
// Relationships — never "dead". Made-up people only.
const require = createRequire(import.meta.url)
const { facts, decide } = require("../scripts/judge.js")

const TODAY = "2026-11-17"
const rows = [{ id: "a", created_at: "2026-11-17T02:13:00Z", lead_type: "sms", twilio_number: "+16505550100", message: "Hi Ryan! Pat from the meetup. Would like to continue the conversation!", notes: null }]
const contact = { state: "contact", date: null, owed: null, reason: "Met Ryan at a meetup; not selling.", contactName: "Pat Example", contactCategory: "Investor" }

describe("judge: a real contact who isn't a seller", () => {
  it("is 'contact' with no follow-up date, carrying the name + category", () => {
    expect(decide(contact, facts(rows), TODAY)).toMatchObject({ state: "contact", date: null, contactName: "Pat Example", contactCategory: "Investor" })
  })
  it("stays 'contact' even if Ryan owes them something", () => {
    expect(decide({ ...contact, owed: "call Pat back" }, facts(rows), TODAY).state).toBe("contact")
  })
})
