import { THESIS, type ThesisConfig } from "./config"
import type { CalendarEntry, CheckpointKind, Reading, TripwireEvent } from "./types"

// When is a review due? (brief v2 §2 D8, Ryan 2026-11-07). Pure.
//   • A scheduled review per month from the shakedown month (Dec 2026) on:
//     shakedown in Dec 2026, quarterly rewrite in Feb / May / Aug / Nov,
//     monthly otherwise.
//   • Data-ready, not calendar-fixed: it runs on the first Monday on/after the
//     15th once BOTH last month's CPI print and last month's Zillow (ZHVI)
//     print are stored — read from the readings themselves, not a release
//     calendar, so a late print simply waits.
//   • Never right before a Fed decision: a day with an FOMC decision on it or
//     in the next 3 days is skipped (so the review lands a week later).
//   • Fallback: from the last Monday of the month it runs whatever has
//     arrived, any day, so a month can't be skipped (a missed daily run is
//     caught up the next day).
//   • Once per month: a stored shakedown/monthly/quarterly checkpoint in the
//     month means nothing more is due.
//   • Out of cycle: any tripwire event with review_requested and no reviewed_at.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const FOMC_LOOKAHEAD_DAYS = 3
/** The prints a scheduled review waits for (last month's, by as_of month). */
export const READY_DIALS = ["cpi_yoy", "zhvi_scc"] as const

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
function addMonths(ym: string, n: number): string {
  const d = new Date(ym + "-01T00:00:00Z")
  d.setUTCMonth(d.getUTCMonth() + n)
  return iso(d).slice(0, 7)
}

export function mondayAfter(day: string): string {
  const wd = weekday(day)
  return addDays(day, wd === 0 ? 1 : 8 - wd)
}
export function mondayOnOrAfter(day: string): string {
  const wd = weekday(day)
  return wd === 1 ? day : addDays(day, wd === 0 ? 1 : 8 - wd)
}
export function isMonday(day: string): boolean {
  return weekday(day) === 1
}
export function lastMondayOf(ym: string): string {
  const last = addDays(addMonths(ym, 1) + "-01", -1)
  const wd = weekday(last)
  return addDays(last, -((wd + 6) % 7))
}
/** The earliest a month's review can run: the first Monday on/after the 15th. */
export function plannedDate(ym: string): string {
  return mondayOnOrAfter(`${ym}-15`)
}

export function isCpiEntry(e: CalendarEntry): boolean {
  return e.dial_id === "cpi_yoy" || /\bCPI\b/.test(e.label)
}
export function isFomcEntry(e: CalendarEntry): boolean {
  return e.dial_id === "fomc_decision" || /\bFOMC\b/.test(e.label)
}

/** CPI release date for a YYYY-MM month, from the data calendar (display only). */
export function cpiReleaseInMonth(ym: string, calendar: CalendarEntry[]): string | null {
  const hits = calendar.filter((e) => e.date && e.date.startsWith(ym) && isCpiEntry(e)).map((e) => e.date as string).sort()
  return hits[0] ?? null
}

/** An FOMC decision today or in the next 3 days. */
export function fomcSoon(day: string, calendar: CalendarEntry[]): string | null {
  const end = addDays(day, FOMC_LOOKAHEAD_DAYS)
  const hit = calendar.filter((e) => isFomcEntry(e) && e.date && e.date >= day && e.date <= end).map((e) => e.date as string).sort()
  return hit[0] ?? null
}

/** Has last month's print of each READY_DIAL arrived? */
export function dataReady(ym: string, readings: Record<string, Reading[]>): { ready: boolean; missing: string[] } {
  const prior = addMonths(ym, -1)
  const missing = READY_DIALS.filter((id) => !(readings[id] ?? []).some((r) => r.value !== null && r.as_of.slice(0, 7) >= prior))
  return { ready: missing.length === 0, missing: [...missing] }
}

export function isQuarterlyMonth(ym: string, cfg: ThesisConfig = THESIS): boolean {
  return cfg.checkpoint_schedule.quarterly_rewrite_months.includes(MONTHS[Number(ym.slice(5, 7)) - 1])
}

/** The kind of scheduled review a month gets, or null before the shakedown month. */
export function scheduledKind(ym: string, cfg: ThesisConfig = THESIS): CheckpointKind | null {
  const first = cfg.checkpoint_schedule.shakedown.slice(0, 7)
  if (ym < first) return null
  if (ym === first) return "shakedown"
  return isQuarterlyMonth(ym, cfg) ? "quarterly" : "monthly"
}

/** Expected date of a month's review assuming the prints arrive on time:
 *  the planned Monday, pushed a week at a time past any FOMC decision. */
export function scheduledCheckpointInMonth(ym: string, calendar: CalendarEntry[], cfg: ThesisConfig = THESIS): { date: string; kind: CheckpointKind } | null {
  const kind = scheduledKind(ym, cfg)
  if (!kind) return null
  let day = plannedDate(ym)
  const last = lastMondayOf(ym)
  while (day < last && fomcSoon(day, calendar)) day = addDays(day, 7)
  if (day >= last) {
    day = last
    const f = fomcSoon(day, calendar)
    if (f) day = addDays(f, 1)
  }
  return { date: day, kind }
}

export function pendingTripwires(events: TripwireEvent[]): TripwireEvent[] {
  return events.filter((e) => e.review_requested && !e.reviewed_at)
}

export interface ScheduleInputs {
  calendar: CalendarEntry[]
  /** Stored readings (at least cpi_yoy and zhvi_scc) — the data-ready check. */
  readings: Record<string, Reading[]>
  /** Stored checkpoints (date + kind) — once per month. */
  checkpoints: { date: string; kind: CheckpointKind }[]
}

export interface DueResult {
  due: boolean
  kind: CheckpointKind | null
  scheduled: { date: string; kind: CheckpointKind } | null
  tripwirePending: boolean
  reason: string
}

function scheduledDone(ym: string, checkpoints: { date: string; kind: CheckpointKind }[]): boolean {
  return checkpoints.some((c) => c.date.startsWith(ym) && c.kind !== "tripwire")
}

/** Is a checkpoint due today? A scheduled review wins the kind when both
 *  apply (the pending tripwire still lifts the cap and gets marked reviewed). */
export function checkpointDue(today: string, inputs: ScheduleInputs, events: TripwireEvent[], cfg: ThesisConfig = THESIS): DueResult {
  const ym = today.slice(0, 7)
  const scheduled = scheduledCheckpointInMonth(ym, inputs.calendar, cfg)
  const pending = pendingTripwires(events)
  const tripwirePending = pending.length > 0
  const tw = tripwirePending ? ` (+${pending.length} pending tripwire)` : ""
  let why = scheduled ? `next scheduled ${scheduled.kind} ~${scheduled.date}` : "no checkpoint this month"
  if (scheduled && !scheduledDone(ym, inputs.checkpoints) && today >= plannedDate(ym)) {
    const fomc = fomcSoon(today, inputs.calendar)
    const { ready, missing } = dataReady(ym, inputs.readings)
    const fallback = today >= lastMondayOf(ym)
    if (fomc) why = `${scheduled.kind} waits: FOMC decision ${fomc}`
    else if (fallback) {
      return { due: true, kind: scheduled.kind, scheduled, tripwirePending, reason: `scheduled ${scheduled.kind} checkpoint (last-Monday fallback${ready ? "" : `; still missing ${missing.join(", ")}`})${tw}` }
    } else if (!ready) why = `${scheduled.kind} waits for last month's ${missing.join(" + ")} print`
    else if (isMonday(today)) return { due: true, kind: scheduled.kind, scheduled, tripwirePending, reason: `scheduled ${scheduled.kind} checkpoint${tw}` }
    else why = `${scheduled.kind} data is in; runs next Monday`
  } else if (scheduled && scheduledDone(ym, inputs.checkpoints)) why = `${scheduled.kind} for ${ym} already done`
  if (tripwirePending) {
    return { due: true, kind: "tripwire", scheduled, tripwirePending, reason: `out-of-cycle: ${pending.map((e) => e.tripwire_id).join(", ")}` }
  }
  return { due: false, kind: null, scheduled, tripwirePending, reason: why }
}

/** The next scheduled review strictly after `today` that hasn't happened
 *  (for the card's Next line and the page header). The date is an estimate
 *  — the review waits for the data — so callers show it as "~date". */
export function nextCheckpoint(today: string, inputs: Pick<ScheduleInputs, "calendar" | "checkpoints">, cfg: ThesisConfig = THESIS): { date: string; kind: CheckpointKind } | null {
  for (let i = 0; i < 14; i++) {
    const ym = addMonths(today.slice(0, 7), i)
    if (scheduledDone(ym, inputs.checkpoints)) continue
    const s = scheduledCheckpointInMonth(ym, inputs.calendar, cfg)
    if (!s) continue
    if (s.date > today) return s
    // this month's review is late (waiting on a print): the next possible day
    const next = addDays(today, 1)
    if (next.slice(0, 7) === ym) {
      const mon = mondayOnOrAfter(next)
      return { date: mon <= lastMondayOf(ym) ? mon : next, kind: s.kind }
    }
  }
  return null
}
