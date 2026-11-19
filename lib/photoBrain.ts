import Anthropic from "@anthropic-ai/sdk"
import { laneClient } from "@/lib/llmUsage"
import { pacificNow, type ExtractedEvent } from "@/lib/calendarIntake"
import { CATEGORIES, parseCaptionHints, type Category, type ImageMediaType, type Tier } from "@/lib/contactIntake"
import { normalizePhone10, phoneAppearsIn, type QrFinding } from "@/lib/photoQr"

// "Photo brain" (2026-11-18). Every photo / screenshot Ryan sends the
// MarketingBot goes through one planner instead of the caption deciding
// between contact intake and the calendar. Ryan sent an uncaptioned
// screenshot of a text thread ("I'll give you a call tomorrow morning around
// 9:30") and got "⚠️ Not added — still need a phone or email" from contact
// intake. The planner looks at the image (plus any QR payload decoded in
// code, plus the page that QR links to) and returns everything to do:
// several business cards on a table, a call to put on the calendar, or both.
//
// Opus 5.5 at effort low: thinking cannot be switched off on this model and
// forced tool_choice is rejected, so the tool is strict + tool_choice auto +
// a prompt instruction to always call it.

const MODEL = "claude-opus-5-5"
const TOOL_NAME = "record_photo_plan"

export const PHOTO_SOURCE = "telegram photo"

export type PlanKind = "contacts" | "calendar" | "mixed" | "unclear"

export interface PlannedContact {
  name: string | null
  phone: string | null // 10 digits
  email: string | null
  company: string | null
  title: string | null
  category: Category
  categoryAlternatives: Category[]
  tier: Tier | null
  notes: string | null
  uncertain: boolean
  fromQr: boolean
}

export type PlannedEvent = ExtractedEvent & { summary: string; start: string; end: string }

export interface PhotoPlan {
  kind: PlanKind
  contacts: PlannedContact[]
  events: PlannedEvent[]
  question: string | null
}

function systemPrompt(): string {
  const { human, offset } = pacificNow()
  return `You read one photo or screenshot that Ryan — a Bay Area real estate investor — sent to his assistant bot, and decide what to do with it. Always answer by calling the ${TOOL_NAME} tool exactly once.

Right now it is ${human} (America/Los_Angeles, UTC offset ${offset}).

The photo can be:
- one or SEVERAL business cards (a table of cards from a networking event — return EACH card as its own contact),
- an iPhone contact card, an email signature, a Redfin/Zillow agent page, a LinkedIn profile,
- someone's phone screen showing a digital business card / QR code (the decoded QR payload and the text of the page it links to are given below when present),
- a text/iMessage/WhatsApp thread or email that sets up a call, meeting or showing,
- an event flyer, invite, Eventbrite page or calendar screenshot,
- or several of these at once.

Ryan's note (if any) is free-form and AUTHORITATIVE. It may apply to everyone ("all agents from the Santa Clara meetup", "tier A") or to one person ("the gray card is a lender, call him Tuesday 10am" → that person's category, plus an event). Apply it.

contacts — one per PERSON TO ADD to his relationships book: every business card, a contact screenshot, an email signature, a digital card / QR card. Do NOT add people who are merely mentioned or messaging in a text thread or event (e.g. "Matt" in a thread saying he'll call) — only people whose contact details the photo is meant to capture. Fields:
- name: full name as shown; null if none.
- phone: the person's main phone as 10 US digits (no +1, no punctuation), ONLY digits actually visible in the image or present in the QR/fetched text. Never guess or complete a number. null if none or unreadable.
- email: lowercase, only if visible / in the QR text. null otherwise.
- company, title: as shown, else null.
- category: ALWAYS pick a best guess from ${CATEGORIES.join(" | ")}. Real-estate agent / broker / realtor → Agent. Mortgage or loan officer, title, escrow, contractor, inspector, stager, photographer, attorney, insurance → Vendor. Private or hard-money lender, or someone offering capital → PrivateMoney. Investor, flipper, wholesaler, landlord, developer → Investor. Property manager → PM. Friend, family, social → Personal.
- categoryAlternatives: 0–3 OTHER plausible categories, most likely first (never repeat category).
- tier: A–E only if Ryan's note says so (e.g. "tier A", "A level"), else null.
- notes: short — "Title @ Company" plus anything Ryan's note says about this person. null if nothing.
- uncertain: true if the read is shaky (blurry digits, cut-off card, two candidate names).
- fromQr: true if the details came from the QR payload / fetched page rather than printed text in the photo.

events — calls, meetings, showings or appointments with a date and time stated in a message thread, and events from a flyer / invite / Eventbrite / calendar screenshot:
- summary: "[Type] - [Place/Property] with [Person]", dropping parts you don't have. A call → "Call with Matt". Examples: "Showing - 1130 Suffolk Ct with Marjan", "Conventus Connect networking - Terún Pizza, Palo Alto".
- start/end: RFC3339 with the ${offset} offset, e.g. 2026-09-17T18:00:00${offset}. "around 9:30 or after 10:30" → start at the first time. A call with no end → 30 minutes; any other event with no end → 1 hour. Date known but no time at all → allDay true, start/end as YYYY-MM-DD (end = same day).
- Resolve relative dates ("tomorrow", "Thursday") against the date the message was SENT when the screenshot shows it (e.g. a "Yesterday 4:12 PM" or "Mon, Nov 16" header above the message); otherwise against right now. A bare weekday = its next occurrence.
- location: street address or venue/city, else null. person: who Ryan is meeting, as named, else null. description: useful context (who, what, link), else null.
- Never invent a date or time. Never add an event that is already in the past.

kind: "contacts", "calendar", "mixed" (both), or "unclear" when you can't tell what Ryan wants done with this photo.
question: one short question for Ryan ONLY when you truly can't tell what to do (set kind "unclear"), or when an event's date/time is genuinely ambiguous (leave that event out and ask). Otherwise null.`
}

const CATEGORY_ENUM = { type: "string", enum: [...CATEGORIES] }

const PLAN_TOOL: Anthropic.Tool = {
  name: TOOL_NAME,
  description: "Record every contact to add and every calendar event to create from this photo.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["contacts", "calendar", "mixed", "unclear"] },
      contacts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: ["string", "null"] },
            phone: { type: ["string", "null"], description: "exactly 10 digits or null" },
            email: { type: ["string", "null"] },
            company: { type: ["string", "null"] },
            title: { type: ["string", "null"] },
            category: CATEGORY_ENUM,
            categoryAlternatives: { type: "array", items: CATEGORY_ENUM },
            // strict mode rejects an enum containing null on ["string","null"]
            // (contactIntake, 2026-08-20) — anyOf with a null branch instead.
            tier: { anyOf: [{ type: "string", enum: ["A", "B", "C", "D", "E"] }, { type: "null" }] },
            notes: { type: ["string", "null"] },
            uncertain: { type: "boolean" },
            fromQr: { type: "boolean" },
          },
          required: ["name", "phone", "email", "company", "title", "category", "categoryAlternatives", "tier", "notes", "uncertain", "fromQr"],
          additionalProperties: false,
        },
      },
      events: {
        type: "array",
        items: {
          type: "object",
          properties: {
            summary: { type: "string" },
            start: { type: "string" },
            end: { type: ["string", "null"] },
            allDay: { type: "boolean" },
            location: { type: ["string", "null"] },
            person: { type: ["string", "null"] },
            description: { type: ["string", "null"] },
          },
          required: ["summary", "start", "end", "allDay", "location", "person", "description"],
          additionalProperties: false,
        },
      },
      question: { type: ["string", "null"] },
    },
    required: ["kind", "contacts", "events", "question"],
    additionalProperties: false,
  },
}

/** The QR section of the planner's text input. */
export function qrContext(findings: QrFinding[]): string {
  if (!findings.length) return ""
  const parts = findings.map((f, i) => {
    const lines = [`QR code ${i + 1} (${f.kind}) payload:\n${f.payload.slice(0, 2000)}`]
    if (f.finalUrl && f.finalUrl !== f.payload) lines.push(`(link opened at ${f.finalUrl})`)
    if (f.fetchedText) lines.push(`Text of the linked page:\n"""\n${f.fetchedText}\n"""`)
    if (f.error) lines.push(`(${f.error})`)
    return lines.join("\n")
  })
  return `Decoded from the photo:\n${parts.join("\n\n")}`
}

/** All QR text a QR-sourced phone may come from. */
export function qrEvidence(findings: QrFinding[]): string {
  return findings.map((f) => `${f.payload}\n${f.fetchedText ?? ""}`).join("\n")
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

function asCategory(v: unknown): Category | null {
  if (typeof v !== "string") return null
  const key = v.toLowerCase().replace(/[^a-z]/g, "")
  return CATEGORIES.find((c) => c.toLowerCase() === key) ?? null
}

/** "2026-11-19T09:30:00-08:00" + 30 → "2026-11-19T10:00:00-08:00" (keeps the offset). */
export function addMinutesRfc(start: string, minutes: number): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(Z|[+-]\d{2}:\d{2})$/.exec(start)
  if (!m) return null
  const t = new Date(start).getTime()
  if (Number.isNaN(t)) return null
  const off = m[2] === "Z" ? 0 : (m[2][0] === "-" ? -1 : 1) * (Number(m[2].slice(1, 3)) * 60 + Number(m[2].slice(4, 6)))
  const local = new Date(t + minutes * 60_000 + off * 60_000)
  const iso = local.toISOString().slice(0, 19)
  return `${iso}${m[2]}`
}

/** Model tool input → a validated plan. Pure, so the tests can feed it
 *  canned responses. `qrText` = every QR payload + fetched page; a phone on a
 *  QR-sourced contact must appear in it or it is dropped. */
export function parsePlan(raw: unknown, ctx: { note: string; qrText: string }): PhotoPlan {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const kinds: PlanKind[] = ["contacts", "calendar", "mixed", "unclear"]
  const kind = kinds.includes(r.kind as PlanKind) ? (r.kind as PlanKind) : "unclear"

  const contacts: PlannedContact[] = (Array.isArray(r.contacts) ? r.contacts : []).map((c0) => {
    const c = (c0 && typeof c0 === "object" ? c0 : {}) as Record<string, unknown>
    const fromQr = c.fromQr === true && ctx.qrText.trim().length > 0
    let phone = normalizePhone10(str(c.phone))
    if (phone && fromQr && !phoneAppearsIn(phone, ctx.qrText)) phone = null
    const emailRaw = str(c.email)?.toLowerCase().replace(/^mailto:/, "") ?? null
    const email = emailRaw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw) ? emailRaw : null
    const category = asCategory(c.category) ?? "Personal"
    const alts: Category[] = []
    for (const a of Array.isArray(c.categoryAlternatives) ? c.categoryAlternatives : []) {
      const cat = asCategory(a)
      if (cat && cat !== category && !alts.includes(cat)) alts.push(cat)
    }
    const tier = typeof c.tier === "string" && /^[A-E]$/.test(c.tier) ? (c.tier as Tier) : null
    const company = str(c.company)
    const title = str(c.title)
    const role = [title, company].filter(Boolean).join(" @ ")
    let notes = str(c.notes)
    if (!notes && role) notes = role
    return {
      name: str(c.name),
      phone,
      email,
      company,
      title,
      category,
      categoryAlternatives: alts.slice(0, 3),
      tier,
      notes,
      uncertain: c.uncertain === true,
      fromQr,
    }
  })

  // The caption is authoritative; the deterministic parse is the guarantee —
  // only when it can't be misapplied (exactly one person).
  if (contacts.length === 1 && ctx.note.trim()) {
    const hints = parseCaptionHints(ctx.note)
    const c = contacts[0]
    if (hints.category && hints.category !== c.category) {
      c.categoryAlternatives = [c.category, ...c.categoryAlternatives.filter((a) => a !== hints.category)].slice(0, 3)
      c.category = hints.category
    }
    if (hints.tier) c.tier = hints.tier
  }

  const events: PlannedEvent[] = []
  for (const e0 of Array.isArray(r.events) ? r.events : []) {
    const e = (e0 && typeof e0 === "object" ? e0 : {}) as Record<string, unknown>
    const summary = str(e.summary)
    const start = str(e.start)
    if (!summary || !start) continue
    const allDay = e.allDay === true
    let end = str(e.end)
    if (!end) end = allDay ? start : addMinutesRfc(start, /\bcall\b/i.test(summary) ? 30 : 60)
    if (!end) continue
    events.push({
      summary,
      start,
      end,
      allDay,
      location: str(e.location),
      description: str(e.description),
      person: str(e.person),
      question: null,
      isEvent: true,
    })
  }

  return { kind, contacts, events, question: str(r.question) }
}

export async function planPhoto(args: {
  image: { base64: string; mediaType: ImageMediaType }
  note: string
  qr: QrFinding[]
}): Promise<{ plan?: PhotoPlan; error?: string }> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY_BACKGROUND) return { error: "ANTHROPIC_API_KEY not set" }
  const client = laneClient("background", "[photo-brain]")
  const note = args.note.trim()
  const qrText = qrContext(args.qr)
  const text = [note ? `Ryan's note: "${note}"` : "(no note from Ryan — work it out from the photo)", qrText].filter(Boolean).join("\n\n")
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      // Opus 5.5: thinking can't be disabled (400) — low effort keeps it quick.
      output_config: { effort: "low" },
      system: systemPrompt(),
      tools: [PLAN_TOOL],
      tool_choice: { type: "auto" },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: args.image.mediaType, data: args.image.base64 } },
            { type: "text", text },
          ],
        },
      ],
    })
    if (response.stop_reason === "refusal") return { error: "model declined to read this" }
    const block = response.content.find((b) => b.type === "tool_use" && b.name === TOOL_NAME)
    if (!block || block.type !== "tool_use") return { error: `model returned no plan (stop: ${response.stop_reason})` }
    return { plan: parsePlan(block.input, { note, qrText: qrEvidence(args.qr) }) }
  } catch (e) {
    return { error: `Claude API: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// ---- The one summary reply ---------------------------------------------------

export const REL_CAT_PREFIX = "rcat:"
export const REL_DEL_PREFIX = "rdel:"

export type ContactOutcome =
  | {
      status: "added"
      id: string
      name: string
      category: Category
      tier: Tier
      phone: string | null
      email: string | null
      alternatives: Category[]
      uncertain: boolean
    }
  | { status: "duplicate"; name: string }
  | { status: "failed"; name: string; error: string }
  | { status: "skipped"; reason: string }

export interface EventOutcome {
  /** one or more lines for the summary */
  line: string
  /** the event's existing ↩️ Undo callback, when it was created / linked */
  undo: string | null
  /** short label for the undo button */
  label: string
}

export interface InlineButton {
  text: string
  callback_data: string
}

/** Telegram rejects callback_data over 64 BYTES. */
export function fitsCallback(data: string): boolean {
  return Buffer.byteLength(data, "utf8") <= 64
}

function fmtPhone(p: string): string {
  return `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}`
}

function firstName(name: string): string {
  const f = name.trim().split(/\s+/)[0] || name
  return f.length > 16 ? `${f.slice(0, 15)}…` : f
}

/** Text + inline keyboard for the reply to the photo. Pure. */
export function buildPhotoSummary(args: {
  contacts: ContactOutcome[]
  events: EventOutcome[]
  notes?: string[]
  question?: string | null
}): { text: string; keyboard: InlineButton[][] } {
  const lines: string[] = []
  const keyboard: InlineButton[][] = []
  const people = args.contacts.filter((c) => c.status !== "skipped")
  const added = args.contacts.filter((c) => c.status === "added").length
  if (people.length) {
    const noun = people.length === 1 ? "contact" : "contacts"
    lines.push(`📸 Found ${people.length} ${noun}${added ? ` — added ${added === people.length ? (people.length === 1 ? "it" : "all") : added}` : ""}:`)
  }
  for (const c of args.contacts) {
    if (c.status === "added") {
      const reach = [c.phone ? fmtPhone(c.phone) : null, c.email].filter(Boolean).join(", ")
      const meta = c.tier === "C" ? c.category : `${c.category}, tier ${c.tier}`
      lines.push(`• ${c.name} (${meta}) — ${reach || "no phone/email"}${c.uncertain ? " · ⚠️ shaky read, check the card" : ""}`)
      const row: InlineButton[] = []
      for (const alt of c.alternatives.slice(0, 3)) {
        const b = { text: `${firstName(c.name)}→${alt}`, callback_data: `${REL_CAT_PREFIX}${c.id}:${alt}` }
        if (fitsCallback(b.callback_data)) row.push(b)
      }
      const undo = { text: `↩️ ${firstName(c.name)}`, callback_data: `${REL_DEL_PREFIX}${c.id}` }
      if (fitsCallback(undo.callback_data)) row.push(undo)
      if (row.length) keyboard.push(row)
    } else if (c.status === "duplicate") {
      lines.push(`• ${c.name} — already in Relationships, not added (see the ⏸ message)`)
    } else if (c.status === "failed") {
      lines.push(`• ${c.name} — ❌ not added: ${c.error}`)
    } else {
      lines.push(`• ${c.reason}`)
    }
  }
  for (const e of args.events) {
    lines.push(e.line)
    if (e.undo && fitsCallback(e.undo)) keyboard.push([{ text: `↩️ ${e.label}`, callback_data: e.undo }])
  }
  if (args.question) lines.push(`🤔 ${args.question}`)
  for (const n of args.notes ?? []) lines.push(`ℹ️ ${n}`)
  if (!lines.length) lines.push("📸 Nothing to add from that photo.")
  return { text: lines.join("\n"), keyboard }
}
