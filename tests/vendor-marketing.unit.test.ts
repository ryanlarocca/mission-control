import { describe, it, expect } from "vitest"
import { isShortCode, isVendorMarketingText } from "@/lib/vendorMarketing"
import { isDncMessage } from "@/lib/leads"

// Vendor marketing texts to the lead-facing lines (2026-10-16): STOP back,
// own alert, never a lead. Detection must stay conservative — a real seller
// reply is never a false positive.

const THUMBTACK =
  "Pro Summit 2026 registration is live. See new tools, the pro panel, and more. Reply STOP to opt out. Register: https://thumbtack.app.link/e/SMS1"

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
