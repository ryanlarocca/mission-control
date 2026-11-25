#!/usr/bin/env node
// Wrap check (2026-11-17): the last step of every wrap. Proves nothing was left
// half-saved, then starts a background backup so the day's work is in Drive now
// instead of at 3 AM. Prints for the agent only; never messages Ryan.
//
//   node scripts/wrap-check.mjs              # from the worktree you worked in (or the main checkout)
//   node scripts/wrap-check.mjs --no-backup  # skip the background backup
//   node scripts/wrap-check.mjs --no-save    # look only: don't commit the shared notes
//
// SEVERAL CHATS CAN WRAP AT ONCE (2026-11-24). The memo repo and the Board are
// shared, so this check sees every chat's open notes. It saves them itself:
// it takes a lock (one wrap at a time), waits for files that changed in the
// last 45 s to settle, then commits every open memo/deal file in ONE neutral
// commit and fixes the index dates. So: never hand-commit another chat's memo
// or deal file to get to "All clear". Run this check; it does it safely. If it
// says a file is still being written, or a card's notes just changed, another
// chat is mid-wrap: run the check again in a minute.
//
// Checks: code committed + pushed, main checkout current (fast-forwards it if
// clean), ~/Projects memo repo committed, Projects page synced, memo format
// (📍 block size, Updated vs changelog, index date), deals index, one memory
// folder + index links, backup health, the Board (every card dated; a card
// whose notes changed today after its last update = a project moved but its
// card didn't). Exit 1 when anything needs attention.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { saveSharedNotes, openNotes } from "./wrap-notes.mjs"

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

// ── 3. ~/Projects memo repo (local-only, no remote): save the notes for every open chat ──
const NOTE_PATHS = ["PROJECTS/MEMO_INDEX.md", "PROJECTS/*/PROJECT_MEMO.md", "PROJECTS/*/CHANGELOG.md", "PROJECTS/*/WHERE_WE_LEFT_OFF_ARCHIVE.md", "PROJECTS/deals"]
/** "Last touched" in MEMO_INDEX trails a memo's Updated date → set it (mechanical, so no chat has to). */
function bumpIndexDates() {
  const p = path.join(MEMOS, "MEMO_INDEX.md")
  const lines = fs.readFileSync(p, "utf8").split("\n")
  let changed = 0
  for (const dir of fs.readdirSync(MEMOS)) {
    const memoPath = path.join(MEMOS, dir, "PROJECT_MEMO.md")
    if (dir.startsWith("_") || !fs.existsSync(memoPath)) continue
    const updated = /\*\*Updated:\*\*\s*(\d{4}-\d{2}-\d{2})/.exec(fs.readFileSync(memoPath, "utf8"))?.[1]
    const i = lines.findIndex((l) => l.includes(`](${dir}/PROJECT_MEMO.md)`))
    const m = i >= 0 && /\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*$/.exec(lines[i])
    if (updated && m && updated > m[1]) { lines[i] = lines[i].replace(/\|\s*\d{4}-\d{2}-\d{2}\s*\|\s*$/, `| ${updated} |`); changed++ }
  }
  if (changed) fs.writeFileSync(p, lines.join("\n"))
  return changed
}
{
  const short = (rels) => rels.map((r) => r.replace(/^PROJECTS\//, "")).join(", ")
  if (args.has("--no-save")) {
    let open = null
    try { open = openNotes(PROJECTS_REPO, NOTE_PATHS) } catch { /* below */ }
    if (open === null) bad("Couldn't read the ~/Projects repo")
    else if (open.length) bad(`Memo repo has uncommitted memo/deal files (run without --no-save to save them): ${short(open.map((f) => f.rel))}`)
    else good("Memos + deals committed in ~/Projects")
  } else {
    let bumped = 0
    const r = saveSharedNotes({ repo: PROJECTS_REPO, pathspecs: NOTE_PATHS, lockDir: path.join(HOME, ".claude/wrap-check.lock"), before: () => { bumped = bumpIndexDates() } })
    if (!r.locked) bad("Another chat's wrap held the notes lock for 2 minutes. Run the check again.")
    else if (r.error) bad(`Couldn't save the notes in ~/Projects: ${r.error}`)
    else {
      if (r.committed.length) good(`Notes saved for every open chat: ${r.committed.length} file(s) in one commit (${r.commit}): ${short(r.committed)}${bumped ? ` · ${bumped} index date(s) fixed` : ""}`)
      else good("Memos + deals committed in ~/Projects")
      if (r.fresh.length) bad(`Still being written right now (another chat is mid-wrap), left alone: ${r.fresh.map((f) => `${f.rel.replace(/^PROJECTS\//, "")} (${f.ageSec} s ago)`).join(", ")}. Run the check again in a minute.`)
    }
  }
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

// ── 7b. the Board: a project that moved today must have its card updated ────
{
  const boardCli = path.join(path.dirname(fileURLToPath(import.meta.url)), "board.mjs")
  let out = null
  try { out = execFileSync(process.execPath, [boardCli, "check", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }
  catch (e) { out = e.stdout ? String(e.stdout) : null; if (!out) bad(`Board check failed: ${String(e.stderr || e.message).trim().split("\n").pop()}`) }
  if (out) {
    try {
      const r = JSON.parse(out.trim().split("\n").pop())
      const FRESH_MIN = 10
      const behind = new Map((r.behind || []).map((b) => [b.key, b]))
      for (const p of r.problems) {
        const b = behind.get(p.split(":")[0])
        if (!b || !/changed today after/.test(p)) { bad(`Board: ${p}`); continue }
        const newest = Math.max(...b.files.map((f) => Date.parse(f.mtime)))
        const min = Math.round((Date.now() - newest) / 60000)
        const at = new Date(newest).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" })
        const files = b.files.map((f) => f.rel).join(", ")
        if (min < FRESH_MIN) bad(`Board: ${b.key} ("${b.title}"): its notes (${files}) changed ${min} min ago. If that project is yours, update its card. If not, another chat is wrapping it right now: run the check again in a few minutes.`)
        else bad(`Board: ${b.key} ("${b.title}"): its notes (${files}) changed at ${at} and the card wasn't updated since. Whichever chat you are: read those notes and bring the card up to date (board.mjs update ${b.key} --next "status · next step" --due …), or board.mjs touch ${b.key} --why "…" only if the card is still right.`)
      }
      const extra = [r.back && `${r.back} back from hold`, r.overdue && `${r.overdue} past their check-in`, r.stale && `${r.stale} stale`].filter(Boolean).join(", ")
      if (!r.problems.length) good(`Board: ${r.open} cards, all dated, none behind their notes${extra ? ` (morning refresh: ${extra})` : ""}`)
    } catch { bad(`Board check printed something unexpected: ${out.slice(0, 200)}`) }
  }
}
// Also ask yourself at every wrap: did this chat start a multi-week project with no card? Ask Ryan in one line.

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
