import type { CheckpointKind, Scenario, Weights } from "./types"

// The one-screen Telegram card (brief §3.5). Pure: HTML text + buttons.
// ≤12 lines: header · weights before → after · blank · Moved (+ bullets) ·
// Why · Opposite case · Resolved · Next. Buttons: Details (URL → /cycle)
// and Disagree (callback cycle:disagree:<checkpoint id> → force-reply).

export const CYCLE_DISAGREE_PREFIX = "cycle:disagree:"
export const MAX_CARD_LINES = 12
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

export const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim()
// Why / Opposite case are "≤2 lines" on a phone: clip, the full text lives on /cycle.
export const CLIP_CHARS = 240
const clip = (s: string) => (s.length > CLIP_CHARS ? s.slice(0, CLIP_CHARS - 1).trimEnd() + "…" : s)

/** "Jan 18, 2027" — always with the year. */
export function longDate(isoDay: string): string {
  const [y, m, d] = isoDay.slice(0, 10).split("-").map(Number)
  return `${MONTHS[m - 1]} ${d}, ${y}`
}

const CATEGORY_LABEL: Record<string, string> = {
  local_housing: "local housing",
  local_labor: "local labor",
  equities_ai: "AI",
  oil_inflation: "oil/inflation",
  us_housing: "US housing",
  rates: "rates",
  credit: "credit",
  macro: "macro",
  events: "events",
  structural: "structural",
}
export const categoryLabel = (c: string) => CATEGORY_LABEL[c] ?? c.replace(/_/g, " ")

const KIND_LABEL: Record<CheckpointKind, string> = {
  shakedown: "shakedown checkpoint",
  monthly: "checkpoint",
  quarterly: "quarterly checkpoint",
  tripwire: "out-of-cycle review",
}

export interface CardBullet {
  label: string // e.g. "SCC actives 1,987 (Sep 2026), 2.6σ over its band"
  category: string
  scenario: Scenario | "unexplained"
}

export interface CardInput {
  date: string
  kind: CheckpointKind
  before: Weights
  after: Weights
  bullets: CardBullet[]
  /** True when the weights changed; otherwise the bullets are "votes, no move". */
  moved: boolean
  why: string
  opposite: string
  resolved: string[] // e.g. "C5 ✅ (we said 75)"
  reprobs: string[] // e.g. "C9 45→35"
  next: string[] // e.g. "Jan 27, 2027 FOMC"
  checkpointId: string
  baseUrl: string
}

export interface CardButton {
  text: string
  url?: string
  callback_data?: string
}

export interface Card {
  text: string
  buttons: CardButton[][]
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function renderCard(c: CardInput): Card {
  const header = `📊 <b>Market cycle — ${esc(longDate(c.date))} ${esc(KIND_LABEL[c.kind])}</b>`
  const weights = (["bear", "base", "bull"] as const).map((s) => `${cap(s)} ${c.before[s]} → ${c.after[s]}`).join(" · ")
  const lines = [header, weights, ""]
  const fixedAfter = 4 // Why, Opposite, Resolved, Next
  const room = MAX_CARD_LINES - lines.length - 1 - fixedAfter // bullets under the Moved header
  if (c.bullets.length === 0) {
    lines.push(c.moved ? "<b>Moved</b>: claim resolution / tripwire only" : "<b>Moved</b>: nothing — no dial cleared the vote rules")
  } else {
    lines.push(c.moved ? "<b>Moved</b>" : "<b>Votes</b> (below the move gate — no move)")
    const shown = c.bullets.length > room ? c.bullets.slice(0, room - 1) : c.bullets
    for (const b of shown) lines.push(`• ${esc(oneLine(b.label))} (${esc(categoryLabel(b.category))} → ${esc(b.scenario)})`)
    if (shown.length < c.bullets.length) lines.push(`• +${c.bullets.length - shown.length} more on /cycle`)
  }
  lines.push(`<b>Why</b>: ${esc(clip(oneLine(c.why)) || "—")}`)
  lines.push(`<b>Opposite case</b>: ${esc(clip(oneLine(c.opposite)) || "—")}`)
  const res = c.resolved.length ? c.resolved.join(" · ") : "none"
  lines.push(`<b>Resolved</b>: ${esc(res)}${c.reprobs.length ? ` · re-probbed ${esc(c.reprobs.join(", "))}` : ""}`)
  lines.push(`<b>Next</b>: ${esc(c.next.slice(0, 3).join(" · ") || "—")}`)
  return {
    text: lines.join("\n"),
    buttons: [[
      { text: "📈 Details", url: `${c.baseUrl.replace(/\/$/, "")}/cycle` },
      { text: "✋ Disagree", callback_data: `${CYCLE_DISAGREE_PREFIX}${c.checkpointId}` },
    ]],
  }
}

export interface TripwireCardInput {
  what: string // e.g. "CCC OAS at/above 20% on a two-day close"
  reading: string // e.g. "20.4% (Mar 3, 2027)"
  baseUrl: string
}

/** Three lines: what crossed, the reading, "out-of-cycle review within 24h". */
export function renderTripwireCard(t: TripwireCardInput): Card {
  return {
    text: [`🚨 <b>Tripwire — ${esc(oneLine(t.what))}</b>`, `Reading: ${esc(oneLine(t.reading))}`, "Out-of-cycle review within 24h."].join("\n"),
    buttons: [[{ text: "📈 Details", url: `${t.baseUrl.replace(/\/$/, "")}/cycle` }]],
  }
}

export function cycleBaseUrl(): string {
  return process.env.MC_BASE_URL || "https://mission-control-three-chi.vercel.app"
}
