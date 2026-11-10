#!/usr/bin/env node
// Weekly Mac mini tidy (2026-11-09, briefs/BRIEF_VIDEO_STORAGE_AND_LIBRARY_2026-11-09.md A9).
// The mini's 256 GB drive hit 94% full because nothing cleaned up after itself.
// This removes only things that are recreatable or already saved elsewhere:
//
//   1. `.next` build output in chat-session worktrees idle > 48 h (rebuilt on
//      the next `next build`).
//   2. Chat-session worktrees that are clean (junk like __pycache__ ignored),
//      fully merged into origin/main, not in use, not locked by a live
//      process, not a scheduled task's session, and whose chat has been idle
//      >= 7 days (Ryan's rule). `git worktree remove` without --force, after
//      checking every ignored file is on an allowlist. Their chats stay
//      resumable: the transcript lives in ~/.claude/projects and the bridge
//      re-creates a missing worktree.
//   3. npm's download cache (`npm cache clean --force`).
//   4. /private/tmp/ve-* scratch older than 7 days.
//
// One Telegram line when it freed something or found idle worktrees holding
// real uncommitted files (those are never touched).
//
// launchd: com.lrghomes.mini-tidy (Sundays 04:20). Logs ~/Library/Logs/lrghomes/mini-tidy.log.
// Usage: node --env-file=.env.local scripts/mini-tidy.mjs [--dry-run]
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

const DRY = process.argv.includes("--dry-run")
const HOME = os.homedir()
const MC_ROOT = path.join(HOME, "Projects/PROJECTS/mission-control")
const WT_ROOT = path.join(MC_ROOT, ".claude/worktrees")
const DAY = 86_400_000
const now = Date.now()
const log = (...a) => console.log(new Date().toISOString().slice(0, 19), DRY ? "[dry]" : "", ...a)
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000, ...opts }).trim()
const tryRun = (cmd, args, opts) => { try { return run(cmd, args, opts) } catch { return null } }

const JUNK = /(^|\/)(__pycache__|node_modules|\.next)(\/|$)|\.pyc$/
// Ignored files a worktree may hold and still be removed (symlinks to the main
// checkout, build output, caches).
const IGNORED_OK = /^(node_modules|\.next|\.env\.local|next-env\.d\.ts|tsconfig\.tsbuildinfo|esign\/node_modules|.*__pycache__.*|.*\.pyc)\/?$/

function freeKb() {
  const out = tryRun("df", ["-k", "/System/Volumes/Data"]) ?? ""
  return Number(out.split("\n")[1]?.trim().split(/\s+/)[3] ?? 0)
}

function newestMtime(p, depth = 0) {
  let best = 0
  let st
  try { st = fs.lstatSync(p) } catch { return 0 }
  best = st.mtimeMs
  if (st.isDirectory() && depth < 3) {
    for (const n of fs.readdirSync(p)) best = Math.max(best, newestMtime(path.join(p, n), depth + 1))
  }
  return best
}

/** Session-id suffixes a scheduled task fires into (claude-remote-ctl.py protected()); null = unknown. */
function protectedSuffixes() {
  const py = `import importlib.util,json,sys
s=importlib.util.spec_from_file_location("ctl","${path.join(HOME, "bin/claude-remote-ctl.py")}")
m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
k=m.protected(m.token())
print(json.dumps(None if k is None else sorted(k)))`
  const out = tryRun("python3", ["-c", py], { timeout: 60_000 })
  try { return out ? JSON.parse(out.split("\n").pop()) : null } catch { return null }
}

function livePid(pid) { try { process.kill(pid, 0); return true } catch { return false } }

function cwdsInUse() {
  const out = tryRun("lsof", ["-a", "-d", "cwd", "-Fn"], { timeout: 60_000 }) ?? ""
  const set = new Set()
  for (const l of out.split("\n")) if (l.startsWith("n") && l.includes("/.claude/worktrees/")) set.add(l.slice(1).split("/.claude/worktrees/")[1].split("/")[0])
  return set
}

function worktreeLocks() {
  const out = tryRun("git", ["-C", MC_ROOT, "worktree", "list", "--porcelain"]) ?? ""
  const locks = new Map()
  let cur = null
  for (const l of out.split("\n")) {
    if (l.startsWith("worktree ")) cur = path.basename(l.slice(9))
    else if (l.startsWith("locked") && cur) locks.set(cur, l.slice(7))
  }
  return locks
}

/** Last time anyone worked in this chat: the transcript folder, the worktree, its git log. */
function lastUsed(name) {
  const enc = path.join(WT_ROOT, name).replace(/[/._]/g, "-")
  const transcripts = path.join(HOME, ".claude/projects", enc)
  return Math.max(
    newestMtime(transcripts),
    tryStat(path.join(WT_ROOT, name)),
    tryStat(path.join(MC_ROOT, ".git/worktrees", name, "logs/HEAD")),
  )
}
function tryStat(p) { try { return fs.statSync(p).mtimeMs } catch { return 0 } }

function rmrf(p) { if (!DRY) fs.rmSync(p, { recursive: true, force: true }) }

async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID
  if (!token || !chat || DRY) { log("telegram:", text.replace(/\n/g, " | ")); return }
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML" }),
    })
  } catch (e) { log("telegram failed:", e.message) }
}

async function main() {
  const before = freeKb()
  const done = { nextDirs: 0, worktrees: 0, tmp: 0 }
  const keptWork = []

  if (fs.existsSync(WT_ROOT)) {
    tryRun("git", ["-C", MC_ROOT, "fetch", "origin", "main", "-q"], { timeout: 120_000 })
    const prot = protectedSuffixes()
    const inUse = cwdsInUse()
    const locks = worktreeLocks()
    if (prot === null) log("scheduled-task sessions unknown — no worktree will be removed this run")
    for (const name of fs.readdirSync(WT_ROOT)) {
      const dir = path.join(WT_ROOT, name)
      if (!fs.statSync(dir).isDirectory()) continue
      const idleDays = (now - lastUsed(name)) / DAY
      const busy = inUse.has(name)

      // 1. build output
      const next = path.join(dir, ".next")
      if (!busy && idleDays > 2 && fs.existsSync(next) && !fs.lstatSync(next).isSymbolicLink()) {
        log("remove .next", name); rmrf(next); done.nextDirs++
      }

      // 2. the worktree itself
      if (busy || idleDays < 7 || prot === null) continue
      if (prot.some(s => name.endsWith(s))) { log("keep (scheduled task)", name); continue }
      const lock = locks.get(name)
      if (lock) {
        const pid = Number((lock.match(/pid (\d+)/) ?? [])[1])
        if (!pid || livePid(pid)) continue
      }
      const status = tryRun("git", ["-C", dir, "status", "--porcelain"])
      if (status === null) continue
      const real = status.split("\n").filter(Boolean).map(l => l.slice(3)).filter(f => !JUNK.test(f))
      if (real.length) { keptWork.push(`${name} (${real.slice(0, 3).join(", ")}${real.length > 3 ? ", …" : ""})`); continue }
      const ahead = tryRun("git", ["-C", dir, "rev-list", "--count", "origin/main..HEAD"])
      if (ahead !== "0") continue
      const ignored = (tryRun("git", ["-C", dir, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory"]) ?? "").split("\n").filter(Boolean)
      const odd = ignored.filter(f => !IGNORED_OK.test(f))
      if (odd.length) { log("keep (unexpected ignored files)", name, odd.slice(0, 5).join(" ")); continue }
      log("remove worktree", name, `(idle ${Math.round(idleDays)} d)`)
      if (DRY) { done.worktrees++; continue }
      // junk first, so a plain (non-forced) remove succeeds
      for (const l of status.split("\n").filter(Boolean)) {
        const f = l.slice(3)
        if (l.startsWith(" M") && f.endsWith(".pyc")) tryRun("git", ["-C", dir, "checkout", "--", f])
        else if (l.startsWith("??")) rmrf(path.join(dir, f))
      }
      if (lock) tryRun("git", ["-C", MC_ROOT, "worktree", "unlock", dir])
      if (tryRun("git", ["-C", MC_ROOT, "worktree", "remove", dir]) !== null) done.worktrees++
      else log("remove failed (left in place)", name)
    }
    if (!DRY) tryRun("git", ["-C", MC_ROOT, "worktree", "prune"])
  }

  // 3. npm cache
  log("npm cache clean")
  if (!DRY) tryRun("/opt/homebrew/bin/npm", ["cache", "clean", "--force"], { timeout: 300_000 })

  // 4. video upload scratch
  for (const n of fs.readdirSync("/private/tmp")) {
    if (!n.startsWith("ve-")) continue
    const p = path.join("/private/tmp", n)
    if (now - tryStat(p) > 7 * DAY) { log("remove", p); rmrf(p); done.tmp++ }
  }

  const freedGb = Math.max(0, (freeKb() - before) / 1048576)
  const freeGb = freeKb() / 1048576
  log(`done: ${done.worktrees} worktrees, ${done.nextDirs} build folders, ${done.tmp} tmp; freed ${freedGb.toFixed(1)} GB; ${freeGb.toFixed(0)} GB free`)
  const lines = []
  if (freedGb >= 1) lines.push(`🧹 <b>Weekly mini tidy</b> — freed ${freedGb.toFixed(1)} GB (old chat folders and build files). ${freeGb.toFixed(0)} GB free.`)
  if (keptWork.length) lines.push(`Left alone — old chats with unsaved files:\n${keptWork.slice(0, 8).map(k => `• ${k}`).join("\n")}`)
  if (lines.length) await telegram(lines.join("\n\n"))
}

main().catch(e => { console.error("mini-tidy failed:", e); process.exit(1) })
