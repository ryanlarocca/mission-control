// Mac mini status snapshot (Mission Control 2.0, Part E — Health page v1,
// 2026-11-10). Pure helpers for scripts/mini-status.mjs (which runs on the
// mini every 5 minutes and writes table mini_status row 'mini') and for the
// Health page, plus tests/mini-status.unit.test.ts.
//
// Constraints, because the script imports this file straight from Node (type
// stripping, like scripts/projects-sync.mjs → lib/projectMemo.ts):
//   - no imports at all (no "@/…" aliases — Node can't resolve them)
//   - erasable TypeScript only: no enums, namespaces or parameter properties
// The browser imports this too; nothing server-only lives here.

// ── snapshot shape (mini_status.snapshot) ───────────────────────────────────

export interface MiniJob {
  label: string             // com.lrghomes.judge
  name: string              // "The judge"
  schedule: string          // "every 15 min" / "always on" / "daily 3:10 AM"
  keepAlive: boolean
  loaded: boolean           // listed by `launchctl list`
  running: boolean          // has a pid
  pid: number | null
  lastExit: number | null   // launchctl's status column
  ok: boolean
  state: string             // plain words: "running", "last run ok", "last run failed"
}

export interface BridgeStatus {
  running: boolean
  connected: boolean | null // null = the bridge is up but its state can't be read
  note: string | null       // "starting up", "can't read its screen", or the red status line
  sessions: number | null
  capacity: number | null
  full: boolean
  loginDaysLeft: number | null
}

export interface MiniSnapshot {
  version: 1
  at: string                                    // when the snapshot was taken (ISO)
  jobs: MiniJob[]
  bridge: BridgeStatus | null
  backup: { lastAt: string | null; failedSince: boolean; errAt: string | null } | null
  helper: { ok: boolean; pid: number | null; error: string | null }
  textHistory: { refreshedAt: string | null; stale: boolean } | null
  disk: { freeGb: number } | null
  uptime: { bootAt: string } | null
  errors: string[]
}

export const TEXT_HISTORY_STALE_MS = 3 * 3600_000
export const LOGIN_WARN_DAYS = 7
/** The nightly backup runs at 3:10 AM; older than this means last night's didn't land. */
export const BACKUP_STALE_MS = 26 * 3600_000

// ── job names ───────────────────────────────────────────────────────────────

/** Plain names for the jobs on the mini (2026-11-10). Unknown labels fall back to dashes → spaces. */
export const JOB_NAMES: Record<string, string> = {
  "boot-check": "Startup check",
  "campaign-engine": "Email campaign sender",
  "claude-remote-spawn": "Phone bridge keeper",
  "crms-cloudflare-tunnel": "Relationships helper web link",
  "crms-lastcontacted-sync": "Last-contacted dates sync",
  "crms-merge": "Text history merge",
  "crms-reply-detection": "Relationships reply check",
  "crms-sidecar": "Relationships helper",
  "crms-update-sidecar-url": "Helper address sync",
  "drip-engine": "Drip texts and emails",
  "esign": "E-sign service",
  "esign-tunnel": "E-sign web link",
  "gmail-watch-renewal": "Gmail watch renewal",
  "inbox-agent": "Inbox agent",
  "iphone-call-sync": "iPhone call log sync",
  "judge": "The judge",
  "lead-status-sweep": "Lead status sweep",
  "llm-spend-report": "AI spend report",
  "market-cycle-macro": "Market cycle daily",
  "market-cycle-retry": "Market cycle retry",
  "market-cycle-weekly": "Market cycle weekly",
  "mini-backup": "Nightly backup",
  "mini-heartbeat": "Mini check-in",
  "mini-status": "Health check",
  "mini-tidy": "Weekly tidy",
  "mission-control": "Mission Control on the mini",
  "orphan-recording-rescue": "Call recording rescue",
  "outbound-sms-sync": "Sent texts sync",
  "personal-cell-heartbeat": "Personal-cell follow-up sync",
  "physiq-keepalive": "Physiq keep-awake",
  "projects-sync": "Projects sync",
  "side-agent": "Telegram helper bot",
  "vault-scrub": "Video vault cleanup",
  "website-ladder": "Website lead call reminders",
}

export function jobName(label: string): string {
  const short = label.replace(/^com\.lrghomes\./, "")
  if (JOB_NAMES[short]) return JOB_NAMES[short]
  const words = short.replace(/[-_.]+/g, " ").trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : label
}

// ── schedule → words ────────────────────────────────────────────────────────

const WEEKDAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"]

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/** 3, 10 → "3:10 AM"; 0, 0 → "12:00 AM". */
export function clock(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  return `${h12}:${pad2(minute)} ${hour < 12 ? "AM" : "PM"}`
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"
  return `${n}${s}`
}

/** StartInterval seconds → "every 5 min", "hourly", "every 2 days". */
export function intervalWords(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "on demand"
  if (sec % 86400 === 0) return sec === 86400 ? "daily" : `every ${sec / 86400} days`
  if (sec % 3600 === 0) return sec === 3600 ? "hourly" : `every ${sec / 3600} hours`
  if (sec % 60 === 0) return sec === 60 ? "every minute" : `every ${sec / 60} min`
  return `every ${sec} sec`
}

type CalendarEntry = { Minute?: number; Hour?: number; Day?: number; Weekday?: number; Month?: number }

/** One StartCalendarInterval dict → "daily 3:10 AM" / "Mondays 8:40 AM" / "hourly at :10". */
export function calendarWords(c: CalendarEntry): string {
  const minute = typeof c.Minute === "number" ? c.Minute : 0
  const time = typeof c.Hour === "number" ? clock(c.Hour, minute) : `hourly at :${pad2(minute)}`
  if (typeof c.Weekday === "number") return `${WEEKDAYS[((c.Weekday % 7) + 7) % 7]} ${time}`
  if (typeof c.Day === "number") return `monthly on the ${ordinal(c.Day)}, ${time}`
  return typeof c.Hour === "number" ? `daily ${time}` : time
}

export interface PlistLike {
  KeepAlive?: boolean | Record<string, unknown>
  RunAtLoad?: boolean
  StartInterval?: number
  StartCalendarInterval?: CalendarEntry | CalendarEntry[]
  WatchPaths?: unknown[]
  QueueDirectories?: unknown[]
}

export function isKeepAlive(p: PlistLike): boolean {
  if (p.KeepAlive === true) return true
  return !!p.KeepAlive && typeof p.KeepAlive === "object" && Object.keys(p.KeepAlive).length > 0
}

/** A plist's schedule in plain words. */
export function scheduleWords(p: PlistLike): string {
  if (isKeepAlive(p)) return "always on"
  const cal = p.StartCalendarInterval
  if (cal) {
    const list = Array.isArray(cal) ? cal : [cal]
    const words = Array.from(new Set(list.map(calendarWords)))
    if (words.length) return words.join(", ")
  }
  if (typeof p.StartInterval === "number") return intervalWords(p.StartInterval)
  if ((p.WatchPaths && p.WatchPaths.length) || (p.QueueDirectories && p.QueueDirectories.length)) return "when files change"
  if (p.RunAtLoad) return "at startup"
  return "on demand"
}

// ── launchctl list ──────────────────────────────────────────────────────────

/** `launchctl list` → label → { pid, lastExit }. Header and malformed lines are skipped. */
export function parseLaunchctlList(text: string): Record<string, { pid: number | null; lastExit: number | null }> {
  const out: Record<string, { pid: number | null; lastExit: number | null }> = {}
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 3) continue
    const [pidRaw, statusRaw] = parts
    const label = parts.slice(2).join(" ")
    if (pidRaw === "PID") continue
    if (pidRaw !== "-" && !/^\d+$/.test(pidRaw)) continue
    if (statusRaw !== "-" && !/^-?\d+$/.test(statusRaw)) continue
    out[label] = {
      pid: pidRaw === "-" ? null : Number(pidRaw),
      lastExit: statusRaw === "-" ? null : Number(statusRaw),
    }
  }
  return out
}

/** Whether a job is fine, and its state in plain words. */
export function judgeJob(j: { keepAlive: boolean; loaded: boolean; pid: number | null; lastExit: number | null }): { ok: boolean; state: string } {
  if (!j.loaded) return { ok: false, state: "not scheduled" }
  if (j.keepAlive) {
    // A negative status on an always-on job (-15, -9) only means launchd
    // restarted it at some point; it's fine as long as it is running now.
    return j.pid ? { ok: true, state: "running" } : { ok: false, state: "stopped" }
  }
  if (j.lastExit === null || j.lastExit === 0) return { ok: true, state: j.pid ? "running now" : "last run ok" }
  if (j.lastExit < 0) return { ok: false, state: "last run was cut off" }
  return { ok: false, state: "last run failed" }
}

// ── phone bridge (claude-remote-ctl.py status) ──────────────────────────────

/**
 * `python3 ~/bin/claude-remote-ctl.py status` → bridge state. Throws when the
 * text has no bridge line at all (the command printed something unexpected).
 */
export function parseCtlStatus(text: string): BridgeStatus {
  const out: BridgeStatus = { running: true, connected: null, note: null, sessions: null, capacity: null, full: false, loginDaysLeft: null }
  let seen = false
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (/Mac mini bridge is NOT running/i.test(line)) {
      seen = true
      out.running = false
      out.connected = false
      out.note = "not running"
      continue
    }
    const m = line.match(/Mac mini bridge:\s*(.*)$/)
    if (m) {
      seen = true
      const rest = m[1].trim()
      if (/^connected\b/i.test(rest)) { out.connected = true; out.note = null }
      else if (/starting up/i.test(rest)) { out.connected = false; out.note = "starting up" }
      else if (/can't read its screen|connection state unknown/i.test(rest)) { out.connected = null; out.note = "can't read its screen" }
      else { out.connected = false; out.note = rest || "not connected" }
      continue
    }
    const s = line.match(/Sessions open:\s*(\d+)\s+of\s+(\d+)/i)
    if (s) {
      out.sessions = Number(s[1])
      out.capacity = Number(s[2])
      out.full = out.sessions >= out.capacity || /FULL/.test(line)
      continue
    }
    const l = line.match(/Claude login:\s*(-?\d+)\s+days? left/i)
    if (l) out.loginDaysLeft = Number(l[1])
  }
  if (!seen) throw new Error("bridge status: no bridge line in the output")
  return out
}

// ── small parsers ───────────────────────────────────────────────────────────

/** `sysctl -n kern.boottime` → ISO boot time, or null. */
export function parseBootTime(text: string): string | null {
  const m = text.match(/sec\s*=\s*(\d+)/)
  return m ? new Date(Number(m[1]) * 1000).toISOString() : null
}

/** `df -k <path>` → free GB (one decimal), or null. */
export function parseDfFreeGb(text: string): number | null {
  const row = text.split("\n")[1]
  const avail = Number(row?.trim().split(/\s+/)[3])
  return Number.isFinite(avail) && avail > 0 ? Math.round((avail / (1024 * 1024)) * 10) / 10 : null
}

export function isTextHistoryStale(refreshedAt: string | null, now: Date): boolean {
  if (!refreshedAt) return true
  return now.getTime() - Date.parse(refreshedAt) > TEXT_HISTORY_STALE_MS
}

/** Backup is fine when the last good run is recent and no error was written after it. */
export function backupOk(b: MiniSnapshot["backup"], now: Date): boolean {
  if (!b || !b.lastAt) return false
  if (b.failedSince) return false
  return now.getTime() - Date.parse(b.lastAt) <= BACKUP_STALE_MS
}

// ── alerts (state changes only) ─────────────────────────────────────────────

export interface AlertState {
  helperMisses: number        // consecutive runs the helper didn't answer
  helperDown: boolean         // alerted + restarted; waiting for it to answer again
  textStale: boolean
  failingJobs: string[]       // labels alerted as failing
}

export const EMPTY_ALERT_STATE: AlertState = { helperMisses: 0, helperDown: false, textStale: false, failingJobs: [] }

/** Jobs that have their own alert (the helper) or are judged elsewhere. */
const JOB_ALERT_SKIP = new Set(["com.lrghomes.crms-sidecar"])

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/**
 * One run's alert decision. Lines are sent only on a change (and a ✅ when a
 * problem clears). `restartHelper` = the helper has missed two checks in a row
 * and hasn't been restarted for this outage yet.
 */
export function alertStep(prev: AlertState | null, snap: Pick<MiniSnapshot, "helper" | "textHistory" | "jobs">): {
  next: AlertState; lines: string[]; restartHelper: boolean
} {
  const p: AlertState = { ...EMPTY_ALERT_STATE, ...(prev ?? {}) }
  const next: AlertState = { ...p, failingJobs: [...(p.failingJobs ?? [])] }
  const lines: string[] = []
  let restartHelper = false

  // Relationships helper: two misses in a row → restart once, say so.
  if (snap.helper.ok) {
    if (p.helperDown) lines.push("✅ <b>Relationships helper is answering again.</b>")
    next.helperMisses = 0
    next.helperDown = false
  } else {
    next.helperMisses = (p.helperMisses || 0) + 1
    if (next.helperMisses >= 2 && !p.helperDown) {
      restartHelper = true
      next.helperDown = true
      lines.push("🔴 <b>Relationships helper stopped answering</b> (two checks in a row) — restarting it now. Relationships cards and texts from your phone may not work until it's back.")
    }
  }

  // Text history (only judged when it could be read).
  if (snap.textHistory) {
    const stale = snap.textHistory.stale
    if (stale && !p.textStale) lines.push("🟡 <b>Text history has stopped refreshing</b> — texts on Relationships cards may be out of date.")
    if (!stale && p.textStale) lines.push("✅ Text history is refreshing again.")
    next.textStale = stale
  }

  // Scheduled jobs whose last run failed.
  const failing = snap.jobs.filter((j) => !j.ok && !JOB_ALERT_SKIP.has(j.label))
  const nowLabels = failing.map((j) => j.label).sort()
  const was = new Set(p.failingJobs ?? [])
  const fresh = failing.filter((j) => !was.has(j.label))
  const cleared = (p.failingJobs ?? []).filter((l) => !nowLabels.includes(l))
  if (fresh.length) {
    lines.push(
      fresh.length === 1
        ? `🟡 <b>Scheduled job needs a look</b> — ${escHtml(fresh[0].name)}: ${escHtml(fresh[0].state)}.`
        : `🟡 <b>${fresh.length} scheduled jobs need a look</b> — ${fresh.map((j) => `${escHtml(j.name)}: ${escHtml(j.state)}`).join("; ")}.`,
    )
  }
  if (cleared.length) {
    const names = cleared.map((l) => escHtml(snap.jobs.find((j) => j.label === l)?.name ?? jobName(l)))
    lines.push(`✅ ${names.join(", ")} ${names.length === 1 ? "is" : "are"} running fine again.`)
  }
  next.failingJobs = nowLabels

  return { next, lines, restartHelper }
}
