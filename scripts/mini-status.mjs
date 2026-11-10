#!/usr/bin/env node
// Mac mini status reporter (Mission Control 2.0, Part E — Health page v1,
// 2026-11-10). Every 5 minutes it takes one snapshot of what's running on the
// mini and upserts it into mini_status row 'mini', so the Health page reads
// Supabase and does not depend on the mini's tunnel being up.
//
// Snapshot (shape: MiniSnapshot in lib/miniStatus.ts):
//   jobs         every ~/Library/LaunchAgents/com.lrghomes.*.plist (not .disabled*):
//                plain name, schedule in words, running, last exit, ok
//   bridge       `python3 ~/bin/claude-remote-ctl.py status` (read-only), 30 s timeout
//   backup       ~/.mini-backup/manifest.json mtime, and whether mini-backup.err
//                was written after it
//   helper       GET http://localhost:5799/health (5 s timeout) — nothing else on 5799
//   textHistory  mtime of the CRMS unified_messages.db (hourly text-history merge)
//   disk, uptime df / sysctl
//
// NEVER opens, stats or reads anything under ~/Library/Messages, ~/Library/Mail,
// ~/Library/Containers or ~/Library/Mobile Documents: on this mini a blocked
// privacy prompt makes such reads hang forever (2026-11-10).
//
// Alerts (Telegram, one line per state CHANGE, a ✅ when it clears; state in
// ~/Library/Logs/lrghomes/mini-status.state.json): Relationships helper not
// answering two runs in a row → `launchctl kickstart -k` it and say so; text
// history stale; a scheduled job whose last run failed. Mini down, bridge
// watchdog silent and low disk are /api/mini/watch's alerts, not repeated here.
//
// launchd: com.lrghomes.mini-status (every 5 min; installed by the lead).
//   node scripts/mini-status.mjs             # what the schedule runs
//   node scripts/mini-status.mjs --dry-run   # print the snapshot + would-be alerts; writes, sends and restarts nothing
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createClient } from "@supabase/supabase-js"
import {
  EMPTY_ALERT_STATE, alertStep, isKeepAlive, isTextHistoryStale, jobName, judgeJob, parseBootTime,
  parseCtlStatus, parseDfFreeGb, parseLaunchctlList, scheduleWords,
} from "../lib/miniStatus.ts"

const DRY = process.argv.includes("--dry-run") || process.argv.includes("--dry")
const HOME = homedir()
const AGENTS_DIR = path.join(HOME, "Library/LaunchAgents")
const LOG_DIR = path.join(HOME, "Library/Logs/lrghomes")
const STATE_FILE = path.join(LOG_DIR, "mini-status.state.json")
const CTL = path.join(HOME, "bin/claude-remote-ctl.py")
const BACKUP_MANIFEST = path.join(HOME, ".mini-backup/manifest.json")
const BACKUP_ERR = path.join(LOG_DIR, "mini-backup.err")
const TEXT_DB = path.join(HOME, "Projects/PROJECTS/comprehensive-relationship-management/data/unified_messages.db")
const HELPER_URL = "http://localhost:5799/health"
const HELPER_LABEL = "com.lrghomes.crms-sidecar"

const log = (...a) => console.log(new Date().toISOString().slice(0, 19), DRY ? "[dry]" : "", ...a)
const run = (cmd, args, timeout = 15_000) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout }).trim()

function loadEnv() {
  const file = new URL("../.env.local", import.meta.url)
  if (!existsSync(file)) return
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2")
  }
}

const mtimeIso = (p) => { try { return statSync(p).mtime.toISOString() } catch { return null } }
const errMsg = (e) => String(e?.message || e).split("\n")[0].slice(0, 200)

// ── collectors (each fails on its own into `errors`) ────────────────────────

function collectJobs(errors) {
  let listed = {}
  try { listed = parseLaunchctlList(run("/bin/launchctl", ["list"])) } catch (e) { errors.push(`launchctl list: ${errMsg(e)}`) }
  const files = readdirSync(AGENTS_DIR).filter((f) => /^com\.lrghomes\..+\.plist$/.test(f)).sort()
  const jobs = []
  for (const f of files) {
    const label = f.replace(/\.plist$/, "")
    let plist = {}
    try { plist = JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(AGENTS_DIR, f)])) } catch (e) { errors.push(`${f}: ${errMsg(e)}`) }
    if (plist.Label) plist.Label = String(plist.Label)
    const l = listed[plist.Label || label] ?? listed[label]
    const keepAlive = isKeepAlive(plist)
    const pid = l?.pid ?? null
    const lastExit = l?.lastExit ?? null
    const { ok, state } = judgeJob({ keepAlive, loaded: !!l, pid, lastExit })
    jobs.push({ label, name: jobName(label), schedule: scheduleWords(plist), keepAlive, loaded: !!l, running: !!pid, pid, lastExit, ok, state })
  }
  return jobs
}

function collectBridge(errors) {
  try {
    return parseCtlStatus(run("/usr/bin/python3", [CTL, "status"], 30_000))
  } catch (e) {
    errors.push(`phone bridge status: ${errMsg(e)}`)
    return null
  }
}

function collectBackup(errors) {
  const lastAt = mtimeIso(BACKUP_MANIFEST)
  const errAt = mtimeIso(BACKUP_ERR)
  if (!lastAt) errors.push("backup: no manifest yet")
  return { lastAt, errAt, failedSince: !!errAt && (!lastAt || Date.parse(errAt) > Date.parse(lastAt)) }
}

async function collectHelper() {
  try {
    const res = await fetch(HELPER_URL, { method: "GET", signal: AbortSignal.timeout(5_000) })
    const body = await res.json().catch(() => ({}))
    const ok = res.ok && body?.ok !== false
    return { ok, pid: typeof body?.pid === "number" ? body.pid : null, error: ok ? null : `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, pid: null, error: e?.name === "TimeoutError" ? "no answer in 5 s" : errMsg(e) }
  }
}

function collectTextHistory(errors, now) {
  const refreshedAt = mtimeIso(TEXT_DB)
  if (!refreshedAt) errors.push("text history: database not found")
  return { refreshedAt, stale: isTextHistoryStale(refreshedAt, now) }
}

function collectDisk(errors) {
  try {
    const freeGb = parseDfFreeGb(run("/bin/df", ["-k", "/System/Volumes/Data"]))
    return freeGb == null ? null : { freeGb }
  } catch (e) { errors.push(`disk: ${errMsg(e)}`); return null }
}

function collectUptime(errors) {
  try {
    const bootAt = parseBootTime(run("/usr/sbin/sysctl", ["-n", "kern.boottime"]))
    return bootAt ? { bootAt } : null
  } catch (e) { errors.push(`uptime: ${errMsg(e)}`); return null }
}

export async function collect(now = new Date()) {
  const errors = []
  const helperP = collectHelper()
  const jobs = collectJobs(errors)
  const snapshot = {
    version: 1,
    at: now.toISOString(),
    jobs,
    bridge: collectBridge(errors),
    backup: collectBackup(errors),
    helper: await helperP,
    textHistory: collectTextHistory(errors, now),
    disk: collectDisk(errors),
    uptime: collectUptime(errors),
    errors,
  }
  return snapshot
}

// ── side effects (never in --dry-run) ───────────────────────────────────────

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")) } catch { return null }
}
function saveState(s) {
  if (DRY) return
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2))
}

async function telegram(text) {
  if (DRY) { log(`(dry) would send Telegram: ${text.replace(/\n/g, " | ")}`); return }
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID
  if (!token || !chat) { log("telegram not configured:", text); return }
  try {
    const res = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML" }),
    })
    if (!res.ok) log("telegram HTTP", res.status)
  } catch (e) { log("telegram failed:", errMsg(e)) }
}

function restartHelper() {
  if (DRY) { log(`(dry) would restart ${HELPER_LABEL}`); return null }
  try {
    run("/bin/launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${HELPER_LABEL}`], 30_000)
    return null
  } catch (e) { return errMsg(e) }
}

async function upsert(snapshot) {
  if (DRY) return
  const url = process.env.LRG_SUPABASE_URL
  const key = process.env.LRG_SUPABASE_SERVICE_KEY
  if (!url || !key) throw new Error("LRG_SUPABASE_URL / LRG_SUPABASE_SERVICE_KEY not set")
  const sb = createClient(url, key, { auth: { persistSession: false } })
  const { error } = await sb.from("mini_status").upsert({ id: "mini", reported_at: snapshot.at, snapshot }, { onConflict: "id" })
  if (error) throw new Error(`mini_status upsert: ${error.message}`)
}

// ── main ────────────────────────────────────────────────────────────────────

function summary(s) {
  const bad = s.jobs.filter((j) => !j.ok)
  const b = s.bridge
  return [
    `jobs: ${s.jobs.length}${bad.length ? ` · not ok: ${bad.map((j) => `${j.name} (${j.state})`).join(", ")}` : " · all ok"}`,
    `bridge: ${b ? `${b.connected === true ? "connected" : b.note ?? "not connected"} · ${b.sessions ?? "?"} of ${b.capacity ?? "?"} · login ${b.loginDaysLeft ?? "?"} d` : "unknown"}`,
    `backup: last ${s.backup?.lastAt ?? "never"}${s.backup?.failedSince ? ` · error written since (${s.backup.errAt})` : ""}`,
    `helper: ${s.helper.ok ? `answering (pid ${s.helper.pid})` : `not answering — ${s.helper.error}`}`,
    `text history: ${s.textHistory?.refreshedAt ?? "?"}${s.textHistory?.stale ? " · STALE" : ""}`,
    `disk: ${s.disk?.freeGb ?? "?"} GB free · up since ${s.uptime?.bootAt ?? "?"}`,
    ...(s.errors.length ? [`errors: ${s.errors.join(" | ")}`] : []),
  ].join("\n")
}

async function main() {
  const snapshot = await collect()
  const prevFile = loadState()
  const { next, lines, restartHelper: doRestart } = alertStep(prevFile ?? EMPTY_ALERT_STATE, snapshot)

  if (DRY) {
    console.log(JSON.stringify(snapshot, null, 2))
    console.log(`\n${summary(snapshot)}`)
  }

  if (doRestart) {
    const fail = restartHelper()
    if (fail) lines.push(`⚠️ Restarting the Relationships helper failed: ${fail.replace(/</g, "&lt;")}`)
  }

  // Saving the snapshot is what the Health page reads — a failure must not be
  // silent, but at every-5-minutes it must not page every run either.
  let saveError = null
  try { await upsert(snapshot) } catch (e) { saveError = errMsg(e) }
  const state = { ...next, saveFailing: !!saveError }
  if (saveError && !prevFile?.saveFailing) lines.push(`🔴 <b>Mac mini health check can't save its report</b> — the Health page will go stale: ${saveError.replace(/</g, "&lt;")}`)
  if (!saveError && prevFile?.saveFailing) lines.push("✅ Mac mini health check is saving its report again.")

  if (lines.length) await telegram(lines.join("\n"))
  else if (DRY) log("(dry) no alerts would be sent")
  saveState(state)
  if (!DRY) log(`saved: ${snapshot.jobs.length} jobs, ${snapshot.jobs.filter((j) => !j.ok).length} not ok, helper ${snapshot.helper.ok ? "ok" : "down"}${saveError ? ` — SAVE FAILED: ${saveError}` : ""}`)
  if (saveError) process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadEnv()
  main().catch(async (e) => {
    console.error("[mini-status] failed:", e)
    // Once per crash streak (the next good run clears the mark).
    const prev = loadState() ?? {}
    if (!prev.crashed) {
      await telegram(`🔴 <b>Mac mini health check crashed</b> — the Health page will go stale: ${errMsg(e).replace(/</g, "&lt;")}`)
      saveState({ ...prev, crashed: true })
    }
    process.exit(1)
  })
}
