import { THESIS, type ThesisConfig } from "./config"
import type { CalendarEntry, CheckpointKind, TripwireEvent } from "./types"

// When is a review due? (brief §3.3, thesis checkpoint_schedule). Pure.
//   • Shakedown: Mon 2026-12-14.
//   • First formal monthly: Mon 2027-01-18.
//   • From Feb 2027: the Monday after that month's CPI release in the data
//     calendar (strictly after: a Monday release → the next Monday);
//     fallback when no CPI date is loaded: the Monday on or after the 15th.
//   • Quarterly rewrite = the Feb / May / Aug / Nov checkpoint.
//   • Out of cycle: any tripwire event with review_requested and no reviewed_at.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}
function addDays(day: string, n: number): string {
  const d = new Date(day + "T00:00:00Z")
  d.setUTCDate(d.getUTCDate() + n)
  return iso(d)
}
function weekday(day: string): number {
  return new Date(day + "T00:00:00Z").getUTCDay() // 0 = Sun, 1 = Mon
}

export function mondayAfter(day: string): string {
  const wd = weekday(day)
  return addDays(day, wd === 0 ? 1 : 8 - wd)
}
export function mondayOnOrAfter(day: string): string {
  const wd = weekday(day)
  return wd === 1 ? day : addDays(day, wd === 0 ? 1 : 8 - wd)
}

export function isCpiEntry(e: CalendarEntry): boolean {
  return e.dial_id === "cpi_yoy" || /\bCPI\b/.test(e.label)
}

/** CPI release date for a YYYY-MM month, from the data calendar. */
export function cpiReleaseInMonth(ym: string, calendar: CalendarEntry[]): string | null {
  const hits = calendar.filter((e) => e.date && e.date.startsWith(ym) && isCpiEntry(e)).map((e) => e.date as string).sort()
  return hits[0] ?? null
}

export function isQuarterlyMonth(ym: string, cfg: ThesisConfig = THESIS): boolean {
  return cfg.checkpoint_schedule.quarterly_rewrite_months.includes(MONTHS[Number(ym.slice(5, 7)) - 1])
}

/** The scheduled checkpoint date in a month (YYYY-MM), or null before formal reviews start. */
export function scheduledCheckpointInMonth(ym: string, calendar: CalendarEntry[], cfg: ThesisConfig = THESIS): { date: string; kind: CheckpointKind } | null {
  const sched = cfg.checkpoint_schedule
  if (sched.shakedown.startsWith(ym)) return { date: sched.shakedown, kind: "shakedown" }
  if (ym < sched.first_formal.slice(0, 7)) return null
  if (sched.first_formal.startsWith(ym)) return { date: sched.first_formal, kind: isQuarterlyMonth(ym, cfg) ? "quarterly" : "monthly" }
  const cpi = cpiReleaseInMonth(ym, calendar)
  const date = cpi ? mondayAfter(cpi) : mondayOnOrAfter(`${ym}-15`)
  return { date, kind: isQuarterlyMonth(ym, cfg) ? "quarterly" : "monthly" }
}

export function pendingTripwires(events: TripwireEvent[]): TripwireEvent[] {
  return events.filter((e) => e.review_requested && !e.reviewed_at)
}

export interface DueResult {
  due: boolean
  kind: CheckpointKind | null
  scheduled: { date: string; kind: CheckpointKind } | null
  tripwirePending: boolean
  reason: string
}

/** Is a checkpoint due today? A scheduled review wins the kind when both
 *  apply (the pending tripwire still lifts the cap and gets marked reviewed). */
export function checkpointDue(today: string, calendar: CalendarEntry[], events: TripwireEvent[], cfg: ThesisConfig = THESIS): DueResult {
  const scheduled = scheduledCheckpointInMonth(today.slice(0, 7), calendar, cfg)
  const pending = pendingTripwires(events)
  const tripwirePending = pending.length > 0
  if (scheduled && scheduled.date === today) {
    return { due: true, kind: scheduled.kind, scheduled, tripwirePending, reason: `scheduled ${scheduled.kind} checkpoint${tripwirePending ? ` (+${pending.length} pending tripwire)` : ""}` }
  }
  if (tripwirePending) {
    return { due: true, kind: "tripwire", scheduled, tripwirePending, reason: `out-of-cycle: ${pending.map((e) => e.tripwire_id).join(", ")}` }
  }
  return { due: false, kind: null, scheduled, tripwirePending, reason: scheduled ? `next scheduled ${scheduled.kind} is ${scheduled.date}` : "no checkpoint this month" }
}

/** The next scheduled checkpoint strictly after `today` (for the card's Next line). */
export function nextCheckpoint(today: string, calendar: CalendarEntry[], cfg: ThesisConfig = THESIS): { date: string; kind: CheckpointKind } | null {
  for (let i = 0; i < 14; i++) {
    const d = new Date(today.slice(0, 7) + "-01T00:00:00Z")
    d.setUTCMonth(d.getUTCMonth() + i)
    const s = scheduledCheckpointInMonth(iso(d).slice(0, 7), calendar, cfg)
    if (s && s.date > today) return s
  }
  return null
}
