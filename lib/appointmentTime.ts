// The pure half of lib/appointments: the shape the call analyzer returns
// when a conversation ended in an agreed meeting, and Pacific wall-clock
// helpers. No imports, so lib/leads can use it without a cycle.

/** What the analyzer returns when a conversation ended in an agreed meeting. */
export interface AnalyzedAppointment {
  /** Pacific calendar day, YYYY-MM-DD. */
  date: string
  /** 24-hour HH:MM, Pacific. */
  time: string
  location: string | null
  with: string | null
  about: string | null
}

/** Coerce the analyzer's raw `appointment` value; null unless it carries a
 *  real day and time. */
export function parseAnalyzedAppointment(raw: unknown): AnalyzedAppointment | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const str = (k: string) => (typeof r[k] === "string" && (r[k] as string).trim() ? (r[k] as string).trim() : null)
  const date = str("date")
  const time = str("time")
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  if (!time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null
  return { date, time, location: str("location"), with: str("with"), about: str("about") }
}

/** A Pacific wall-clock day + time as RFC3339 with the right offset for that
 *  day (PST or PDT). */
export function pacificRfc3339(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null
  const guess = new Date(`${date}T${time}:00-08:00`)
  if (Number.isNaN(guess.getTime())) return null
  const zone = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "short" }).format(guess)
  return `${date}T${time}:00${/PDT/.test(zone) ? "-07:00" : "-08:00"}`
}

/** The Pacific calendar day of an RFC3339 instant. */
export function pacificDayOf(iso: string): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(d)
}
