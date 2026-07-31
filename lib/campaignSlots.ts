// Send-time experiment slots (Ryan 2026-07-31). Every approval without an
// explicit hold-until time gets a uniformly random minute in the 7:00a to
// 4:59p PT window on the next weekday. Mirrors randomSendSlot() in
// scripts/campaign-engine.mjs (engine runs outside the Next.js bundle, so
// the ~30 lines are duplicated rather than shared — keep both in sync).

function ptParts(date: Date): Record<string, string> {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  })
  return Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]))
}

function ptSlotToUtcIso(y: number, m: number, d: number, hour: number, minute: number): string {
  for (const off of [7, 8]) {
    const t = new Date(Date.UTC(y, m - 1, d, hour + off, minute))
    const got =
      Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false }).format(t)) % 24
    if (got === hour) return t.toISOString()
  }
  return new Date(Date.UTC(y, m - 1, d, hour + 7, minute)).toISOString()
}

/** Random experiment slot: next weekday, 7:00a–4:59p PT. */
export function randomSendSlot(): string | null {
  const now = new Date()
  for (let add = 1; add <= 4; add++) {
    const parts = ptParts(new Date(now.getTime() + add * 86_400_000))
    if (parts.weekday === "Sat" || parts.weekday === "Sun") continue
    const minuteOfDay = 7 * 60 + Math.floor(Math.random() * 10 * 60)
    return ptSlotToUtcIso(Number(parts.year), Number(parts.month), Number(parts.day), Math.floor(minuteOfDay / 60), minuteOfDay % 60)
  }
  return null
}
