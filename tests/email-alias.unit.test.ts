import { describe, it, expect } from "vitest"
import { resolveMailbox, watchedMailboxes, addressesForMailbox, resolveRecipientCampaign, getMailboxForSource, EMAIL_CAMPAIGN_MAP } from "@/lib/leads"

// Alias-aware mailbox map (campaigns@ hub, 2026-10-12). The config file is the
// fixture: these assertions pin the invariants the route / reply paths rely on.
const HUB = "campaigns@lrghomes.com"
const h = (pairs: [string, string][]) => pairs.map(([name, value]) => ({ name, value }))

describe("email alias map", () => {
  it("resolves an alias to its real mailbox and a real mailbox to itself", () => {
    expect(resolveMailbox("RyanSVX@LRGHomes.com")).toBe(HUB)
    expect(resolveMailbox("ryansvy@lrghomes.com")).toBe(HUB)
    expect(resolveMailbox(HUB)).toBe(HUB)
    expect(resolveMailbox("ryan@lrghomesbuys.com")).toBe("ryan@lrghomesbuys.com")
    expect(resolveMailbox(null)).toBeNull()
  })

  it("never lists an alias as a watch target", () => {
    const boxes = watchedMailboxes()
    expect(boxes).toContain(HUB)
    for (const [addr, entry] of Object.entries(EMAIL_CAMPAIGN_MAP)) if (entry.mailbox) expect(boxes).not.toContain(addr)
    expect(new Set(boxes).size).toBe(boxes.length)
  })

  it("groups aliases under their mailbox", () => {
    const addrs = addressesForMailbox(HUB)
    expect(addrs).toEqual(expect.arrayContaining([HUB, "ryansvx@lrghomes.com", "ryansvy@lrghomes.com", "ryansva@lrghomes.com"]))
  })

  it("attributes by the address the mail was sent to, Delivered-To first", () => {
    const r = resolveRecipientCampaign(h([["To", "Ryan <ryansvx@lrghomes.com>"], ["Delivered-To", "ryansvy@lrghomes.com"]]), HUB)
    expect(r.address).toBe("ryansvy@lrghomes.com")
    const r2 = resolveRecipientCampaign(h([["To", "RyanSVA@LRGhomes.com, someone@else.com"]]), HUB)
    expect(r2.address).toBe("ryansva@lrghomes.com")
    expect(r2.campaign.source).toBe("Legacy DM")
  })

  it("falls back to the mailbox's own label when no alias is in the headers", () => {
    const r = resolveRecipientCampaign(h([["To", "undisclosed-recipients:;"]]), HUB)
    expect(r.address).toBe(HUB)
    expect(r.campaign.source).toBe("NOO-Q4-2026")
  })

  it("ignores addresses that belong to a different mailbox", () => {
    // ryan@lrghomesbuys.com is a real mailbox of its own; mail to it must not attribute from the hub
    const r = resolveRecipientCampaign(h([["To", "ryan@lrghomesbuys.com"]]), HUB)
    expect(r.address).toBe(HUB)
  })

  it("moved MFM addresses attribute to their original labels from the hub (2026-10-12 seat move)", () => {
    expect(resolveRecipientCampaign(h([["Delivered-To", "ryansvg@lrghomes.com"]]), HUB).campaign.source).toBe("MFM-A")
    expect(resolveRecipientCampaign(h([["Delivered-To", "ryansvj@lrghomes.com"]]), HUB).campaign.source).toBe("MFM-B")
    expect(resolveRecipientCampaign(h([["Delivered-To", "ryansvr@lrghomes.com"]]), HUB).campaign.source).toBe("AGENT-DRIP-2")
  })

  it("reverse lookup returns the real mailbox for an alias-backed source", () => {
    expect(getMailboxForSource("Legacy DM")).toBe(HUB)
    expect(getMailboxForSource("MFM-A")).toBe(HUB)
    expect(getMailboxForSource("AGENT-DRIP-BUYS")).toBe("ryan@lrghomesbuys.com")
  })
})
