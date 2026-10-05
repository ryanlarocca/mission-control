// Shared date display formatters for the CRMS UI.
//
// Every human-readable date in the dashboard includes the year. Leads and
// relationships carry years of history, so "Dec 15" on a voicemail is
// ambiguous — Ryan asked for the year everywhere (2026-10-05).
//
// Client-safe: no server imports. Formats in the viewer's local timezone
// unless `timeZone` is passed (server-side callers pass "America/Los_Angeles").

const DATE_OPTS: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" }
const TIME_OPTS: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" }

function toDate(input: string | number | Date): Date {
  return input instanceof Date ? input : new Date(input)
}

/** "Dec 15, 2025". Bare YYYY-MM-DD strings are read as local calendar dates, not UTC. */
export function formatDate(
  input: string | number | Date | null | undefined,
  opts: Intl.DateTimeFormatOptions = {},
): string {
  if (input == null || input === "") return "—"
  const d = typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input)
    ? new Date(`${input}T00:00:00`)
    : toDate(input)
  if (isNaN(d.getTime())) return typeof input === "string" ? input : "—"
  return d.toLocaleDateString("en-US", { ...DATE_OPTS, ...opts })
}

/** "Dec 15, 2025, 9:58 AM". */
export function formatDateTime(
  input: string | number | Date | null | undefined,
  opts: Intl.DateTimeFormatOptions = {},
): string {
  if (input == null || input === "") return "—"
  const d = toDate(input)
  if (isNaN(d.getTime())) return typeof input === "string" ? input : "—"
  return d.toLocaleString("en-US", { ...DATE_OPTS, ...TIME_OPTS, ...opts })
}
