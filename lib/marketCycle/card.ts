import type { CheckpointKind, Scenario, Weights } from "./types"

// The one-screen Telegram card (brief v2, Nov 7, 2026). Pure: HTML text + buttons.
// Plain English (Ryan: the Nov 2 card's "z=2.62", "@ 2026-09-01" and
// "re-probbed C18" read as slop). Header, then one block per bet — odds,
// where it stands now, why, the case against — then claims settled, claims
// re-weighed, next dates. The dial-by-dial detail lives on /cycle.
// Buttons: Details (URL → /cycle) and Disagree (callback
// cycle:disagree:<checkpoint id> → force-reply).

export const CYCLE_DISAGREE_PREFIX = "cycle:disagree:"
export const MAX_CARD_LINES = 16
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
  shakedown: "shakedown review",
  monthly: "review",
  quarterly: "quarterly review",
  tripwire: "out-of-cycle review",
}

export interface CardBullet {
  label: string // e.g. "Homes for sale 1,970 (Oct 2026), about 50% above normal"
  category: string
  scenario: Scenario | "unexplained"
}

/** One bet's block on the card. */
export interface CardBet {
  emoji: string
  name: string
  before: Weights
  after: Weights
  /** "3.4% below the Jan 2025 peak (Sep 2026)" */
  now: string | null
  why: string
  against: string
}

export interface CardInput {
  date: string
  kind: CheckpointKind
  bets: CardBet[]
  /** Claims settled this review, plain English: "S&P new high by end of 2028 ✅ (we said 60%)" */
  settled: string[]
  /** "Inventory up 25% by Mar 2027: 55% → 65%" */
  reprobs: string[]
  next: string[] // e.g. "~Jan 18, 2027 review"
  checkpointId: string
  baseUrl: string
  /** A preview send: labelled, nothing stored, no Disagree button. */
  preview?: boolean
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
const SC = ["bear", "base", "bull"] as const

/** "Bear 35 → 40 · Base 45 · Bull 20 → 15", or "… (no change)". */
export function oddsLine(before: Weights, after: Weights): string {
  const same = SC.every((s) => before[s] === after[s])
  return SC.map((s) => (before[s] === after[s] ? `${cap(s)} ${after[s]}` : `${cap(s)} ${before[s]} → ${after[s]}`)).join(" · ") + (same ? " (no change)" : "")
}

/** Telegram's hard limit is 4096 characters; stay well under. */
export const MAX_CARD_CHARS = 3500

export function renderCard(c: CardInput): Card {
  const lines: string[] = []
  if (c.preview) lines.push("🧪 <b>PREVIEW — nothing saved, odds not changed</b>")
  lines.push(`📊 <b>Market cycle — ${esc(longDate(c.date))} ${esc(KIND_LABEL[c.kind])}</b>`)
  for (const b of c.bets) {
    lines.push("")
    lines.push(`${b.emoji} <b>${esc(b.name)}</b>: ${esc(oddsLine(b.before, b.after))}`)
    if (b.now) lines.push(`Now: ${esc(oneLine(b.now))}`)
    lines.push(`<b>Why</b>: ${esc(clip(oneLine(b.why)) || "—")}`)
    lines.push(`<b>Against</b>: ${esc(clip(oneLine(b.against)) || "—")}`)
  }
  lines.push("")
  if (c.settled.length) lines.push(`<b>Settled</b>: ${esc(c.settled.slice(0, 4).join(" · "))}${c.settled.length > 4 ? ` · +${c.settled.length - 4} more` : ""}`)
  if (c.reprobs.length) lines.push(`<b>Re-weighed</b>: ${esc(c.reprobs.slice(0, 3).join(" · "))}${c.reprobs.length > 3 ? ` · +${c.reprobs.length - 3} more` : ""}`)
  lines.push(`<b>Next</b>: ${esc(c.next.slice(0, 3).join(" · ") || "—")}`)
  let text = lines.join("\n")
  if (text.length > MAX_CARD_CHARS) text = text.slice(0, MAX_CARD_CHARS - 1) + "…"
  const details = { text: "📈 Details", url: `${c.baseUrl.replace(/\/$/, "")}/cycle` }
  return {
    text,
    buttons: c.preview ? [[details]] : [[details, { text: "✋ Disagree", callback_data: `${CYCLE_DISAGREE_PREFIX}${c.checkpointId}` }]],
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
