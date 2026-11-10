// Health page (Mission Control 2.0, Part E — v1, 2026-11-10): the payload
// GET /api/health returns, and the pure functions that turn it into plain
// sentences with a ✓ / ! mark per card. Shared by the page, the route
// (lib/healthData.ts) and tests/health.unit.test.ts.
//
// Imported by the browser: NOTHING server-only may be imported here (no
// lib/leads, no lib/jackie, no Supabase client).

import { SPEND_TARGET_USD, MINI_QUIET_MS, WATCHDOG_QUIET_MS, fmtDate, fmtTime, isFresh, judgeRanToday } from "@/lib/today"
import { featureName, laneLabel } from "@/lib/llmFeatures"
import { LOGIN_WARN_DAYS, backupOk, type MiniJob, type MiniSnapshot } from "@/lib/miniStatus"

/** The mini reports every 5 minutes; older than this and the page says so. */
export const SNAPSHOT_STALE_MS = 15 * 60_000

// ── payload ─────────────────────────────────────────────────────────────────

export interface HealthSpend {
  monthUsd: number
  yesterdayUsd: number
  targetUsd: number
  monthPct: number        // 0–100, capped
  monthLabel: string      // "Nov"
  lanes: { key: string; label: string; monthUsd: number; yesterdayUsd: number }[]
  top: { name: string; usd: number; calls: number }[]   // this month, biggest first, ≤ 5
}

export interface HealthPayload {
  generatedAt: string
  heartbeat: { beatAt: string | null; watchdogAt: string | null; freeGb: number | null; lowSpace: boolean } | null
  /** mini_status row 'mini'; null when there is no row yet (or the table is missing — see errors.status). */
  status: { reportedAt: string; snapshot: MiniSnapshot } | null
  judge: { at: string | null } | null
  jackie: { on: boolean; since: string | null; callsWeek: number } | null
  spend: HealthSpend | null
  errors: Record<string, string>
}

// ── AI spend shaping ────────────────────────────────────────────────────────

export interface RollupRow {
  lane: string | null
  tag: string | null
  calls?: number | string | null
  cost_usd: number | string | null
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** llm_usage_rollup() rows for the month and for yesterday → totals by key + top five features. */
export function shapeHealthSpend(month: RollupRow[], yesterday: RollupRow[], monthLabel: string, targetUsd: number = SPEND_TARGET_USD): HealthSpend {
  const lanes = new Map<string, { monthUsd: number; yesterdayUsd: number }>()
  for (const k of ["drafts", "background"]) lanes.set(k, { monthUsd: 0, yesterdayUsd: 0 })
  const features = new Map<string, { usd: number; calls: number }>()
  let monthUsd = 0
  let yesterdayUsd = 0
  for (const r of month) {
    const c = Number(r.cost_usd) || 0
    monthUsd += c
    const k = r.lane || "other"
    const l = lanes.get(k) ?? { monthUsd: 0, yesterdayUsd: 0 }
    l.monthUsd += c
    lanes.set(k, l)
    const name = featureName(r.tag)
    const f = features.get(name) ?? { usd: 0, calls: 0 }
    f.usd += c
    f.calls += Number(r.calls) || 0
    features.set(name, f)
  }
  for (const r of yesterday) {
    const c = Number(r.cost_usd) || 0
    yesterdayUsd += c
    const k = r.lane || "other"
    const l = lanes.get(k) ?? { monthUsd: 0, yesterdayUsd: 0 }
    l.yesterdayUsd += c
    lanes.set(k, l)
  }
  return {
    monthUsd: round2(monthUsd),
    yesterdayUsd: round2(yesterdayUsd),
    targetUsd,
    monthPct: targetUsd > 0 ? Math.min(100, Math.max(0, (monthUsd / targetUsd) * 100)) : 0,
    monthLabel,
    lanes: Array.from(lanes.entries()).map(([key, v]) => ({ key, label: laneLabel(key), monthUsd: round2(v.monthUsd), yesterdayUsd: round2(v.yesterdayUsd) })),
    top: Array.from(features.entries())
      .map(([name, v]) => ({ name, usd: round2(v.usd), calls: v.calls }))
      .filter((f) => f.usd >= 0.005)
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 5),
  }
}

// ── words ───────────────────────────────────────────────────────────────────

/** "40 sec ago", "12 min ago", "5 h ago", "3 d ago". */
export function agoWords(iso: string, now: Date = new Date()): string {
  const sec = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000))
  if (sec < 60) return `${sec} sec ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

/** "Nov 9, 2026, 3:10 AM" (Pacific). */
export function fmtDateTime(iso: string): string {
  return `${fmtDate(iso)}, ${fmtTime(iso)}`
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// ── view model ──────────────────────────────────────────────────────────────

export type Mark = "ok" | "warn" | "unknown"
export interface Line { text: string; warn?: boolean }
export interface CardView { key: string; title: string; mark: Mark; lines: Line[] }

export interface HealthView {
  problems: number
  verdict: string
  checked: Line
  cards: CardView[]                 // Mac mini, Phone bridge, Relationships helper, Judge, Jackie
  spend: { mark: Mark; data: HealthSpend | null; error: boolean }
  jobs: { mark: Mark; summary: string; items: MiniJob[] } | null
}

const COULDNT: Line = { text: "Couldn't load this right now.", warn: true }
const WAITING: Line = { text: "Waiting for the mini's first report." }

function markOf(lines: Line[], fallback: Mark = "ok"): Mark {
  return lines.some((l) => l.warn) ? "warn" : fallback
}

/** Problems first, then by name. */
export function sortJobs(jobs: MiniJob[]): MiniJob[] {
  return [...jobs].sort((a, b) => Number(a.ok) - Number(b.ok) || a.name.localeCompare(b.name))
}

export function buildHealthView(p: HealthPayload, now: Date = new Date()): HealthView {
  const snap = p.status?.snapshot ?? null
  const reportedAt = p.status?.reportedAt ?? null
  const snapStale = !reportedAt || now.getTime() - Date.parse(reportedAt) > SNAPSHOT_STALE_MS

  // Checked line (counts as one problem when the mini has gone quiet).
  const checked: Line = !reportedAt
    ? { text: "The mini hasn't reported yet.", warn: true }
    : snapStale
      ? { text: `The mini hasn't reported since ${fmtDateTime(reportedAt)}.`, warn: true }
      : { text: `Checked ${agoWords(reportedAt, now)}` }

  const cards: CardView[] = []

  // Mac mini
  {
    const lines: Line[] = []
    const hb = p.heartbeat
    if (!hb && p.errors.heartbeat) lines.push(COULDNT)
    else if (hb?.beatAt) {
      lines.push(isFresh(hb.beatAt, MINI_QUIET_MS, now)
        ? { text: `Checked in ${agoWords(hb.beatAt, now)}` }
        : { text: `Hasn't checked in since ${fmtDateTime(hb.beatAt)}`, warn: true })
    } else lines.push({ text: "Hasn't checked in yet", warn: true })
    if (snap?.uptime?.bootAt) lines.push({ text: `Up since ${fmtDate(snap.uptime.bootAt)}` })
    const freeGb = hb?.freeGb ?? (snap?.disk ? Math.round(snap.disk.freeGb) : null)
    if (freeGb != null) lines.push(hb?.lowSpace ? { text: `Only ${freeGb} GB free — getting full`, warn: true } : { text: `${freeGb} GB free` })
    if (snap) {
      const b = snap.backup
      if (!b?.lastAt) lines.push({ text: "No backup has finished yet", warn: true })
      else if (backupOk(b, now)) lines.push({ text: `Last backup ${fmtDateTime(b.lastAt)}` })
      else if (b.failedSince) lines.push({ text: `Last backup ${fmtDateTime(b.lastAt)} — the backup after it failed`, warn: true })
      else lines.push({ text: `Last backup ${fmtDateTime(b.lastAt)} — none since`, warn: true })
    }
    cards.push({ key: "mini", title: "Mac mini", mark: markOf(lines), lines })
  }

  // Phone bridge
  {
    const lines: Line[] = []
    let fallback: Mark = "ok"
    const b = snap?.bridge ?? null
    if (!snap) { lines.push(WAITING); fallback = "unknown" }
    else if (!b) lines.push({ text: "Couldn't read the bridge's status", warn: true })
    else {
      if (b.connected === true) lines.push({ text: "Connected" })
      else if (!b.running) lines.push({ text: "Not running", warn: true })
      else if (b.note === "starting up") lines.push({ text: "Starting up", warn: true })
      else if (b.connected === null) lines.push({ text: "Can't tell whether it's connected", warn: true })
      else lines.push({ text: "Not connected", warn: true })
      if (b.sessions != null && b.capacity != null) {
        lines.push(b.full
          ? { text: `${b.sessions} of ${b.capacity} chats open — full, new chats can't start`, warn: true }
          : { text: `${b.sessions} of ${b.capacity} chats open` })
      }
      if (b.loginDaysLeft != null) {
        lines.push(b.loginDaysLeft <= 0
          ? { text: "Claude login has expired", warn: true }
          : { text: `Claude login: ${plural(b.loginDaysLeft, "day", "days")} left`, warn: b.loginDaysLeft <= LOGIN_WARN_DAYS })
      }
    }
    const hb = p.heartbeat
    if (hb?.watchdogAt && isFresh(hb.beatAt, MINI_QUIET_MS, now) && !isFresh(hb.watchdogAt, WATCHDOG_QUIET_MS, now)) {
      lines.push({ text: `Its keeper hasn't run since ${fmtDateTime(hb.watchdogAt)}`, warn: true })
    }
    cards.push({ key: "bridge", title: "Phone bridge", mark: markOf(lines, fallback), lines })
  }

  // Relationships helper
  {
    const lines: Line[] = []
    let fallback: Mark = "ok"
    if (!snap) { lines.push(WAITING); fallback = "unknown" }
    else {
      lines.push(snap.helper.ok ? { text: "Answering" } : { text: "Not answering", warn: true })
      const t = snap.textHistory
      if (!t?.refreshedAt) lines.push({ text: "Text history not found", warn: true })
      else lines.push({ text: `Text history refreshed ${agoWords(t.refreshedAt, now)}`, warn: t.stale })
    }
    cards.push({ key: "helper", title: "Relationships helper", mark: markOf(lines, fallback), lines })
  }

  // Judge
  {
    const lines: Line[] = []
    if (!p.judge) lines.push(COULDNT)
    else if (!p.judge.at) lines.push({ text: "Hasn't run yet", warn: true })
    else if (judgeRanToday(p.judge.at, now)) lines.push({ text: `Ran today at ${fmtTime(p.judge.at)}` })
    else lines.push({ text: `Last ran ${fmtDateTime(p.judge.at)}`, warn: true })
    cards.push({ key: "judge", title: "Judge", mark: markOf(lines), lines })
  }

  // Jackie — on or off is Ryan's choice, not a problem.
  {
    const lines: Line[] = []
    const j = p.jackie
    if (!j) lines.push(COULDNT)
    else {
      const word = j.on ? "On" : "Off"
      lines.push({ text: j.since ? `${word} since ${fmtDate(j.since)}` : word })
      lines.push({ text: `${plural(j.callsWeek, "call", "calls")} in the last 7 days` })
    }
    cards.push({ key: "jackie", title: "Jackie", mark: markOf(lines), lines })
  }

  // AI spend
  const spend = {
    data: p.spend,
    error: !p.spend,
    mark: (!p.spend ? "warn" : p.spend.monthUsd > p.spend.targetUsd ? "warn" : "ok") as Mark,
  }

  // Scheduled jobs
  let jobs: HealthView["jobs"] = null
  if (snap) {
    const items = sortJobs(snap.jobs)
    const bad = items.filter((j) => !j.ok).length
    jobs = {
      mark: bad ? "warn" : "ok",
      summary: `${plural(items.length, "job", "jobs")} · ${bad === 0 ? "all ok" : `${bad} ${bad === 1 ? "needs" : "need"} a look`}`,
      items,
    }
  }

  const problems = cards.filter((c) => c.mark === "warn").length
    + (spend.mark === "warn" ? 1 : 0)
    + (jobs?.mark === "warn" ? 1 : 0)
    + (checked.warn ? 1 : 0)
  const verdict = problems === 0 ? "Everything is running." : `${problems} ${problems === 1 ? "thing needs" : "things need"} a look.`
  return { problems, verdict, checked, cards, spend, jobs }
}
