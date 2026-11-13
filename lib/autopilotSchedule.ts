// Autopilot schedule maths shared by the autopilot route (re-entry) and the
// Leads / Follow Ups cards (the "next text around …" line). Pure — no imports
// from lib/leads, because client components import this file.
//
// scripts/autopilot.js (SCHEDULE_DAYS, LAST_TOUCH, nextDue) is the source of
// truth for the cadence. These constants mirror it and must be kept in sync.

export const SCHEDULE_DAYS: Record<number, number> = { 1: 0, 2: 30, 3: 90, 4: 90, 5: 90, 6: 90, 7: 90, 8: 90 }
export const LAST_TOUCH = 8
// Coming BACK onto autopilot: wait this long after the person's last real
// contact (either direction) before the next check-in text.
export const REENTRY_DAYS = 30

const DAY = 86_400_000

export interface AutopilotRow {
  notes?: string | null
  lead_type?: string | null
  twilio_number?: string | null
  message?: string | null
  created_at?: string | null
}

export interface AutopilotStateRow {
  drip_touch_number?: number | null
  last_drip_sent_at?: string | null
  autopilot_since?: string | null
  autopilot_hold_until?: string | null
  autopilot_done_at?: string | null
  autopilot_next_at?: string | null
  created_at?: string | null
}

const TOUCH_RE = /\[autopilot #(\d)/

/** Highest autopilot text number the person has actually received (0 = none). */
export function receivedCount(rows: AutopilotRow[]): number {
  let max = 0
  for (const r of rows) {
    const m = TOUCH_RE.exec(r.notes ?? "")
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max
}

function isRealContact(r: AutopilotRow): boolean {
  const type = r.lead_type ?? ""
  if (TOUCH_RE.test(r.notes ?? "") || type.startsWith("drip_")) return true
  if (r.twilio_number) return true // inbound (drip_ handled above)
  // Ryan's outbound: only counts when something was actually said.
  return ["call", "sms", "imessage", "email"].includes(type) && !!(r.message ?? "").trim()
}

/** ISO time of the newest real contact in either direction, or null. */
export function lastContactAt(rows: AutopilotRow[]): string | null {
  let best = 0
  for (const r of rows) {
    if (!r.created_at || !isRealContact(r)) continue
    const t = new Date(r.created_at).getTime()
    if (t > best) best = t
  }
  return best ? new Date(best).toISOString() : null
}

export interface ReentryPlan {
  received: number
  finished: boolean
  /** null = first time on autopilot: text #1 goes out the next weekday afternoon. */
  nextAt: string | null
  lastTextAt: string | null
}

export function reentryPlan(rows: AutopilotRow[], now: Date): ReentryPlan {
  const received = receivedCount(rows)
  if (received === 0) return { received, finished: false, nextAt: null, lastTextAt: null }
  if (received >= LAST_TOUCH) return { received, finished: true, nextAt: null, lastTextAt: null }
  let lastTextAt: string | null = null
  let lastTextMs = 0
  for (const r of rows) {
    if (!r.created_at || !TOUCH_RE.test(r.notes ?? "")) continue
    const t = new Date(r.created_at).getTime()
    if (t > lastTextMs) { lastTextMs = t; lastTextAt = new Date(t).toISOString() }
  }
  const contact = lastContactAt(rows)
  const earliest = contact ? new Date(contact).getTime() + REENTRY_DAYS * DAY : 0
  return { received, finished: false, nextAt: new Date(Math.max(now.getTime(), earliest)).toISOString(), lastTextAt }
}

/** When the next autopilot text is due, for display. Mirrors nextDue() in scripts/autopilot.js. */
export function nextTextAt(row: AutopilotStateRow, now: Date = new Date()): { touch: number; at: Date } | null {
  void now // reserved for callers that want "overdue" handling; the date itself is not clamped
  const touch = (row.drip_touch_number ?? 0) + 1
  if (touch > LAST_TOUCH || row.autopilot_done_at) return null
  let at: number
  if (row.autopilot_next_at) at = new Date(row.autopilot_next_at).getTime()
  else {
    const anchor = row.last_drip_sent_at || row.autopilot_since || row.created_at
    if (!anchor) return null
    at = new Date(anchor).getTime() + SCHEDULE_DAYS[touch] * DAY
  }
  if (row.autopilot_hold_until) at = Math.max(at, new Date(row.autopilot_hold_until).getTime())
  return { touch, at: new Date(at) }
}
