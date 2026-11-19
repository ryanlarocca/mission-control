#!/usr/bin/env node
// Mac mini processor watch (2026-11-18). On Nov 18 Ryan found the mini slow:
// Apple's `amsaccountsd` (Apple ID / App Store sign-in) had been stuck in a
// DNS-lookup loop at ~100% of one core, on and off since the Oct 30 reboot.
// That's a macOS bug, not hardware. Ryan asked to watch for a repeat for two
// weeks, then every two weeks, then stop after about two months.
//
// Schedule (Pacific dates; launchd runs this every 15 min, and this file
// decides what each run does):
//   before WATCH_UNTIL   every run: any program using ≥ 80% of a core for an
//                        hour (4 runs in a row) → helper-bot alert naming it;
//                        ✅ when it stops. Also critical memory pressure (2 runs)
//                        and a recorded thermal warning.
//   WATCH_UNTIL          first run that day: two-week summary of what fired, plus
//                        a "spinning since boot" check (a program that has used
//                        ≥ 30% of a core over > 1 day of life).
//   CHECK_DAYS           first run that day: the since-boot check plus a quick
//                        live sample → one short report (all clear or not).
//   last CHECK_DAY       its report says the watch is done; then this job renames
//                        its own plist to *.disabled-<date> (mini-status skips
//                        those) and every later run exits right away.
//
// Alerts go to the helper bot (OPS_BOT_TOKEN), never with buttons. State lives in
// ~/Library/Logs/lrghomes/mini-cpu-watch.state.json.
//
// launchd: com.lrghomes.mini-cpu-watch (scripts/com.lrghomes.mini-cpu-watch.plist)
//   node scripts/mini-cpu-watch.mjs                 # what the schedule runs
//   node scripts/mini-cpu-watch.mjs --dry-run       # print what it would send; writes nothing
//   node scripts/mini-cpu-watch.mjs --dry-run --now 2026-12-16T10:00:00-08:00 --state /tmp/s.json
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

const WATCH_UNTIL = "2026-12-02"
const CHECK_DAYS = ["2026-12-16", "2026-12-30", "2027-01-13"]
const HOG_SHARE = 0.8          // share of one core
const HOG_RUNS = 4             // 4 × 15 min = 1 hour
const SINCE_BOOT_SHARE = 0.3
const SINCE_BOOT_MIN_SECS = 86_400
// Legitimately heavy work that may run for an hour (video renders, transcription).
const IGNORE = new Set(["ffmpeg", "ffprobe", "whisper", "whisper-cli"])

const argv = process.argv.slice(2)
const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
const DRY = argv.includes("--dry-run") || argv.includes("--dry")
const NOW = flag("--now") ? new Date(flag("--now")) : new Date()
const HOME = homedir()
const LOG_DIR = path.join(HOME, "Library/Logs/lrghomes")
const STATE_FILE = flag("--state") || path.join(LOG_DIR, "mini-cpu-watch.state.json")
const PLIST = path.join(HOME, "Library/LaunchAgents/com.lrghomes.mini-cpu-watch.plist")

const log = (...a) => console.log(NOW.toISOString().slice(0, 19), DRY ? "[dry]" : "", ...a)
const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 })
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
const pacificDay = (d) => d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })
const nice = (day) => new Date(day + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })

function loadEnv() {
  const file = new URL("../.env.local", import.meta.url)
  if (!existsSync(file)) return
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2")
  }
}

// ── reading the machine ──────────────────────────────────────────────────────

// ps TIME / ETIME: [[dd-]hh:]mm:ss[.cc] (TIME minutes can exceed 59, e.g. 12524:12.29)
export function psSeconds(s) {
  const [d, rest] = s.includes("-") ? s.split("-") : ["0", s]
  return rest.split(":").map(Number).reduce((acc, n) => acc * 60 + n, 0) + Number(d) * 86_400
}

export function parsePs(out) {
  const procs = {}
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/)
    if (!m) continue
    procs[m[1]] = { name: path.basename(m[4].trim()), life: psSeconds(m[2]), cpu: psSeconds(m[3]) }
  }
  return procs
}

const readProcs = () => parsePs(run("/bin/ps", ["-Ao", "pid=,etime=,time=,comm="]))
const pressureLevel = () => { try { return Number(run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]).trim()) } catch { return 0 } }
const thermalWarning = () => {
  try {
    const out = run("/usr/bin/pmset", ["-g", "therm"])
    return /No thermal warning level has been recorded/.test(out) ? null : out.trim().split("\n").filter((l) => !/^Note: No /.test(l)).join(" ").slice(0, 160) || null
  } catch { return null }
}

export function plain(name) {
  if (name === "amsaccountsd") return "Apple ID / App Store sign-in"
  if (/^(mds|mds_stores|mdworker)/.test(name)) return "Spotlight search indexing"
  if (/^claude/i.test(name)) return "a Claude chat"
  if (name === "node") return "one of the mini's background jobs"
  if (/chrome/i.test(name)) return "an automated Chrome window"
  if (name === "WindowServer") return "the screen display"
  return "a background program"
}

// Programs that have used ≥ 30% of a core over more than a day of life.
export function sinceBootHogs(procs) {
  return Object.entries(procs)
    .filter(([, p]) => p.life > SINCE_BOOT_MIN_SECS && p.cpu / p.life >= SINCE_BOOT_SHARE && !IGNORE.has(p.name) && p.name !== "kernel_task")
    .map(([pid, p]) => ({ pid, name: p.name, share: p.cpu / p.life, days: p.life / 86_400 }))
}

// Compare two samples → share of a core each pid used in between.
export function liveShares(prev, cur, secs) {
  const out = {}
  for (const [pid, p] of Object.entries(cur)) {
    const q = prev[pid]
    if (q && q.name === p.name && secs > 0) out[pid] = { name: p.name, share: Math.max(0, p.cpu - q.cpu) / secs }
  }
  return out
}

// ── state + sending ──────────────────────────────────────────────────────────

export const freshState = () => ({ sample: null, streaks: {}, alerted: {}, pressureRuns: 0, pressureAlerted: false, thermalAlerted: false, incidents: [], reported: {}, finished: false })
function loadState() { try { return { ...freshState(), ...JSON.parse(readFileSync(STATE_FILE, "utf8")) } } catch { return freshState() } }
function saveState(s) { if (!DRY) writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)) }

async function telegram(text) {
  if (DRY) { log(`(dry) would send: ${text.replace(/\n/g, " | ")}`); return }
  const token = process.env.OPS_BOT_TOKEN || process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID
  if (!token || !chat) { log("telegram not configured:", text); return }
  const res = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML" }),
  })
  if (!res.ok) throw new Error(`telegram HTTP ${res.status}`)
}

const FIX = `To clear it, send “mini reboot” here.`
const pct = (x) => `${Math.round(x * 100)}%`

// ── the runs ─────────────────────────────────────────────────────────────────

// One 15-minute watch step; returns lines to send.
export function watchStep(state, procs, nowMs) {
  const lines = []
  const prev = state.sample
  const secs = prev ? (nowMs - prev.at) / 1000 : 0
  // A gap over 30 min (sleep, reboot, job paused) restarts the streaks.
  const shares = prev && secs > 0 && secs <= 1800 ? liveShares(prev.procs, procs, secs) : {}
  if (!prev || secs > 1800) state.streaks = {}

  const streaks = {}
  for (const [pid, s] of Object.entries(shares)) {
    if (IGNORE.has(s.name) || s.name === "kernel_task") continue
    if (s.share >= HOG_SHARE) streaks[pid] = (state.streaks[pid] || 0) + 1
  }
  state.streaks = streaks

  for (const [pid, n] of Object.entries(streaks)) {
    if (n >= HOG_RUNS && !state.alerted[pid]) {
      const name = shares[pid].name
      state.alerted[pid] = { name, since: nowMs - n * 15 * 60_000 }
      state.incidents.push({ day: pacificDay(new Date(nowMs)), what: `${name} (${plain(name)}) stuck at ${pct(shares[pid].share)} of a core` })
      lines.push(`🟠 <b>Mac mini: ${esc(name)} is hogging the processor</b> — ${esc(plain(name))}, ${pct(shares[pid].share)} of a core for over an hour. ${FIX}`)
    }
  }
  for (const [pid, a] of Object.entries(state.alerted)) {
    if (streaks[pid]) continue
    const hrs = Math.max(1, Math.round((nowMs - a.since) / 3_600_000))
    lines.push(`✅ Mac mini: ${esc(a.name)} calmed down (stuck about ${hrs} hr).`)
    delete state.alerted[pid]
  }

  const level = pressureLevel()
  state.pressureRuns = level >= 4 ? state.pressureRuns + 1 : 0
  if (state.pressureRuns >= 2 && !state.pressureAlerted) {
    state.pressureAlerted = true
    state.incidents.push({ day: pacificDay(new Date(nowMs)), what: "memory critically low" })
    lines.push(`🟠 <b>Mac mini is critically low on memory</b> (30+ min). Too many chats or Chrome windows open. ${FIX}`)
  } else if (state.pressureRuns === 0 && state.pressureAlerted) {
    state.pressureAlerted = false
    lines.push("✅ Mac mini memory is back to normal.")
  }

  const therm = thermalWarning()
  if (therm && !state.thermalAlerted) {
    state.thermalAlerted = true
    state.incidents.push({ day: pacificDay(new Date(nowMs)), what: "chip reported a heat warning" })
    lines.push(`🔴 <b>Mac mini chip reported a heat warning</b> — check it has air around it. (${esc(therm)})`)
  } else if (!therm && state.thermalAlerted) state.thermalAlerted = false

  state.sample = { at: nowMs, procs }
  return lines
}

function sinceBootLine(procs) {
  const hogs = sinceBootHogs(procs)
  if (!hogs.length) return "Nothing has been stuck since the last reboot."
  return hogs.map((h) => `⚠️ ${esc(h.name)} (${esc(plain(h.name))}) has averaged ${pct(h.share)} of a core for ${h.days.toFixed(1)} days — stuck. ${FIX}`).join("\n")
}

function disableSelf() {
  if (DRY) { log("(dry) would rename the plist to .disabled"); return }
  if (existsSync(PLIST)) renameSync(PLIST, `${PLIST}.disabled-${pacificDay(NOW)}`)
}

async function main() {
  const state = loadState()
  if (state.finished) { log("watch finished; nothing to do"); return }
  const today = pacificDay(NOW)
  const procs = readProcs()
  const lines = []

  // The newest report day that has come and not been sent (a day the mini was
  // off is caught up on the next run; older missed ones are folded into it).
  const reportDays = [WATCH_UNTIL, ...CHECK_DAYS]
  const due = reportDays.filter((d) => d <= today && !state.reported[d])
  const day = due[due.length - 1]

  if (today < WATCH_UNTIL) {
    lines.push(...watchStep(state, procs, NOW.getTime()))
  } else if (day === WATCH_UNTIL) {
    const inc = state.incidents
    lines.push(`📋 <b>Mac mini — two-week processor watch done</b>\n` +
      (inc.length ? inc.map((i) => `• ${nice(i.day)}: ${esc(i.what)}`).join("\n") : "Nothing got stuck in two weeks.") +
      `\n${sinceBootLine(procs)}\nNext check: ${nice(CHECK_DAYS[0])}.`)
    state.sample = null
  } else if (day) {
    const last = day === CHECK_DAYS[CHECK_DAYS.length - 1]
    const next = CHECK_DAYS[CHECK_DAYS.indexOf(day) + 1]
    lines.push(`📋 <b>Mac mini processor check (${nice(day)})</b>\n${sinceBootLine(procs)}\n` +
      (last ? "That was the last check — the watch is switched off now." : `Next check: ${nice(next)}.`))
    if (last) state.finished = true
  }
  for (const d of due) state.reported[d] = true

  if (lines.length) await telegram(lines.join("\n"))
  else log("nothing to send")
  saveState(state)
  if (state.finished) disableSelf()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadEnv()
  main().catch((e) => { console.error("[mini-cpu-watch] failed:", e); process.exit(1) })
}
