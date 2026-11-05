// Ryan's calendar day, as YYYY-MM-DD. The UTC date turns over at 4–5pm
// Pacific, so a "call me tomorrow" texted at 6pm was dated a day late
// (2026-11-04). Follow-up dates and every "TODAY IS" line the models read
// use this, never toISOString().slice(0, 10).
const TZ = "America/Los_Angeles"

export function pacificDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(at)
}

/** Ryan's calendar day `days` from `at` (negative = earlier). */
export function pacificDatePlusDays(days: number, at: Date = new Date()): string {
  const d = new Date(`${pacificDate(at)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
