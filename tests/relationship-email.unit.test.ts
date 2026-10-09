import { describe, expect, it } from "vitest"
import {
  DEFAULT_FRESH_SUBJECT, DEFAULT_RELATIONSHIP_MAILBOX,
  emailTouchMessage, freshMailbox, isOwnMailbox, replySubject, splitEmailTouch,
} from "@/lib/relationshipEmail"

describe("relationship email helpers", () => {
  it("collapses Re:/Fwd: chains into a single Re:", () => {
    expect(replySubject('Another great "Contractor Special" from the Kirsten Reilly Team')).toBe('Re: Another great "Contractor Special" from the Kirsten Reilly Team')
    expect(replySubject("Re: Fwd: Buying in the South Bay again")).toBe("Re: Buying in the South Bay again")
    expect(replySubject("RE: re: FW: hello")).toBe("Re: hello")
  })

  it("falls back when the thread has no subject", () => {
    expect(replySubject(null)).toBe(DEFAULT_FRESH_SUBJECT)
    expect(replySubject("Re: ")).toBe(DEFAULT_FRESH_SUBJECT)
    expect(replySubject("", "Hi Kirsten")).toBe("Hi Kirsten")
  })

  it("only treats LRG Workspace mailboxes as sendable", () => {
    expect(isOwnMailbox("info@lrghomes.com")).toBe(true)
    expect(isOwnMailbox("Ryan@LRGHomesBuys.com")).toBe(true)
    expect(isOwnMailbox("ryan.lrghomes@gmail.com")).toBe(false)
    expect(isOwnMailbox(null)).toBe(false)
  })

  it("fresh sends come from ryan@ unless an own-domain override is set", () => {
    expect(freshMailbox({})).toBe(DEFAULT_RELATIONSHIP_MAILBOX)
    expect(freshMailbox({ RELATIONSHIP_EMAIL_FROM: "info@lrghomes.com" })).toBe("info@lrghomes.com")
    expect(freshMailbox({ RELATIONSHIP_EMAIL_FROM: "someone@gmail.com" })).toBe(DEFAULT_RELATIONSHIP_MAILBOX)
  })

  it("round-trips the touch-log line (subject first, mirrors inbound)", () => {
    const line = emailTouchMessage("Re: Yerba Buena", "Thanks Kirsten — I'll swing by Saturday.\n\nRyan")
    expect(line.startsWith("Re: Yerba Buena\n")).toBe(true)
    expect(splitEmailTouch(line)).toEqual({ subject: "Re: Yerba Buena", body: "Thanks Kirsten — I'll swing by Saturday.\n\nRyan" })
    expect(splitEmailTouch("no newline")).toEqual({ subject: "no newline", body: "" })
  })
})
