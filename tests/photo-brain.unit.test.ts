import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import QRCode from "qrcode"
import { PNG } from "pngjs"
import * as jpeg from "jpeg-js"

// The planner's model call is mocked — unit tests never reach the API.
const createMock = vi.fn()
vi.mock("@/lib/llmUsage", () => ({
  laneClient: () => ({ messages: { create: (...a: unknown[]) => createMock(...a) } }),
}))

import {
  decodeQrCodes,
  findVcfLink,
  htmlToText,
  isFetchableUrl,
  normalizePhone10,
  parseMeCard,
  parseVCard,
  phoneAppearsIn,
  resolveQrPayload,
} from "@/lib/photoQr"
import {
  addMinutesRfc,
  buildPhotoSummary,
  fitsCallback,
  parsePlan,
  planPhoto,
  qrEvidence,
  REL_CAT_PREFIX,
  REL_DEL_PREFIX,
  type ContactOutcome,
} from "@/lib/photoBrain"

const VCARD = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "N:Lee;Sarah;;;",
  "FN:Sarah Lee",
  "ORG:Bay Realty",
  "TITLE:Realtor",
  "TEL;TYPE=CELL:+1 (408) 555-1212",
  "EMAIL;TYPE=INTERNET:Sarah@BayRealty.com",
  "URL:https://bayrealty.example/sarah",
  "END:VCARD",
].join("\r\n")

async function qrPng(text: string): Promise<Buffer> {
  return QRCode.toBuffer(text, { type: "png", margin: 4, scale: 6, errorCorrectionLevel: "M" })
}

/** A QR pasted off-centre into a big noisy canvas (a phone photo stand-in). */
function embed(qr: Buffer, opts: { w: number; h: number; x: number; y: number }): PNG {
  const src = PNG.sync.read(qr)
  const out = new PNG({ width: opts.w, height: opts.h })
  let seed = 12345
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let i = 0; i < opts.w * opts.h; i++) {
    const v = 150 + Math.floor(rand() * 90)
    out.data[i * 4] = v
    out.data[i * 4 + 1] = v - 10
    out.data[i * 4 + 2] = v - 25
    out.data[i * 4 + 3] = 255
  }
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const s = (y * src.width + x) * 4
      const d = ((opts.y + y) * opts.w + (opts.x + x)) * 4
      out.data[d] = src.data[s]
      out.data[d + 1] = src.data[s + 1]
      out.data[d + 2] = src.data[s + 2]
      out.data[d + 3] = 255
    }
  }
  return out
}

describe("QR decode", () => {
  it("decodes a vCard QR", async () => {
    expect(decodeQrCodes(await qrPng(VCARD))).toEqual([VCARD])
  })

  it("decodes a URL QR", async () => {
    const url = "https://blinq.me/abc123XYZ"
    expect(decodeQrCodes(await qrPng(url))).toEqual([url])
  })

  it("finds a QR off-centre in a larger noisy image (PNG and JPEG)", async () => {
    const url = "https://popl.co/card/xyz789"
    const img = embed(await qrPng(url), { w: 1600, h: 1200, x: 1050, y: 700 })
    expect(decodeQrCodes(PNG.sync.write(img))).toEqual([url])
    const jpg = jpeg.encode({ data: img.data, width: img.width, height: img.height }, 90).data
    expect(decodeQrCodes(jpg)).toEqual([url])
  })

  it("returns [] for an image with no QR and for non-image bytes", async () => {
    const blank = new PNG({ width: 200, height: 200 })
    blank.data.fill(255)
    expect(decodeQrCodes(PNG.sync.write(blank))).toEqual([])
    expect(decodeQrCodes(Buffer.from("not an image"))).toEqual([])
  })
})

describe("vCard / MECARD", () => {
  it("parses a vCard", () => {
    const c = parseVCard(VCARD)!
    expect(c.name).toBe("Sarah Lee")
    expect(c.phones).toEqual(["+1 (408) 555-1212"])
    expect(c.emails).toEqual(["sarah@bayrealty.com"])
    expect(c.org).toBe("Bay Realty")
    expect(c.title).toBe("Realtor")
  })

  it("falls back to N when FN is missing and unfolds lines", () => {
    const c = parseVCard("BEGIN:VCARD\nVERSION:2.1\nN:Chen;Mike\nTEL:408555\n 7777\nEND:VCARD")!
    expect(c.name).toBe("Mike Chen")
    expect(c.phones).toEqual(["4085557777"])
  })

  it("parses a MECARD", () => {
    const c = parseMeCard("MECARD:N:Chen,Mike;TEL:+14085557777;EMAIL:mike@cap.com;ORG:Chen Capital;;")!
    expect(c.name).toBe("Mike Chen")
    expect(c.phones).toEqual(["+14085557777"])
    expect(c.emails).toEqual(["mike@cap.com"])
    expect(c.org).toBe("Chen Capital")
  })

  it("is null for non-cards", () => {
    expect(parseVCard("hello")).toBeNull()
    expect(parseMeCard("https://x.com")).toBeNull()
  })
})

describe("phones", () => {
  it("normalizes to 10 digits", () => {
    expect(normalizePhone10("+1 (408) 555-1212")).toBe("4085551212")
    expect(normalizePhone10("408.555.1212")).toBe("4085551212")
    expect(normalizePhone10("14085551212")).toBe("4085551212")
    expect(normalizePhone10("555-1212")).toBeNull()
    expect(normalizePhone10("+44 20 7946 0958")).toBeNull()
    expect(normalizePhone10("0085551212")).toBeNull()
    expect(normalizePhone10(null)).toBeNull()
  })

  it("verifies a phone against fetched text", () => {
    const text = "Sarah Lee · Realtor\nLink: tel:+1-408-555-1212\nOffice (650) 555 0000"
    expect(phoneAppearsIn("4085551212", text)).toBe(true)
    expect(phoneAppearsIn("6505550000", text)).toBe(true)
    expect(phoneAppearsIn("4085559999", text)).toBe(false)
  })
})

describe("QR links", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("refuses internal targets", () => {
    expect(isFetchableUrl("http://localhost:5799/x")).toBeNull()
    expect(isFetchableUrl("http://192.168.1.10/")).toBeNull()
    expect(isFetchableUrl("http://169.254.169.254/latest")).toBeNull()
    expect(isFetchableUrl("ftp://example.com/")).toBeNull()
    expect(isFetchableUrl("https://blinq.me/abc")?.hostname).toBe("blinq.me")
  })

  it("strips HTML to text but keeps tel:/mailto: links", () => {
    const t = htmlToText(
      `<html><head><title>Sarah Lee | Blinq</title><script>var x=1</script><style>.a{}</style></head><body><h1>Sarah Lee</h1><p>Realtor &amp; Broker</p><a href="tel:+14085551212">Call</a><a href="mailto:sarah@x.com">Email</a></body></html>`
    )
    expect(t).toContain("Title: Sarah Lee | Blinq")
    expect(t).toContain("Link: tel:+14085551212")
    expect(t).toContain("Link: mailto:sarah@x.com")
    expect(t).toContain("Realtor & Broker")
    expect(t).not.toContain("var x")
  })

  it("finds a .vcf link", () => {
    expect(findVcfLink(`<a href="/api/card/42.vcf">Save</a>`, "https://blinq.me/abc")).toBe("https://blinq.me/api/card/42.vcf")
  })

  it("fetches the page and its .vcf (fetch mocked)", async () => {
    const calls: string[] = []
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url)
      if (url.endsWith(".vcf")) return new Response(VCARD, { status: 200, headers: { "content-type": "text/vcard" } })
      return new Response(`<html><title>Sarah</title><body>Sarah Lee <a href="/c/sarah.vcf">Save contact</a></body></html>`, {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    })
    const f = await resolveQrPayload("https://blinq.me/abc")
    expect(calls).toEqual(["https://blinq.me/abc", "https://blinq.me/c/sarah.vcf"])
    expect(f.kind).toBe("url")
    expect(f.card?.name).toBe("Sarah Lee")
    expect(f.fetchedText).toContain("TEL;TYPE=CELL:+1 (408) 555-1212")
    expect(f.error).toBeUndefined()
  })

  it("notes a failed fetch instead of throwing", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNRESET")
    })
    const f = await resolveQrPayload("https://blinq.me/abc")
    expect(f.error).toMatch(/couldn't open the link/)
    expect(f.fetchedText).toBeNull()
  })
})

describe("callback_data", () => {
  it("stays ≤ 64 bytes for a uuid + the longest category", () => {
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e"
    expect(id).toHaveLength(36)
    const longest = "PrivateMoney"
    expect(fitsCallback(`${REL_CAT_PREFIX}${id}:${longest}`)).toBe(true)
    expect(fitsCallback(`${REL_DEL_PREFIX}${id}`)).toBe(true)
    expect(fitsCallback("x".repeat(65))).toBe(false)
    const { keyboard } = buildPhotoSummary({
      contacts: [
        { status: "added", id, name: "Maximiliana Rodriguez-Vasquez", category: "Investor", tier: "C", phone: null, email: null, alternatives: ["PrivateMoney", "Vendor", "Agent"], uncertain: false },
      ],
      events: [{ line: "📅 x", undo: `calundo:${"a".repeat(80)}`, label: "x" }],
    })
    for (const row of keyboard) for (const b of row) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64)
    // the over-long event undo was dropped, not sent
    expect(keyboard).toHaveLength(1)
    expect(keyboard[0]).toHaveLength(4)
  })
})

describe("parsePlan", () => {
  const multi = {
    kind: "mixed",
    contacts: [
      { name: "Sarah Lee", phone: "(408) 555-1212", email: "Sarah@X.com", company: "Bay Realty", title: "Realtor", category: "Agent", categoryAlternatives: ["Investor", "Agent"], tier: null, notes: null, uncertain: false, fromQr: false },
      { name: "Mike Chen", phone: null, email: null, company: "Chen Capital", title: null, category: "PrivateMoney", categoryAlternatives: ["Investor"], tier: "B", notes: "Chen Capital — hard money", uncertain: true, fromQr: false },
      { name: null, phone: "555-1212", email: null, company: null, title: null, category: "Vendor", categoryAlternatives: [], tier: null, notes: null, uncertain: false, fromQr: false },
    ],
    events: [
      { summary: "Call with Matt", start: "2026-11-19T09:30:00-08:00", end: null, allDay: false, location: null, person: "Matt", description: null },
      { summary: "", start: "2026-11-19T09:30:00-08:00", end: null, allDay: false, location: null, person: null, description: null },
    ],
    question: null,
  }

  it("validates a multi-card + event plan", () => {
    const p = parsePlan(multi, { note: "", qrText: "" })
    expect(p.kind).toBe("mixed")
    expect(p.contacts).toHaveLength(3)
    expect(p.contacts[0]).toMatchObject({ name: "Sarah Lee", phone: "4085551212", email: "sarah@x.com", category: "Agent", categoryAlternatives: ["Investor"], tier: null, notes: "Realtor @ Bay Realty" })
    expect(p.contacts[1]).toMatchObject({ phone: null, category: "PrivateMoney", tier: "B", uncertain: true })
    expect(p.contacts[2]).toMatchObject({ name: null, phone: null })
    expect(p.events).toHaveLength(1)
    expect(p.events[0]).toMatchObject({ summary: "Call with Matt", start: "2026-11-19T09:30:00-08:00", end: "2026-11-19T10:00:00-08:00", person: "Matt" })
  })

  it("drops a QR-sourced phone that isn't in the fetched text", () => {
    const qrText = "https://blinq.me/abc\nSarah Lee\nLink: tel:+14085551212"
    const raw = {
      kind: "contacts",
      contacts: [
        { ...multi.contacts[0], fromQr: true },
        { ...multi.contacts[0], name: "Other", phone: "4085559999", fromQr: true },
      ],
      events: [],
      question: null,
    }
    const p = parsePlan(raw, { note: "", qrText })
    expect(p.contacts[0].phone).toBe("4085551212")
    expect(p.contacts[1].phone).toBeNull()
  })

  it("applies the caption override only for a single contact", () => {
    const one = { ...multi, contacts: [multi.contacts[0]] }
    const p1 = parsePlan(one, { note: "she's actually an investor, tier A", qrText: "" })
    expect(p1.contacts[0]).toMatchObject({ category: "Investor", tier: "A" })
    expect(p1.contacts[0].categoryAlternatives[0]).toBe("Agent")
    const p2 = parsePlan(multi, { note: "investor, tier A", qrText: "" })
    expect(p2.contacts[0]).toMatchObject({ category: "Agent", tier: null })
  })

  it("passes an unclear plan's question through", () => {
    const p = parsePlan({ kind: "unclear", contacts: [], events: [], question: "Add the house or the agent?" }, { note: "", qrText: "" })
    expect(p).toEqual({ kind: "unclear", contacts: [], events: [], question: "Add the house or the agent?" })
  })

  it("survives garbage", () => {
    expect(parsePlan(null, { note: "", qrText: "" })).toEqual({ kind: "unclear", contacts: [], events: [], question: null })
  })

  it("adds minutes keeping the offset", () => {
    expect(addMinutesRfc("2026-11-19T23:45:00-08:00", 30)).toBe("2026-11-20T00:15:00-08:00")
    expect(addMinutesRfc("2026-11-19", 30)).toBeNull()
  })
})

describe("planPhoto (model mocked)", () => {
  const image = { base64: "AAAA", mediaType: "image/jpeg" as const }
  beforeEach(() => {
    createMock.mockReset()
    process.env.ANTHROPIC_API_KEY = "test"
  })

  it("builds an Opus request and parses the tool call", async () => {
    createMock.mockResolvedValue({
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "Reading the cards." },
        {
          type: "tool_use",
          id: "t1",
          name: "record_photo_plan",
          input: {
            kind: "mixed",
            contacts: [
              { name: "Sarah Lee", phone: "4085551212", email: null, company: null, title: null, category: "Agent", categoryAlternatives: [], tier: null, notes: null, uncertain: false, fromQr: true },
              { name: "Mike Chen", phone: "4085557777", email: null, company: null, title: null, category: "PrivateMoney", categoryAlternatives: [], tier: null, notes: null, uncertain: false, fromQr: false },
            ],
            events: [{ summary: "Call with Matt", start: "2026-11-19T09:30:00-08:00", end: "2026-11-19T10:00:00-08:00", allDay: false, location: null, person: "Matt", description: null }],
            question: null,
          },
        },
      ],
    })
    const qr = [{ payload: "https://blinq.me/abc", kind: "url" as const, card: null, fetchedText: "Sarah Lee tel:+1 408 555 1212" }]
    const { plan, error } = await planPhoto({ image, note: "Santa Clara meetup", qr })
    expect(error).toBeUndefined()
    expect(plan!.contacts.map((c) => c.phone)).toEqual(["4085551212", "4085557777"])
    expect(plan!.events).toHaveLength(1)
    const req = createMock.mock.calls[0][0]
    expect(req.model).toBe("claude-opus-5-5")
    expect(req.thinking).toBeUndefined()
    expect(req.output_config).toEqual({ effort: "low" })
    expect(req.tool_choice).toEqual({ type: "auto" })
    expect(req.tools[0].strict).toBe(true)
    const text = req.messages[0].content[1].text as string
    expect(text).toContain('Ryan\'s note: "Santa Clara meetup"')
    expect(text).toContain("https://blinq.me/abc")
    expect(req.system).toMatch(/America\/Los_Angeles/)
    expect(qrEvidence(qr)).toContain("408 555 1212")
  })

  it("reports a refusal and a missing tool call as errors", async () => {
    createMock.mockResolvedValueOnce({ stop_reason: "refusal", content: [] })
    expect((await planPhoto({ image, note: "", qr: [] })).error).toMatch(/declined/)
    createMock.mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "hmm" }] })
    expect((await planPhoto({ image, note: "", qr: [] })).error).toMatch(/no plan/)
    createMock.mockRejectedValueOnce(new Error("overloaded"))
    expect((await planPhoto({ image, note: "", qr: [] })).error).toMatch(/Claude API: overloaded/)
  })
})

describe("buildPhotoSummary", () => {
  const id1 = "11111111-1111-4111-8111-111111111111"
  const id2 = "22222222-2222-4222-8222-222222222222"
  const contacts: ContactOutcome[] = [
    { status: "added", id: id1, name: "Sarah Lee", category: "Agent", tier: "C", phone: "4085551212", email: "sarah@x.com", alternatives: ["Investor"], uncertain: false },
    { status: "added", id: id2, name: "Mike Chen", category: "PrivateMoney", tier: "B", phone: null, email: null, alternatives: [], uncertain: true },
    { status: "duplicate", name: "Dana Fox" },
    { status: "skipped", reason: "Skipped a card with no name." },
  ]

  it("writes one summary with per-contact rows and event undo", () => {
    const { text, keyboard } = buildPhotoSummary({
      contacts,
      events: [{ line: "📅 Call with Matt — Thu, Nov 19, 2026, 9:30 AM – 10:00 AM", undo: "calundo:abc123def", label: "Call with Matt" }],
      notes: ["QR: couldn't open the link (timed out)"],
    })
    expect(text.split("\n")).toEqual([
      "📸 Found 3 contacts — added 2:",
      "• Sarah Lee (Agent) — (408) 555-1212, sarah@x.com",
      "• Mike Chen (PrivateMoney, tier B) — no phone/email · ⚠️ shaky read, check the card",
      "• Dana Fox — already in Relationships, not added (see the ⏸ message)",
      "• Skipped a card with no name.",
      "📅 Call with Matt — Thu, Nov 19, 2026, 9:30 AM – 10:00 AM",
      "ℹ️ QR: couldn't open the link (timed out)",
    ])
    expect(keyboard).toEqual([
      [
        { text: "Sarah→Investor", callback_data: `rcat:${id1}:Investor` },
        { text: "↩️ Sarah", callback_data: `rdel:${id1}` },
      ],
      [{ text: "↩️ Mike", callback_data: `rdel:${id2}` }],
      [{ text: "↩️ Call with Matt", callback_data: "calundo:abc123def" }],
    ])
  })

  it("handles an events-only photo", () => {
    const { text, keyboard } = buildPhotoSummary({ contacts: [], events: [{ line: "📅 Call with Matt — …", undo: null, label: "x" }] })
    expect(text).toBe("📅 Call with Matt — …")
    expect(keyboard).toEqual([])
  })
})
