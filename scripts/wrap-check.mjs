#!/usr/bin/env node
// Wrap check (2026-11-17): the last step of every wrap. Proves nothing was left
// half-saved, then starts a background backup so the day's work is in Drive now
// instead of at 3 AM. Prints for the agent only; never messages Ryan.
//
//   node scripts/wrap-check.mjs              # from the worktree you worked in (or the main checkout)
//   node scripts/wrap-check.mjs --no-backup  # skip the background backup
//
// Checks: code committed + pushed, main checkout current (fast-forwards it if
// clean), ~/Projects memo repo committed, Projects page synced, memo format
// (📍 block size, Updated vs changelog, index date), deals index, one memory
// folder + index links, backup health. Exit 1 when anything needs attention.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawn } from "node:child_process"

const HOME = os.homedir()
const MAIN = path.join(HOME, "Projects/PROJECTS/mission-control")
const PROJECTS_REPO = path.join(HOME, "Projects")
const MEMOS = path.join(PROJECTS_REPO, "PROJECTS")
const MEMORY = path.join(HOME, ".claude/projects/-Users-ryanlarocca-Projects-PROJECTS-mission-control/memory")
const LOG_DIR = path.join(HOME, "Library/Logs/lrghomes")
const args = new Set(process.argv.slice(2))

const ok = [], warn = []
const good = (s) => ok.push(s)
const bad = (s) => warn.push(s)
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const tryGit = (cwd, ...a) => { try { return git(cwd, ...a) } catch { return null } }
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date())

// ── 1. code repo (the checkout this runs from) ─────────────────────────────
const here = tryGit(process.cwd(), "rev-parse", "--show-toplevel")
if (here) {
  const dirty = git(here, "status", "--porcelain", "--untracked-files=no")
  if (dirty) bad(`Uncommitted changes in ${here}:\n${dirty.split("\n").map((l) => "     " + l).join("\n")}`)
  else good(`Code committed (${path.basename(here)})`)
  tryGit(here, "fetch", "-q", "origin", "main")
  const head = git(here, "rev-parse", "--short", "HEAD")
  if (tryGit(here, "merge-base", "--is-ancestor", "HEAD", "origin/main") !== null) good(`HEAD ${head} is on origin/main`)
  else bad(`HEAD ${head} is not on origin/main — push it (git push origin HEAD:main) if it should ship`)
}

// ── 2. main checkout on the mini (launchd jobs + fresh sessions run from it) ─
{
  tryGit(MAIN, "fetch", "-q", "origin", "main")
  const local = tryGit(MAIN, "rev-parse", "HEAD"), remote = tryGit(MAIN, "rev-parse", "origin/main")
  if (local && remote && local !== remote) {
    const dirty = tryGit(MAIN, "status", "--porcelain", "--untracked-files=no")
    if (!dirty && tryGit(MAIN, "pull", "-q", "--ff-only") !== null) good(`Main checkout fast-forwarded to ${remote.slice(0, 7)}`)
    else bad(`Main checkout is not at origin/main and couldn't fast-forward (${dirty ? "it has local changes" : "pull failed"})`)
  } else if (local) good(`Main checkout current (${local.slice(0, 7)})`)
}

// ── 3. ~/Projects memo repo (local-only, no remote) ─────────────────────────
{
  const st = tryGit(PROJECTS_REPO, "status", "--porcelain", "--", "PROJECTS/MEMO_INDEX.md", "PROJECTS/*/PROJECT_MEMO.md", "PROJECTS/*/CHANGELOG.md", "PROJECTS/*/WHERE_WE_LEFT_OFF_ARCHIVE.md", "PROJECTS/deals")
  if (st === null) bad("Couldn't read the ~/Projects repo")
  else if (st) bad(`Memo repo has uncommitted memo/deal files — commit them (git -C ~/Projects add <files> && git commit):\n${st.split("\n").map((l) => "     " + l).join("\n")}`)
  else good("Memos + deals committed in ~/Projects")
}

// ── 4. memo format ──────────────────────────────────────────────────────────
const index = fs.readFileSync(path.join(MEMOS, "MEMO_INDEX.md"), "utf8")
for (const dir of fs.readdirSync(MEMOS)) {
  const memoPath = path.join(MEMOS, dir, "PROJECT_MEMO.md")
  if (dir.startsWith("_") || !fs.existsSync(memoPath)) continue
  const memo = fs.readFileSync(memoPath, "utf8")
  const updated = /\*\*Updated:\*\*\s*(\d{4}-\d{2}-\d{2})/.exec(memo)?.[1] ?? null
  const block = /## 📍 Where we left off\n([\s\S]*?)(?=\n## )/.exec(memo)?.[1] ?? ""
  const nowBullet = /- \*\*Now —\*\*([\s\S]*?)(?=\n- \*\*|$)/.exec(block)?.[1] ?? ""
  if (block.length > 4000) bad(`${dir}: "📍 Where we left off" is ${(block.length / 1000).toFixed(1)} KB — rewrite as Now/Next/Open (≤5-line Now), move the rest to WHERE_WE_LEFT_OFF_ARCHIVE.md`)
  else if (nowBullet.length > 1500) bad(`${dir}: the "Now" bullet is ${nowBullet.length} chars — keep it to ≤5 lines`)
  const clPath = path.join(MEMOS, dir, "CHANGELOG.md")
  if (updated && fs.existsSync(clPath)) {
    const latest = [...fs.readFileSync(clPath, "utf8").matchAll(/^## (\d{4}-\d{2}-\d{2})/gm)].map((m) => m[1]).sort().pop()
    if (latest && latest > updated) bad(`${dir}: CHANGELOG has a ${latest} entry but the memo says Updated ${updated}`)
  }
  const row = index.split("\n").find((l) => l.includes(`](${dir}/PROJECT_MEMO.md)`))
  const touched = row && /\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*$/.exec(row)?.[1]
  if (updated && touched && updated > touched) bad(`${dir}: MEMO_INDEX "Last touched" is ${touched}, memo Updated ${updated}`)
}
if (!warn.some((w) => /Where we left off|"Now" bullet|CHANGELOG has|Last touched/.test(w))) good("Memo format: 📍 blocks within limits, dates consistent")

// ── 5. deals ────────────────────────────────────────────────────────────────
{
  const dd = path.join(MEMOS, "deals")
  if (fs.existsSync(dd)) {
    const readme = fs.readFileSync(path.join(dd, "README.md"), "utf8")
    const files = fs.readdirSync(dd).filter((f) => f.endsWith(".md") && f !== "README.md" && !f.includes("shared-log"))
    const missing = files.filter((f) => !readme.includes(`(${f})`))
    const noStatus = files.filter((f) => !/^## Status/m.test(fs.readFileSync(path.join(dd, f), "utf8")))
    if (missing.length) bad(`deals/README.md doesn't list: ${missing.join(", ")}`)
    if (noStatus.length) bad(`Deal files without a "## Status" block: ${noStatus.join(", ")}`)
    if (!missing.length && !noStatus.length) good(`Deals: ${files.length} files, all indexed with a Status block`)
  }
}

// ── 6. memory: one folder, index links resolve ──────────────────────────────
{
  const proj = path.join(HOME, ".claude/projects")
  const strays = fs.readdirSync(proj).map((d) => path.join(proj, d, "memory"))
    .filter((m) => m !== MEMORY && fs.existsSync(m) && !fs.lstatSync(m).isSymbolicLink() && fs.readdirSync(m).length)
  if (strays.length) bad(`New memory folder(s) outside the main one — merge the files into ${MEMORY} and replace with a symlink: ${strays.join(", ")}`)
  const idx = fs.readFileSync(path.join(MEMORY, "MEMORY.md"), "utf8")
  const links = [...idx.matchAll(/\]\(([^)\s]+\.md)\)/g)].map((m) => m[1]).filter((l) => !l.includes("/"))
  const broken = [...new Set(links.filter((l) => !fs.existsSync(path.join(MEMORY, l))))]
  if (broken.length) bad(`MEMORY.md links to missing files: ${broken.join(", ")}`)
  if (idx.length > 25_000) bad(`MEMORY.md is ${(idx.length / 1000).toFixed(1)} KB — it loads every session; tighten it`)
  if (!strays.length && !broken.length) good(`Memory: one folder, ${links.length} index links resolve (MEMORY.md ${(idx.length / 1000).toFixed(1)} KB)`)
}

// ── 7. Projects page ────────────────────────────────────────────────────────
try {
  const out = execFileSync(process.execPath, ["scripts/projects-sync.mjs"], { cwd: MAIN, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  good(`Projects page synced (${(/upserted \d+/.exec(out) || ["ok"])[0]})`)
} catch (e) { bad(`projects-sync failed: ${String(e.stderr || e.message).trim().split("\n").pop()}`) }

// ── 8. backup: health now, then a background run ────────────────────────────
{
  const manifest = path.join(HOME, ".mini-backup/manifest.json")
  const lastAt = fs.existsSync(manifest) ? fs.statSync(manifest).mtime : null
  const err = path.join(LOG_DIR, "mini-backup.err")
  const errAt = fs.existsSync(err) ? fs.statSync(err).mtime : null
  const lastLine = (() => { try { return fs.readFileSync(path.join(LOG_DIR, "mini-backup.log"), "utf8").trim().split("\n").filter((l) => / done: /.test(l)).pop() || "" } catch { return "" } })()
  const failed = Number(/failed (\d+)/.exec(lastLine)?.[1] ?? 0)
  const hours = lastAt ? (Date.now() - lastAt.getTime()) / 3600_000 : Infinity
  if (!lastAt || hours > 36) bad(`Backup: no good run in ${lastAt ? Math.round(hours) + " h" : "ever"}`)
  else if (failed || (errAt && errAt > lastAt)) bad(`Backup: last run had problems (${failed} failed file(s)${errAt > lastAt ? ", error log newer than the last run" : ""}) — see ${LOG_DIR}/mini-backup.log`)
  else good(`Backup healthy: last run ${Math.round(hours)} h ago, 0 failed`)
  if (!args.has("--no-backup")) {
    let running = false
    try { running = !!execFileSync("pgrep", ["-f", "mini-backup/backup.mjs"], { encoding: "utf8" }).trim() } catch { /* none */ }
    if (running) good("Backup already running")
    else {
      fs.mkdirSync(LOG_DIR, { recursive: true })
      const out = fs.openSync(path.join(LOG_DIR, "mini-backup.log"), "a"), errFd = fs.openSync(err.replace(/\.err$/, ".wrap.err"), "a")
      spawn(process.execPath, ["scripts/mini-backup/backup.mjs"], { cwd: MAIN, detached: true, stdio: ["ignore", out, errFd] }).unref()
      good("Backup started in the background (silent; 🔴 only if it fails)")
    }
  }
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(`Wrap check — ${today}\n`)
for (const s of ok) console.log(`  ✅ ${s}`)
for (const s of warn) console.log(`  ⚠️  ${s}`)
console.log(warn.length ? `\n${warn.length} thing(s) to fix before calling the wrap done.` : "\nAll clear — the wrap is complete.")
process.exit(warn.length ? 1 : 0)
