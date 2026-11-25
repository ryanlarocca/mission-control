// Shared-notes save for the wrap check (2026-11-24).
//
// Several chats can wrap in the same minute. Each one used to see the others'
// open memo/deal files and hand-commit them, which grabbed files mid-edit under
// the wrong commit. Now ONE mechanism saves the notes for every chat:
//
//   • a lock, so only one wrap touches the memo repo at a time (the others wait);
//   • a settle check: a file that changed in the last `settleMs` is still being
//     written, so we wait for it (up to `waitMs`) and never commit it mid-edit;
//   • one neutral commit of every settled open file, by exact path (anything
//     another chat has staged outside those paths is left alone).
//
// Sync on purpose: wrap-check is a short script that prints one report.
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const git = (repo, ...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })

/** Open (modified / new / deleted) files under the pathspecs: [{ rel, xy, mtimeMs }] (mtimeMs 0 = deleted). */
export function openNotes(repo, pathspecs) {
  const out = git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...pathspecs)
  const parts = out.split("\0").filter(Boolean)
  const files = []
  for (let i = 0; i < parts.length; i++) {
    const xy = parts[i].slice(0, 2), rel = parts[i].slice(3)
    if (xy[0] === "R" || xy[0] === "C") i++ // a rename/copy is followed by its "from" path
    let mtimeMs = 0
    try { mtimeMs = fs.statSync(path.join(repo, rel)).mtimeMs } catch { /* deleted */ }
    files.push({ rel, xy, mtimeMs })
  }
  return files
}

function takeLock(lockDir, lockWaitMs, staleMs) {
  const t0 = Date.now()
  for (;;) {
    try {
      fs.mkdirSync(lockDir)
      fs.writeFileSync(path.join(lockDir, "owner"), `${process.pid} ${new Date().toISOString()}\n`)
      return true
    } catch (e) { if (e.code !== "EEXIST") throw e }
    let age = Infinity
    try { age = Date.now() - fs.statSync(lockDir).mtimeMs } catch { continue } // released between the two calls
    if (age > staleMs) { fs.rmSync(lockDir, { recursive: true, force: true }); continue } // a wrap that died
    if (Date.now() - t0 > lockWaitMs) return false
    sleep(500)
  }
}

/**
 * Save every settled open note file in one commit.
 * Returns { locked, committed: [rel], commit: sha|null, fresh: [{ rel, ageSec }], error: string|null }.
 *   locked=false  → another wrap held the lock the whole time; nothing was done.
 *   fresh         → files still changing after the wait; left alone for their chat.
 */
export function saveSharedNotes({ repo, pathspecs, lockDir, settleMs = 45_000, waitMs = 90_000, lockWaitMs = 120_000, staleMs = 300_000, pollMs = 5_000, before = null, message = "wrap: notes saved" }) {
  const res = { locked: true, committed: [], commit: null, fresh: [], error: null }
  if (!takeLock(lockDir, lockWaitMs, staleMs)) { res.locked = false; return res }
  try {
    if (before) before()
    const isFresh = (f) => f.mtimeMs && Date.now() - f.mtimeMs < settleMs
    const t0 = Date.now()
    let files = openNotes(repo, pathspecs)
    while (files.some(isFresh) && Date.now() - t0 < waitMs) {
      sleep(Math.min(pollMs, settleMs))
      files = openNotes(repo, pathspecs)
    }
    const fresh = files.filter(isFresh)
    res.fresh = fresh.map((f) => ({ rel: f.rel, ageSec: Math.round((Date.now() - f.mtimeMs) / 1000) }))
    const rels = files.filter((f) => !fresh.includes(f)).map((f) => f.rel)
    if (rels.length) {
      const body = `${message} (${rels.length} file${rels.length === 1 ? "" : "s"})\n\n${rels.map((r) => "- " + r).join("\n")}\n`
      const commit = () => {
        git(repo, "add", "-A", "--", ...rels)
        git(repo, "commit", "-q", "-m", body, "--", ...rels) // only these paths, whatever else is staged
      }
      try { commit() } catch (e) {
        if (!/index\.lock/.test(String(e.stderr || e.message))) throw e
        sleep(2000); commit() // another git command was mid-write; once more
      }
      res.committed = rels
      res.commit = git(repo, "rev-parse", "--short", "HEAD").trim()
    }
  } catch (e) {
    res.error = String(e.stderr || e.message).trim().split("\n").pop()
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true })
  }
  return res
}
