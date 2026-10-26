import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

// Card # toggle on Relationships contacts
// (briefs/BRIEF_relationships_card_line_2026-10-26.md): bridge caller ID,
// strict Twilio sends, the merged business-line thread, and Telegram replies
// to office-line text alerts.

const CARD = "+14084585442"
const INFO = "+14084930632"
const DEFAULT_LINE = "+16502043247"

// ── A small fake of the PostgREST builder chain ─────────────────────────────
// Every chain records its calls; awaiting it asks `answer(table, ops)` for the
// result. Inserts / updates are captured for the assertions.
type Op = { m: string; args: unknown[] }
type Answer = (table: string, ops: Op[]) => { data: unknown; error: unknown }
const fakes = vi.hoisted(() => ({
  sb: null as unknown,
  sendLeadSms: null as unknown,
  sendTwilioSms: null as unknown,
}))

function fakeSb(answer: Answer) {
  const writes: { table: string; kind: "insert" | "update"; row: Record<string, unknown>; ops: Op[] }[] = []
  const from = (table: string) => {
    const ops: Op[] = []
    const chain: Record<string, unknown> = {}
    for (const m of ["select", "or", "order", "limit", "eq", "in", "not", "is", "like"]) {
      chain[m] = (...args: unknown[]) => { ops.push({ m, args }); return chain }
    }
    chain.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
      try { resolve(answer(table, ops)) } catch (e) { reject(e) }
    }
    chain.maybeSingle = async () => answer(table, ops)
    chain.insert = (row: Record<string, unknown>) => {
      writes.push({ table, kind: "insert", row, ops })
      return Promise.resolve({ data: null, error: null })
    }
    chain.update = (row: Record<string, unknown>) => {
      writes.push({ table, kind: "update", row, ops })
      return chain
    }
    return chain
  }
  return { sb: { from } as never, writes }
}

vi.mock("@/lib/leads", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/leads")>()
  return {
    ...orig,
    getLeadsClient: () => fakes.sb,
    sendLeadSms: (...a: unknown[]) => (fakes.sendLeadSms as (...a: unknown[]) => unknown)(...a),
    sendTwilioSms: (...a: unknown[]) =>
      fakes.sendTwilioSms ? (fakes.sendTwilioSms as (...a: unknown[]) => unknown)(...a) : orig.sendTwilioSms(a[0] as never),
  }
})

const ENV_KEYS = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_NUMBER", "SIDECAR_URL", "CRMS_CALL_CALLER_ID",
  "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_CHAT_ID", "TELEGRAM_BOT_TOKEN", "CAMPAIGN_BOT_TOKEN"] as const
let savedEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  fakes.sb = null
  fakes.sendLeadSms = null
  fakes.sendTwilioSms = null
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  vi.unstubAllGlobals()
  vi.resetModules()
})

// ── Bridge ───────────────────────────────────────────────────────────────────
describe("crms call bridge caller ID", () => {
  async function dial(query: string): Promise<string> {
    const { GET } = await import("@/app/api/crms/call/bridge/route")
    const res = await GET(new NextRequest(`https://x.test/api/crms/call/bridge?touchId=t1&to=%2B14085551234${query}`))
    return await res.text()
  }
  it("line=card dials from the business-card line", async () => {
    expect(await dial("&line=card")).toContain(`callerId="${CARD}"`)
  })
  it("no line / another line → relationshipCallerId() (Ryan's cell)", async () => {
    const { relationshipCallerId } = await import("@/lib/relationship-calls")
    expect(await dial("")).toContain(`callerId="${relationshipCallerId()}"`)
    expect(await dial("&line=office")).toContain(`callerId="${relationshipCallerId()}"`)
    expect(relationshipCallerId()).not.toBe(CARD)
  })
  it("ignores a raw callerId query param", async () => {
    const { relationshipCallerId } = await import("@/lib/relationship-calls")
    const xml = await dial("&callerId=%2B19998887777")
    expect(xml).toContain(`callerId="${relationshipCallerId()}"`)
    expect(xml).not.toContain("19998887777")
  })
})

// ── sendTwilioSms strictFrom ─────────────────────────────────────────────────
describe("sendTwilioSms({ strictFrom: true })", () => {
  type Call = { url: string; form: URLSearchParams | null }
  function stubTwilio(opts: { pool: string[] | "error"; send?: { status: number; json: Record<string, unknown> } }): Call[] {
    const calls: Call[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, form: typeof init?.body === "string" ? new URLSearchParams(init.body) : null })
      if (url.includes("/PhoneNumbers")) {
        if (opts.pool === "error") return new Response("nope", { status: 500 })
        return Response.json({ phone_numbers: opts.pool.map((phone_number) => ({ phone_number })) })
      }
      const send = opts.send ?? { status: 201, json: { sid: "SM123" } }
      return Response.json(send.json, { status: send.status })
    }))
    return calls
  }
  async function freshSend() {
    process.env.TWILIO_ACCOUNT_SID = "AC_test"
    process.env.TWILIO_AUTH_TOKEN = "tok"
    process.env.TWILIO_NUMBER = DEFAULT_LINE
    vi.resetModules() // fresh sender-pool cache per test
    const leads = await vi.importActual<typeof import("@/lib/leads")>("@/lib/leads")
    return leads.sendTwilioSms
  }
  const messages = (calls: Call[]) => calls.filter((c) => c.url.endsWith("/Messages.json"))

  it("throws when the line is not in the sender pool — never sends", async () => {
    const send = await freshSend()
    const calls = stubTwilio({ pool: [DEFAULT_LINE] })
    await expect(send({ to: "+14085551234", body: "hi", preferredFrom: CARD, strictFrom: true })).rejects.toThrow(/not in the A2P sender pool/)
    expect(messages(calls)).toHaveLength(0)
  })
  it("throws when the pool is unreadable — never sends", async () => {
    const send = await freshSend()
    const calls = stubTwilio({ pool: "error" })
    await expect(send({ to: "+14085551234", body: "hi", preferredFrom: CARD, strictFrom: true })).rejects.toThrow(/unreadable/)
    expect(messages(calls)).toHaveLength(0)
  })
  it("throws when Twilio rejects the From — no retry from the default line", async () => {
    const send = await freshSend()
    const calls = stubTwilio({ pool: [CARD, DEFAULT_LINE], send: { status: 400, json: { code: 21712, message: "bad From" } } })
    await expect(send({ to: "+14085551234", body: "hi", preferredFrom: CARD, strictFrom: true })).rejects.toThrow(/bad From/)
    expect(messages(calls).map((c) => c.form?.get("From"))).toEqual([CARD])
  })
  it("sends from the card line with the status callback", async () => {
    const send = await freshSend()
    const calls = stubTwilio({ pool: [CARD, DEFAULT_LINE] })
    const out = await send({ to: "+14085551234", body: "hi", preferredFrom: CARD, strictFrom: true, statusCallback: "https://x.test/cb" })
    expect(out).toEqual({ sid: "SM123", from: CARD, fellBack: false })
    const [m] = messages(calls)
    expect(m.form?.get("From")).toBe(CARD)
    expect(m.form?.get("StatusCallback")).toBe("https://x.test/cb")
  })
  it("without strictFrom the old fallback still applies (unchanged)", async () => {
    const send = await freshSend()
    const calls = stubTwilio({ pool: [DEFAULT_LINE] })
    const out = await send({ to: "+14085551234", body: "hi", preferredFrom: CARD })
    expect(out.from).toBe(DEFAULT_LINE)
    expect(out.fellBack).toBe(true)
    expect(messages(calls)[0].form?.has("StatusCallback")).toBe(false)
  })
})

// ── fetchContactThread ───────────────────────────────────────────────────────
describe("fetchContactThread", () => {
  const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1)
  const apple = (iso: string) => Date.parse(iso) - APPLE_EPOCH_MS
  type TouchRow = { occurred_at: string; action: string; modality: string; message: string | null; twilio_number: string | null }

  function stubSidecar(messages: { at: string; fromMe: boolean; text: string }[]) {
    process.env.SIDECAR_URL = "http://sidecar.test"
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      messages: messages.map((m) => ({ timestamp: apple(m.at), is_from_me: m.fromMe, text: m.text })),
    })))
  }
  // Applies the same filter the PostgREST `.or()` expresses, so the test
  // checks both the filter string and the mapping.
  function touchesSb(rows: TouchRow[], opts: { touchesError?: boolean } = {}) {
    let orFilter = ""
    const fake = fakeSb((table, ops) => {
      if (table === "relationships") return { data: [{ id: "r1" }], error: null }
      orFilter = String(ops.find((o) => o.m === "or")?.args[0] ?? "")
      if (opts.touchesError) return { data: null, error: { message: "boom" } }
      const kept = rows.filter((r) => (r.modality === "sms" && r.action === "inbound") || (r.action === "sent" && r.twilio_number !== null))
      return { data: kept, error: null }
    })
    return { ...fake, orFilter: () => orFilter }
  }

  it("interleaves business-line texts with the sidecar thread by time", async () => {
    const { fetchContactThread } = await import("@/lib/relationship-messages")
    stubSidecar([
      { at: "2026-10-20T10:00:00.000Z", fromMe: true, text: "From my cell" },
      { at: "2026-10-22T10:00:00.000Z", fromMe: false, text: "Reply to cell" },
    ])
    const fake = touchesSb([
      { occurred_at: "2026-10-21T10:00:00.000Z", action: "inbound", modality: "sms", message: "Texted your office", twilio_number: CARD },
      { occurred_at: "2026-10-23T10:00:00.000Z", action: "sent", modality: "Reconnect", message: "Card # send", twilio_number: CARD },
      { occurred_at: "2026-10-19T10:00:00.000Z", action: "inbound", modality: "sms", message: "Old row, no line", twilio_number: null },
    ])
    const thread = await fetchContactThread(fake.sb, "(408) 555-1234")
    expect(thread.map((m) => [m.text, m.fromMe, m.via])).toEqual([
      ["Old row, no line", false, "business line"],
      ["From my cell", true, undefined],
      ["Texted your office", false, CARD],
      ["Reply to cell", false, undefined],
      ["Card # send", true, CARD],
    ])
    expect(fake.orFilter()).toBe("and(modality.eq.sms,action.eq.inbound),and(action.eq.sent,twilio_number.not.is.null)")
  })
  it("excludes sent touches with no twilio_number (sidecar sends live in chat.db)", async () => {
    const { fetchContactThread } = await import("@/lib/relationship-messages")
    stubSidecar([])
    const fake = touchesSb([
      { occurred_at: "2026-10-21T10:00:00.000Z", action: "sent", modality: "Reconnect", message: "iMessage send", twilio_number: null },
      { occurred_at: "2026-10-21T11:00:00.000Z", action: "sent", modality: "Reconnect", message: "Card send", twilio_number: CARD },
    ])
    const thread = await fetchContactThread(fake.sb, "4085551234")
    expect(thread.map((m) => m.text)).toEqual(["Card send"])
  })
  it("drops an exact duplicate within 60 s, keeps one further apart", async () => {
    const { fetchContactThread } = await import("@/lib/relationship-messages")
    stubSidecar([{ at: "2026-10-21T10:00:00.000Z", fromMe: false, text: "See you at 3" }])
    const fake = touchesSb([
      { occurred_at: "2026-10-21T10:00:30.000Z", action: "inbound", modality: "sms", message: "See you at 3", twilio_number: CARD },
      { occurred_at: "2026-10-21T10:05:00.000Z", action: "inbound", modality: "sms", message: "See you at 3", twilio_number: CARD },
    ])
    const thread = await fetchContactThread(fake.sb, "4085551234")
    expect(thread.map((m) => m.at)).toEqual(["2026-10-21T10:00:00.000Z", "2026-10-21T10:05:00.000Z"])
  })
  it("a Supabase error falls back to the sidecar thread alone", async () => {
    const { fetchContactThread } = await import("@/lib/relationship-messages")
    stubSidecar([{ at: "2026-10-21T10:00:00.000Z", fromMe: true, text: "Only the cell" }])
    const fake = touchesSb([], { touchesError: true })
    const thread = await fetchContactThread(fake.sb, "4085551234")
    expect(thread).toEqual([{ at: "2026-10-21T10:00:00.000Z", fromMe: true, text: "Only the cell" }])
  })
  it("formatThreadForPrompt marks Ryan's business-line texts", async () => {
    const { formatThreadForPrompt } = await import("@/lib/relationship-messages")
    const out = formatThreadForPrompt([
      { at: "2026-10-21T18:00:00.000Z", fromMe: true, text: "Card send", via: CARD },
      { at: "2026-10-21T18:05:00.000Z", fromMe: false, text: "Got it", via: CARD },
      { at: "2026-10-21T18:10:00.000Z", fromMe: true, text: "From cell" },
    ])
    const lines = out.split("\n")
    expect(lines[0]).toMatch(/Ryan: Card send \(from business line\)$/)
    expect(lines[1]).toMatch(/Them: Got it$/)
    expect(lines[2]).toMatch(/Ryan: From cell$/)
  })
})

// ── Telegram reply to an office-line text alert ──────────────────────────────
describe("telegram webhook: office-line text replies", () => {
  function tgUpdate(repliedText: string, text = "Sounds good, see you then") {
    return new Request("https://x.test/api/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "s3cret" },
      body: JSON.stringify({
        update_id: Math.floor(Math.random() * 1e9),
        message: { message_id: 7, chat: { id: 42 }, text, reply_to_message: { text: repliedText } },
      }),
    })
  }
  function setup(opts: { rels: unknown[]; lastInbound?: unknown[] }) {
    process.env.TELEGRAM_WEBHOOK_SECRET = "s3cret"
    process.env.TELEGRAM_CHAT_ID = "42"
    process.env.TELEGRAM_BOT_TOKEN = "bot"
    const fake = fakeSb((table) => {
      if (table === "relationships") return { data: opts.rels, error: null }
      if (table === "relationship_touches") return { data: opts.lastInbound ?? [], error: null }
      if (table === "leads") return { data: [], error: null }
      return { data: null, error: null }
    })
    fakes.sb = fake.sb
    const sendTwilioSms = vi.fn(async (a: { preferredFrom: string }) => ({ sid: "SM1", from: a.preferredFrom, fellBack: false }))
    const sendLeadSms = vi.fn(async () => ({ success: true }))
    fakes.sendTwilioSms = sendTwilioSms
    fakes.sendLeadSms = sendLeadSms
    const tgTexts: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      tgTexts.push(String(JSON.parse(String(init?.body ?? "{}")).text ?? ""))
      return Response.json({ ok: true })
    }))
    return { ...fake, sendTwilioSms, sendLeadSms, tgTexts }
  }
  const ALERT = `💬 Office line text — Kelly Ray (Agent) — +14085551234\n"Can you call me?"`
  const KELLY = { id: "r1", name: "Kelly Ray", status: "active", tier: "B", category: "Agent" }

  it("texts back from the office line they last texted and logs a relationship touch, not a lead", async () => {
    const t = setup({ rels: [KELLY], lastInbound: [{ twilio_number: "+16509104007" }, { twilio_number: INFO }] })
    const { POST } = await import("@/app/api/telegram/webhook/route")
    await POST(tgUpdate(ALERT))
    expect(t.sendLeadSms).not.toHaveBeenCalled()
    expect(t.sendTwilioSms).toHaveBeenCalledWith(expect.objectContaining({ to: "+14085551234", preferredFrom: INFO, strictFrom: true }))
    const touch = t.writes.find((w) => w.table === "relationship_touches" && w.kind === "insert")
    expect(touch?.row).toMatchObject({ relationship_id: "r1", modality: "sms", action: "sent", message: "Sounds good, see you then", twilio_number: INFO })
    expect(t.writes.find((w) => w.table === "relationships" && w.kind === "update")?.row).toHaveProperty("last_contacted_at")
    expect(t.writes.some((w) => w.table === "leads")).toBe(false)
    expect(t.tgTexts.at(-1)).toBe("✅ Texted Kelly Ray from (408) 493-0632")
  })
  it("defaults to the business-card line when no office line is on record", async () => {
    const t = setup({ rels: [KELLY] })
    const { POST } = await import("@/app/api/telegram/webhook/route")
    await POST(tgUpdate(ALERT))
    expect(t.sendTwilioSms).toHaveBeenCalledWith(expect.objectContaining({ preferredFrom: CARD, strictFrom: true }))
    expect(t.tgTexts.at(-1)).toBe("✅ Texted Kelly Ray from (408) 458-5442")
  })
  it("a failed send says so and writes nothing", async () => {
    const t = setup({ rels: [KELLY] })
    fakes.sendTwilioSms = vi.fn(async () => { throw new Error("+14084585442 is not in the A2P sender pool") })
    const { POST } = await import("@/app/api/telegram/webhook/route")
    await POST(tgUpdate(ALERT))
    expect(t.writes).toHaveLength(0)
    expect(t.sendLeadSms).not.toHaveBeenCalled()
    expect(t.tgTexts.at(-1)).toMatch(/^⚠️ Not sent — .*not in the A2P sender pool/)
  })
  it("a number that isn't a Relationships contact falls through to sendLeadSms", async () => {
    const t = setup({ rels: [] })
    const { POST } = await import("@/app/api/telegram/webhook/route")
    await POST(tgUpdate(ALERT))
    expect(t.sendTwilioSms).not.toHaveBeenCalled()
    expect(t.sendLeadSms).toHaveBeenCalledWith(expect.objectContaining({ phone: "+14085551234" }))
  })
  it("a non-office-line alert falls through to sendLeadSms", async () => {
    const t = setup({ rels: [KELLY] })
    const { POST } = await import("@/app/api/telegram/webhook/route")
    await POST(tgUpdate(`📞 New lead call — +14085551234`))
    expect(t.sendTwilioSms).not.toHaveBeenCalled()
    expect(t.sendLeadSms).toHaveBeenCalled()
  })
})
