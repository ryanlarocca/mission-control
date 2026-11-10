// Projects page (Mission Control 2.0, Part D, 2026-11-10) — the pure helpers
// the /projects page and the Today "Projects · last touched" card share:
// grouping, the "not touched in 30 days" flag, and sync freshness.
//
// Imported by the browser: nothing server-only here (no lib/leads).

import { pacificDate } from "@/lib/pacificDate"
import type { ProjectRow, ProjectStatus } from "@/lib/projectMemo"

export const STALE_ACTIVE_DAYS = 30
export const SYNC_STALE_HOURS = 36

/** The fields the list needs (GET /api/projects?view=summary returns only these). */
export type ProjectSummary = Pick<
  ProjectRow,
  "slug" | "name" | "status" | "status_line" | "plain" | "owns" | "updated_on" | "archived" | "synced_at"
> & Partial<Pick<ProjectRow, "left_off" | "ships">>

export const GROUP_ORDER: ProjectStatus[] = ["active", "planning", "parked", "retired"]
export const GROUP_LABEL: Record<ProjectStatus, string> = {
  active: "Active",
  planning: "Planning",
  parked: "Parked",
  retired: "Retired",
}

/** Most recently touched first; no date last; then by name. */
export function byTouched<T extends Pick<ProjectSummary, "updated_on" | "name">>(a: T, b: T): number {
  const ua = a.updated_on ?? ""
  const ub = b.updated_on ?? ""
  if (ua !== ub) return ua < ub ? 1 : -1
  return a.name.localeCompare(b.name)
}

/** Archived rows are retired whatever the status column says. */
export function groupOf(p: Pick<ProjectSummary, "status" | "archived">): ProjectStatus {
  return p.archived ? "retired" : GROUP_ORDER.includes(p.status) ? p.status : "planning"
}

export function groupProjects<T extends ProjectSummary>(rows: T[]): Record<ProjectStatus, T[]> {
  const out: Record<ProjectStatus, T[]> = { active: [], planning: [], parked: [], retired: [] }
  for (const r of rows) out[groupOf(r)].push(r)
  for (const k of GROUP_ORDER) out[k].sort(byTouched)
  return out
}

/** The one line under the name: plain sentence, else the status phrase, else what it owns. */
export function projectLine(p: Pick<ProjectSummary, "plain" | "status_line" | "owns">): string {
  return p.plain || p.status_line || p.owns || ""
}

/** Whole days from a YYYY-MM-DD to today (Pacific). */
export function daysSince(ymd: string, now: Date = new Date()): number {
  const [y, m, d] = ymd.split("-").map(Number)
  const [ty, tm, td] = pacificDate(now).split("-").map(Number)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(y, m - 1, d)) / 86_400_000)
}

/** An Active project nobody has touched in 30+ days (its date shows amber). */
export function isStaleActive(p: Pick<ProjectSummary, "status" | "archived" | "updated_on">, now: Date = new Date()): boolean {
  return groupOf(p) === "active" && !!p.updated_on && daysSince(p.updated_on, now) >= STALE_ACTIVE_DAYS
}

/** Newest synced_at across the rows (the sync writes them all at once). */
export function newestSync(rows: Pick<ProjectSummary, "synced_at">[]): string | null {
  let best: string | null = null
  let bestMs = -Infinity
  for (const r of rows) {
    const ms = Date.parse(r.synced_at)
    if (Number.isFinite(ms) && ms > bestMs) { bestMs = ms; best = r.synced_at }
  }
  return best
}

export function isSyncStale(iso: string | null, now: Date = new Date()): boolean {
  if (!iso) return false
  return now.getTime() - Date.parse(iso) > SYNC_STALE_HOURS * 3_600_000
}

/** "just now", "12 min ago", "3 h ago", "2 d ago". */
export function relativeAgo(iso: string, now: Date = new Date()): string {
  const mins = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000))
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

/** Header counts: "16 active · 1 planning · 2 parked". */
export function countsLine(groups: Record<ProjectStatus, unknown[]>): string {
  return `${groups.active.length} active · ${groups.planning.length} planning · ${groups.parked.length} parked`
}

/** Today's card: the five most recently touched projects that aren't retired. */
export function recentlyTouched<T extends ProjectSummary>(rows: T[], n = 5): T[] {
  return rows.filter((r) => groupOf(r) !== "retired").sort(byTouched).slice(0, n)
}
