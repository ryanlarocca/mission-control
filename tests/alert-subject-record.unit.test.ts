import { describe, it, expect, vi, beforeEach } from "vitest"

// An alert sent with `about` records its message id → person, on the HTML
// send and on the plain-text retry (lib/campaignAlerts → lib/alertSubject).
const { remembered } = vi.hoisted(() => ({ remembered: [] as unknown[][] }))
vi.mock("@/lib/alertSubject", () => ({
  messageIdOf: (j: { result?: { message_id?: number } } | null) => j?.result?.message_id ?? null,
  rememberAlertSubject: async (...a: unknown[]) => { remembered.push(a) },
}))

import { sendCampaignAlert } from "@/lib/campaignAlerts"

const sb = { from: () => ({ insert: async () => ({ error: null }) }) } as unknown as Parameters<typeof sendCampaignAlert>[0]
const about = { kind: "relationship" as const, relationshipId: "rel-1", phone: "+16506900515", line: "agents" as const }

beforeEach(() => {
  remembered.length = 0
  process.env.CAMPAIGN_BOT_TOKEN = "t"
  process.env.TELEGRAM_CHAT_ID = "1"
})

describe("sendCampaignAlert about", () => {
  it("records the subject against the posted message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 777 } }), { status: 200 })))
    expect(await sendCampaignAlert(sb, "💬 <b>Agents line text</b>", { about })).toBe(777)
    expect(remembered).toEqual([[777, about]])
  })
  it("records it on the plain-text retry too", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response("Bad Request: can't parse entities", { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 778 } }), { status: 200 }))
    vi.stubGlobal("fetch", f)
    await sendCampaignAlert(sb, "<b>broken", { about })
    expect(remembered).toEqual([[778, about]])
  })
})
