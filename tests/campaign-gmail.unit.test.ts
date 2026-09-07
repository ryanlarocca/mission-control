import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
// Plain ESM modules loaded directly (see tests/campaign-senders.unit.test.ts).
import * as gmailModule from "../scripts/campaign-gmail.mjs"
import * as sendersModule from "../scripts/campaign-senders.mjs"
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { gmailClientFor, isTenantMailbox, TENANT_DOMAINS } = gmailModule as unknown as Record<string, any>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { loadSenderConfig } = sendersModule as unknown as Record<string, any>

// Rebuild item 4 (2026-09-06): the consumer-Gmail sender is gone. Nothing may
// authenticate as, or fall back to, a mailbox outside the Workspace tenant.
describe("retired Gmail sender is unreachable", () => {
  it("only tenant domains are impersonable", () => {
    expect(TENANT_DOMAINS).toEqual(["lrghomes.com", "lrghomesbuys.com", "lrghomesoffers.com"])
    expect(isTenantMailbox("ryan@lrghomesbuys.com")).toBe(true)
    expect(isTenantMailbox("Info@LRGHomes.com ")).toBe(true)
    expect(isTenantMailbox("ryan.lrghomes@gmail.com")).toBe(false)
    expect(isTenantMailbox("ryan@lrghomes.com.evil.example")).toBe(false)
    expect(isTenantMailbox("")).toBe(false)
  })

  it("gmailClientFor refuses a non-tenant mailbox before touching any credential", async () => {
    const saved = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = "{not json"
    try {
      await expect(gmailClientFor("ryan.lrghomes@gmail.com")).rejects.toThrow(/not on the lrghomes Workspace tenant/)
    } finally {
      if (saved === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY
      else process.env.GOOGLE_SERVICE_ACCOUNT_KEY = saved
    }
  })

  it("an empty sender config never falls back to CAMPAIGN_SEND_AS", () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-senders-"))
    const configPath = path.join(dir, "campaign-senders.json")
    try {
      fs.writeFileSync(configPath, JSON.stringify({ senders: {} }))
      const cfg = loadSenderConfig({ env: { CAMPAIGN_SEND_AS: "ryan.lrghomes@gmail.com" }, configPath })
      expect(cfg.senders).toEqual([])
      expect(cfg.workhorse).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("the checked-in sender config has no gmail.com address", () => {
    const cfg = loadSenderConfig({ env: {} })
    for (const s of cfg.all) expect(isTenantMailbox(s.email)).toBe(true)
    const campaigns = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config", "email-campaigns.json"), "utf-8"))
    for (const mailbox of Object.keys(campaigns)) expect(isTenantMailbox(mailbox)).toBe(true)
  })
})
