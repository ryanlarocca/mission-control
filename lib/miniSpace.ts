// Mac mini low-space levels for /api/mini/watch (pure, testable).
// Low disk (2026-11-09): enter a level below the first number, leave it above
// the second, so free space wobbling around a line doesn't page twice.
export const GB_KB = 1024 * 1024 // 1 GB in KB
const GB = GB_KB
const WARN = { enter: 25 * GB, leave: 30 * GB }
const URGENT = { enter: 10 * GB, leave: 15 * GB }

export type SpaceLevel = "warn" | "urgent" | null

/** Pure: the level free space is at, given the level already alerted. */
export function spaceLevel(freeKb: number | null, current: SpaceLevel): SpaceLevel {
  if (freeKb == null) return current
  if (freeKb < URGENT.enter) return "urgent"
  if (current === "urgent" && freeKb < URGENT.leave) return "urgent"
  if (freeKb < WARN.enter) return "warn"
  if ((current === "warn" || current === "urgent") && freeKb < WARN.leave) return "warn"
  return null
}
