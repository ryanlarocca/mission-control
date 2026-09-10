import { describe, it, expect } from "vitest"
import { isBounceEmail, parseBounce } from "@/lib/emailBounce"

// Bill Koester, 2026-05-16: the send to kester@prodigy.net bounced and nobody
// was told. These pin the DSN shapes we parse so a bounce always yields a
// recipient to look up and a reason Ryan can read in Telegram.

const GMAIL_BODY = `Address not found

Your message wasn't delivered to kester@prodigy.net because the address couldn't be found, or is unable to receive mail.

The response from the remote server was:

552 1 Requested mail action aborted, mailbox not found


----- Original message -----
`

describe("isBounceEmail", () => {
  it("recognises mailer-daemon by sender", () => {
    expect(isBounceEmail("mailer-daemon@googlemail.com", "2359 Galloway")).toBe(true)
  })
  it("recognises a DSN by subject when the sender was rewritten", () => {
    expect(isBounceEmail("fwd@example.com", "Delivery Status Notification (Failure)")).toBe(true)
  })
  it("leaves a normal reply alone", () => {
    expect(isBounceEmail("vslater99@gmail.com", "Quote on property")).toBe(false)
  })
})

describe("parseBounce", () => {
  it("reads Gmail's wasn't-delivered body", () => {
    const r = parseBounce({ body: GMAIL_BODY })
    expect(r.recipient).toBe("kester@prodigy.net")
    expect(r.reason).toContain("couldn't be found")
    expect(r.reason).toContain("552")
  })
  it("prefers the X-Failed-Recipients header when present", () => {
    const r = parseBounce({ body: "unrelated text", failedRecipientsHeader: "Someone@Example.com" })
    expect(r.recipient).toBe("someone@example.com")
  })
  it("reads an RFC 3464 Final-Recipient block", () => {
    const body = "Final-Recipient: rfc822; bob@old-isp.net\nAction: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1 User unknown"
    const r = parseBounce({ body })
    expect(r.recipient).toBe("bob@old-isp.net")
    expect(r.reason).toContain("550")
  })
  it("returns nulls rather than throwing on an unrecognised body", () => {
    expect(parseBounce({ body: "" })).toEqual({ recipient: null, reason: null })
  })
})
