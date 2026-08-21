import Anthropic from "@anthropic-ai/sdk"
import type { ImageMediaType } from "@/lib/contactIntake"

// Telegram → Google Calendar (2026-08-21). Replaces the Thadius/OpenClaw
// `calendar-events` skill: Ryan sends "add to calendar: showing at 1130
// Suffolk Ct tomorrow 2pm with Marjan" or a screenshot of an invite /
// iMessage thread with a caption, and the event lands on info@lrghomes.com.
//
// Claude (vision) extracts the event; the WRITE goes through the Mac-mini
// sidecar's /calendar/create, which wraps the local `gog` CLI — Vercel's
// service account is Gmail-only (Calendar scope → unauthorized_client).
//
// Same rules as the old skill: create immediately when date + time + title
// are clear; ask ONE question only when genuinely ambiguous; never create
// an event in the past.

const MODEL = "claude-sonnet-5"
const SIDECAR_URL = process.env.SIDECAR_URL || "http://localhost:5799"

export interface ExtractedEvent {
  summary: string | null
  /** RFC3339 with Pacific offset, or YYYY-MM-DD when allDay */
  start: string | null
  end: string | null
  allDay: boolean
  location: string | null
  description: string | null
  /** set when the date/time can't be pinned down — the question to ask Ryan */
  question: string | null
}

function pacificNow(): { iso: string; human: string; offset: string } {
  const now = new Date()
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(now)
  const tz = /PDT/.test(parts) ? "-07:00" : "-08:00"
  return { iso: now.toISOString(), human: parts, offset: tz }
}

function systemPrompt(): string {
  const { human, offset } = pacificNow()
  return `You turn a message (and optionally a screenshot) from Ryan, a Bay Area real estate investor, into ONE Google Calendar event.

Right now it is ${human} (America/Los_Angeles, UTC offset ${offset}). Resolve every relative date against that: "tomorrow" = the next calendar day; a bare weekday name = the next occurrence of that weekday (if today is that weekday and the time has not passed, today); "next Monday" = Monday of next week; "3/28" = that date this year unless already past, then next year.

Rules:
- summary: short title in the form "[Type] - [Place/Property] with [Person]", dropping parts you don't have. Examples: "Showing - 1130 Suffolk Ct with Marjan", "Conventus Connect networking - Terún Pizza, Palo Alto", "Call with Dean Higa".
- start/end: RFC3339 with the ${offset} offset, e.g. 2026-09-17T18:00:00${offset}. No end time given → start + 1 hour. If only a date is known and no time at all → allDay true with start/end as YYYY-MM-DD (end = the same day).
- location: street address if visible, else venue/city. null if none.
- description: any useful context (host, link, who invited him, what it's about). null if nothing.
- question: null when you are confident. Set it ONLY when the date or time is genuinely ambiguous (no date anywhere, two candidate times, the slot would be in the past) — one short question for Ryan. When question is set, still fill your best guess for the other fields.
Never invent a date or time that is not supported by the message or image.`
}

const EVENT_TOOL: Anthropic.Tool = {
  name: "record_event",
  description: "Record the single calendar event extracted from the message/screenshot.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      summary: { type: ["string", "null"] },
      start: { type: ["string", "null"] },
      end: { type: ["string", "null"] },
      allDay: { type: "boolean" },
      location: { type: ["string", "null"] },
      description: { type: ["string", "null"] },
      question: { type: ["string", "null"] },
    },
    required: ["summary", "start", "end", "allDay", "location", "description", "question"],
    additionalProperties: false,
  },
}

export async function extractEvent(args: {
  text: string
  image?: { base64: string; mediaType: ImageMediaType }
}): Promise<{ event?: ExtractedEvent; error?: string }> {
  if (!process.env.ANTHROPIC_API_KEY) return { error: "ANTHROPIC_API_KEY not set" }
  const client = new Anthropic()
  const content: Anthropic.ContentBlockParam[] = []
  if (args.image) {
    content.push({ type: "image", source: { type: "base64", media_type: args.image.mediaType, data: args.image.base64 } })
  }
  content.push({ type: "text", text: args.text.trim() ? `Ryan's message: "${args.text.trim()}"` : "(no caption — use the screenshot)" })
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      thinking: { type: "disabled" },
      system: systemPrompt(),
      tools: [EVENT_TOOL],
      tool_choice: { type: "tool", name: "record_event" },
      messages: [{ role: "user", content }],
    })
    if (response.stop_reason === "refusal") return { error: "model declined to read this" }
    const block = response.content.find((b) => b.type === "tool_use")
    if (!block || block.type !== "tool_use") return { error: "model returned no event" }
    const raw = block.input as Record<string, unknown>
    const str = (k: string) => (typeof raw[k] === "string" && (raw[k] as string).trim() ? (raw[k] as string).trim() : null)
    return {
      event: {
        summary: str("summary"),
        start: str("start"),
        end: str("end"),
        allDay: raw.allDay === true,
        location: str("location"),
        description: str("description"),
        question: str("question"),
      },
    }
  } catch (e) {
    return { error: `Claude API: ${e instanceof Error ? e.message : String(e)}` }
  }
}

export interface CreatedEvent {
  success: boolean
  error?: string
  htmlLink?: string
  summary?: string
  when?: string
}

/** Human "Thu, Sep 17, 6:00 PM – 9:00 PM" from the RFC3339 pair. */
export function formatWhen(ev: { start: string; end: string; allDay: boolean }): string {
  if (ev.allDay) {
    const d = new Date(`${ev.start}T12:00:00`)
    return `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} (all day)`
  }
  const s = new Date(ev.start), e = new Date(ev.end)
  const opts: Intl.DateTimeFormatOptions = { timeZone: "America/Los_Angeles" }
  const day = s.toLocaleDateString("en-US", { ...opts, weekday: "short", month: "short", day: "numeric" })
  const t = (d: Date) => d.toLocaleTimeString("en-US", { ...opts, hour: "numeric", minute: "2-digit" })
  return `${day}, ${t(s)} – ${t(e)}`
}

export async function createCalendarEvent(ev: ExtractedEvent): Promise<CreatedEvent> {
  if (!ev.summary || !ev.start || !ev.end) return { success: false, error: "missing title or time" }
  if (!ev.allDay && new Date(ev.start).getTime() < Date.now() - 5 * 60_000) {
    return { success: false, error: `that time is already past (${formatWhen({ start: ev.start, end: ev.end, allDay: false })})` }
  }
  try {
    const res = await fetch(`${SIDECAR_URL}/calendar/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: ev.summary, start: ev.start, end: ev.end, allDay: ev.allDay,
        location: ev.location, description: ev.description,
      }),
      signal: AbortSignal.timeout(25_000),
    })
    const data = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string; htmlLink?: string; summary?: string }
    if (!res.ok || !data.success) return { success: false, error: data.error || `sidecar ${res.status}` }
    return {
      success: true,
      htmlLink: data.htmlLink,
      summary: data.summary ?? ev.summary,
      when: formatWhen({ start: ev.start, end: ev.end, allDay: ev.allDay }),
    }
  } catch (e) {
    return { success: false, error: `sidecar unreachable: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** Does this caption/text read as a calendar request (vs. a contact add)? */
export const CALENDAR_INTENT_RE =
  /\b(calendar|cal:|schedule|event|invite|invited|meeting|showing|appointment|rsvp|put (this|it) on|add (this|it) to my cal)\b/i
