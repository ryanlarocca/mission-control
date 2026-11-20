// Display helpers for The Board page (components/board/*). Data rules live in
// lib/boardItems.ts; this file is only colors, labels and the page's CSS.

import { dueTone, type BoardItem, type BoardLane } from "@/lib/boardItems"

export const LANE_DOT: Record<BoardLane | "done", string> = {
  you: "#f05252",
  waiting: "#f5b942",
  me: "#2dd4bf",
  done: "#4b5a7a",
}

const NEUTRAL_CHIP = "bg-signal-card2 text-signal-muted"
const RED_CHIP = "bg-signal-bad/[.13] text-[#ff8a8a]"
const AMBER_CHIP = "bg-[#f5b942]/[.12] text-[#f5b942]"

/**
 * Date chip color. Overdue is red everywhere; "today" is red on Ryan's own
 * lane and amber on the others (the approved mockup: a same-day item that
 * someone else or Claude is holding isn't his fire). Within 3 days = amber.
 */
export function dueChipClass(item: BoardItem, today: string): string {
  const tone = dueTone(item.due_date, today)
  if (tone === "overdue") return RED_CHIP
  if (tone === "today") return item.lane === "you" ? RED_CHIP : AMBER_CHIP
  if (tone === "soon") return AMBER_CHIP
  return NEUTRAL_CHIP
}

const TAG_TEAL = "bg-signal-accent/10 text-signal-accent"
const TAG_VIOLET = "bg-[#a78bfa]/[.12] text-[#a78bfa]"
const TAG_BLUE = "bg-[#60a5fa]/[.12] text-[#60a5fa]"
const TAG_PINK = "bg-[#f472b6]/[.12] text-[#f472b6]"
const TAG_RED = "bg-signal-bad/[.13] text-[#ff8a8a]"
const TAG_GREEN = "bg-[#4ade80]/[.12] text-[#4ade80]"
const TAG_AMBER = "bg-[#f5b942]/[.12] text-[#f5b942]"

const TAG_COLORS: Record<string, string> = {
  deal: TAG_TEAL,
  mail: TAG_AMBER,
  taxes: TAG_VIOLET,
  tax: TAG_VIOLET,
  money: TAG_VIOLET,
  admin: TAG_BLUE,
  sub: TAG_BLUE,
  build: TAG_BLUE,
  email: TAG_BLUE,
  video: TAG_PINK,
  legal: TAG_RED,
  health: TAG_GREEN,
  personal: TAG_AMBER,
}

/** Known BOARD_TAGS get a color (case-insensitive, plural-tolerant); anything else is neutral. */
export function tagChipClass(tag: string): string {
  const k = tag.trim().toLowerCase()
  return TAG_COLORS[k] ?? TAG_COLORS[k.replace(/s$/, "")] ?? NEUTRAL_CHIP
}

const PT = "America/Los_Angeles"

/** Chip on a done card: "Today", "Yesterday", or the weekday it was finished (Pacific). */
export function doneLabel(doneAt: string | null, today: string): string | null {
  if (!doneAt) return null
  const d = new Date(doneAt)
  if (Number.isNaN(d.getTime())) return null
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: PT }).format(d)
  if (ymd === today) return "Today"
  const diff = Math.round((Date.parse(today + "T12:00:00Z") - Date.parse(ymd + "T12:00:00Z")) / 86_400_000)
  if (diff === 1) return "Yesterday"
  if (diff < 7) return d.toLocaleDateString("en-US", { weekday: "short", timeZone: PT })
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: PT })
}

/** "Fri Nov 20" in Pacific time. */
export function headerDate(now: Date): string {
  return now
    .toLocaleDateString("en-US", { timeZone: PT, weekday: "short", month: "short", day: "numeric" })
    .replace(",", "")
}

/** "1:12 PM" local clock, for the diagnostics footer. */
export function clockTime(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
}

/** A link typed without a scheme ("drive.google.com/…") still opens. */
export function linkHref(link: string): string {
  const l = link.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(l) || l.startsWith("/")) return l
  return `https://${l}`
}

/** Done cards, newest finish first. */
export function sortDone(a: BoardItem, b: BoardItem): number {
  return (b.done_at ?? "").localeCompare(a.done_at ?? "")
}

// Keyframes + transitions for the page. Tailwind config / globals.css are
// shared files, so the Board ships its own small stylesheet.
export const BOARD_CSS = `
@keyframes boardIn { from { opacity: 0; transform: translateY(-6px) } to { opacity: 1; transform: none } }
@keyframes boardPop { 0% { transform: scale(.55) } 60% { transform: scale(1.14) } 100% { transform: scale(1) } }
@keyframes boardSheetUp { from { transform: translateY(100%) } to { transform: none } }
@keyframes boardModalIn { from { opacity: 0; transform: translateY(10px) scale(.98) } to { opacity: 1; transform: none } }
@keyframes boardFade { from { opacity: 0 } to { opacity: 1 } }
@keyframes boardToastIn { from { opacity: 0; transform: translateY(12px) } to { opacity: 1; transform: none } }
.board-in { animation: boardIn .3s ease-out both }
.board-pop { animation: boardPop .32s cubic-bezier(.2,.9,.3,1.3) }
.board-collapse { transition: grid-template-rows .3s cubic-bezier(.2,.8,.2,1), opacity .22s ease-out }
.board-dim { transition: opacity .2s ease-out }
.board-backdrop { animation: boardFade .2s ease-out both }
.board-sheet { animation: boardSheetUp .3s cubic-bezier(.2,.8,.2,1) both }
.board-toast { animation: boardToastIn .22s ease-out both }
@media (min-width: 768px) { .board-sheet { animation: boardModalIn .2s ease-out both } }
@media (prefers-reduced-motion: reduce) {
  .board-in, .board-pop, .board-backdrop, .board-sheet, .board-toast { animation: none !important }
  .board-collapse, .board-dim { transition: none !important }
}
`
