// The shared-notes save behind `scripts/wrap-check.mjs`: several chats wrap at
// once, one mechanism commits everyone's settled notes and never a file that is
// still being written. Runs against throwaway git repos in the temp folder.
import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawn } from "node:child_process"
import { openNotes, saveSharedNotes } from "../scripts/wrap-notes.mjs"

const made: string[] = []
const git = (repo: string, ...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim()

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wrap-notes-"))
  made.push(repo)
  git(repo, "init", "-q")
  git(repo, "config", "user.email", "test@example.com")
  git(repo, "config", "user.name", "Test")
  fs.mkdirSync(path.join(repo, "notes"))
  fs.mkdirSync(path.join(repo, "other"))
  fs.writeFileSync(path.join(repo, "notes/a.md"), "a1\n")
  fs.writeFileSync(path.join(repo, "notes/b.md"), "b1\n")
  fs.writeFileSync(path.join(repo, "other/c.txt"), "c1\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", "start")
  return repo
}
/** Make a file look like it was last written `sec` seconds ago. */
function age(file: string, sec: number) {
  const t = new Date(Date.now() - sec * 1000)
  fs.utimesSync(file, t, t)
}
const opts = (repo: string) => ({ repo, pathspecs: ["notes"], lockDir: path.join(repo, ".wrap.lock"), settleMs: 2000, waitMs: 0, pollMs: 100, lockWaitMs: 3000 })

afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

describe("saveSharedNotes", () => {
  it("commits every settled open file (changed, new, deleted) in one commit", () => {
    const repo = makeRepo()
    fs.writeFileSync(path.join(repo, "notes/a.md"), "a2\n"); age(path.join(repo, "notes/a.md"), 60)
    fs.writeFileSync(path.join(repo, "notes/new.md"), "n1\n"); age(path.join(repo, "notes/new.md"), 60)
    fs.rmSync(path.join(repo, "notes/b.md"))
    const before = Number(git(repo, "rev-list", "--count", "HEAD"))

    const r = saveSharedNotes(opts(repo))

    expect(r.error).toBeNull()
    expect(r.committed.sort()).toEqual(["notes/a.md", "notes/b.md", "notes/new.md"])
    expect(Number(git(repo, "rev-list", "--count", "HEAD"))).toBe(before + 1)
    expect(openNotes(repo, ["notes"])).toEqual([])
    expect(git(repo, "log", "-1", "--format=%B")).toContain("- notes/new.md")
    expect(fs.existsSync(path.join(repo, ".wrap.lock"))).toBe(false)
  })

  it("leaves a file that is still being written, and reports it", () => {
    const repo = makeRepo()
    fs.writeFileSync(path.join(repo, "notes/a.md"), "a2\n"); age(path.join(repo, "notes/a.md"), 60)
    fs.writeFileSync(path.join(repo, "notes/b.md"), "b-mid-edit\n") // written just now

    const r = saveSharedNotes(opts(repo))

    expect(r.committed).toEqual(["notes/a.md"])
    expect(r.fresh.map((f: { rel: string }) => f.rel)).toEqual(["notes/b.md"])
    expect(git(repo, "status", "--porcelain", "--", "notes")).toBe("M notes/b.md")
  })

  it("waits for a fresh file to settle, then commits it", () => {
    const repo = makeRepo()
    fs.writeFileSync(path.join(repo, "notes/b.md"), "b2\n") // fresh now; settles within the wait
    const r = saveSharedNotes({ ...opts(repo), settleMs: 400, waitMs: 3000, pollMs: 100 })
    expect(r.fresh).toEqual([])
    expect(r.committed).toEqual(["notes/b.md"])
  })

  it("does not sweep in what another chat staged outside the notes paths", () => {
    const repo = makeRepo()
    fs.writeFileSync(path.join(repo, "other/c.txt"), "c2\n")
    git(repo, "add", "other/c.txt") // someone else's staged work
    fs.writeFileSync(path.join(repo, "notes/a.md"), "a2\n"); age(path.join(repo, "notes/a.md"), 60)

    const r = saveSharedNotes(opts(repo))

    expect(r.committed).toEqual(["notes/a.md"])
    expect(git(repo, "show", "--stat", "--format=", "HEAD")).not.toContain("other/c.txt")
    expect(git(repo, "status", "--porcelain")).toBe("M  other/c.txt")
  })

  it("does nothing while another wrap holds the lock, and takes over a dead one", () => {
    const repo = makeRepo()
    fs.writeFileSync(path.join(repo, "notes/a.md"), "a2\n"); age(path.join(repo, "notes/a.md"), 60)
    const lock = path.join(repo, ".wrap.lock")
    fs.mkdirSync(lock) // a live wrap

    const held = saveSharedNotes({ ...opts(repo), lockWaitMs: 300 })
    expect(held.locked).toBe(false)
    expect(held.committed).toEqual([])
    expect(fs.existsSync(lock)).toBe(true)

    age(lock, 600) // that wrap died ten minutes ago
    const taken = saveSharedNotes({ ...opts(repo), staleMs: 300_000 })
    expect(taken.locked).toBe(true)
    expect(taken.committed).toEqual(["notes/a.md"])
  })

  it("two wraps at the same moment: one commit, no errors, nothing left open", async () => {
    const repo = makeRepo()
    for (const f of ["a.md", "b.md"]) { fs.writeFileSync(path.join(repo, "notes", f), "changed\n"); age(path.join(repo, "notes", f), 60) }
    const before = Number(git(repo, "rev-list", "--count", "HEAD"))
    const script = `import { saveSharedNotes } from ${JSON.stringify(path.resolve(__dirname, "../scripts/wrap-notes.mjs"))}
      const r = saveSharedNotes(${JSON.stringify(opts(repo))}); console.log(JSON.stringify(r))`
    const run = () => new Promise<{ committed: string[]; error: string | null; locked: boolean }>((resolve, reject) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", script]); let out = ""
      p.stdout.on("data", (d) => (out += d)); p.on("error", reject); p.on("close", () => resolve(JSON.parse(out)))
    })

    const [x, y] = await Promise.all([run(), run()])

    expect([x.error, y.error]).toEqual([null, null])
    expect([x.locked, y.locked]).toEqual([true, true])
    expect([...x.committed, ...y.committed].sort()).toEqual(["notes/a.md", "notes/b.md"])
    expect(Number(git(repo, "rev-list", "--count", "HEAD"))).toBe(before + 1)
    expect(openNotes(repo, ["notes"])).toEqual([])
  })
})
