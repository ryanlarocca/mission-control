import { describe, it, expect } from "vitest"
import { classifyVendorText, isOptOutConfirmation, isShortCode, isVendorMarketingText } from "@/lib/vendorMarketing"
import { isDncMessage } from "@/lib/leads"

// Vendor marketing texts to the lead-facing lines (2026-10-16): STOP back,
// own alert, never a lead. Detection must stay conservative — a real seller
// reply is never a false positive.

const THUMBTACK =
  "Pro Summit 2026 registration is live. See new tools, the pro panel, and more. Reply STOP to opt out. Register: https://thumbtack.app.link/e/SMS1"
// Thumbtack's reply to our STOP, seconds later (10/16 07:06) — became a
// drip-stamped lead on the first live replay.
const THUMBTACK_CONFIRM =
  "You have successfully been unsubscribed. You will not receive any more messages from this number. Reply START to resubscribe."

describe("isVendorMarketingText", () => {
  it("catches the Thumbtack blast that tripped the DNC matcher", () => {
    expect(isVendorMarketingText("+14154494283", THUMBTACK)).toBe(true)
    // …and the DNC matcher would indeed have fired on it, which is why the
    // vendor check runs first.
    expect(isDncMessage(THUMBTACK)).toBe(true)
  })

  it("catches common CTIA boilerplate shapes with a link", () => {
    expect(isVendorMarketingText("+18005551212", "Flash sale ends tonight! Shop now: www.acme.com/sale Txt STOP to end, HELP for help. Msg&data rates may apply")).toBe(true)
    expect(isVendorMarketingText("+18005551212", "Your appointment reminder: acme.co/abc123. To opt out reply STOP")).toBe(true)
    expect(isVendorMarketingText("+18005551212", "New listings near you https://bit.ly/x. Unsubscribe: reply STOP")).toBe(true)
  })

  it("recognises a vendor's opt-out confirmation in its own right (no STOP back)", () => {
    expect(isOptOutConfirmation(THUMBTACK_CONFIRM)).toBe(true)
    expect(classifyVendorText("+14154494283", THUMBTACK_CONFIRM)).toBe("optout_confirmation")
    expect(classifyVendorText("+14154494283", THUMBTACK)).toBe("marketing")
    expect(isOptOutConfirmation("You are now opted out. No further messages will be sent.")).toBe(true)
    expect(isOptOutConfirmation("You've been unsubscribed from Acme alerts. Reply START to opt back in.")).toBe(true)
    // Seller phrasing that borrows the words is not a confirmation.
    expect(isOptOutConfirmation("I want to be unsubscribed from your mail")).toBe(false)
    expect(isOptOutConfirmation("please stop, I don't want any more messages")).toBe(false)
    expect(classifyVendorText("+14085551234", "Yes I'm interested in selling 123 Main St")).toBe(null)
  })

  it("treats any short-code sender as marketing", () => {
    expect(isShortCode("22395")).toBe(true)
    expect(isShortCode("894546")).toBe(true)
    expect(isShortCode("+14154494283")).toBe(false)
    expect(isVendorMarketingText("22395", "Your code is 123456")).toBe(true)
  })

  it("never flags real seller texts", () => {
    expect(isVendorMarketingText("+14085551234", "STOP")).toBe(false)
    expect(isVendorMarketingText("+14085551234", "Please stop texting me")).toBe(false)
    expect(isVendorMarketingText("+14085551234", "Remove me from your list")).toBe(false)
    expect(isVendorMarketingText("+14085551234", "Yes I'm interested in selling 123 Main St, what would you offer?")).toBe(false)
    // A link alone is not marketing (sellers do paste Zillow links).
    expect(isVendorMarketingText("+14085551234", "Here's the listing https://www.zillow.com/homedetails/123 — what do you think?")).toBe(false)
    // Boilerplate alone without a link is not marketing either.
    expect(isVendorMarketingText("+14085551234", "reply stop if you don't want me to text you back lol")).toBe(false)
    expect(isVendorMarketingText("+14085551234", "")).toBe(false)
    expect(isVendorMarketingText("+14085551234", null)).toBe(false)
  })
})
