import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

// Guard, not a parser (brief 2026-10-12, Task 1).
//
// PostgREST `.range()` paging without `.order()` returns overlapping /
// shuffled pages once a table passes ~1,000 rows — it produced a false
// reconciliation failure in scripts/import-mail-records.mjs on 2026-10-12.
// This test fails the build if any `.range(` call in lib/, app/ or scripts/
// (minus scripts/archive/) is not preceded by `.order(` inside the same
// chained expression.
//
// Matcher: from each `.range(` walk BACKWARDS over the source, tracking
// bracket depth, until the expression starts — an unmatched `(` / `[` / `{`,
// or a top-level `=`, `;`, `,`, `}` or `{`. Everything between that point and
// `.range(` is "the chain"; it must contain `.order(`. That covers the three
// shapes used in this repo:
//
//   const { data, error } = await sb.from(t).select(c).order("id").range(a, b)
//   const { data, error } = await build().order("id").range(a, b)
//   q = q.order("id", { ascending: true }).range(a, b)
//
// It does not know about strings or comments, so a `)` inside a string
// literal before `.range(` could confuse it. If it misfires, fix the query
// shape rather than teaching the matcher more grammar.

const REPO = path.resolve(__dirname, "..")
const SCAN_DIRS = ["lib", "app", "scripts"]
const SKIP_DIRS = new Set([path.join("scripts", "archive"), "node_modules", ".next"])
const EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"])

function listSourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      const rel = path.relative(REPO, abs)
      if (SKIP_DIRS.has(rel) || entry.name === "node_modules") continue
      if (entry.isDirectory()) walk(abs)
      else if (EXTS.has(path.extname(entry.name))) out.push(abs)
    }
  }
  for (const d of SCAN_DIRS) if (fs.existsSync(path.join(REPO, d))) walk(path.join(REPO, d))
  return out.sort()
}

/** Text of the chained expression that ends at `src[rangeIdx]` (the `.` of `.range(`). */
export function chainBefore(src: string, rangeIdx: number): string {
  let depth = 0
  let i = rangeIdx - 1
  for (; i >= 0; i--) {
    const ch = src[i]
    if (ch === ")" || ch === "]" || ch === "}") {
      if (ch === "}" && depth === 0) break // end of a preceding block / object
      depth++
    } else if (ch === "(" || ch === "[" || ch === "{") {
      if (depth === 0) break // unmatched opener: we are its first argument / body
      depth--
    } else if (depth === 0 && (ch === "=" || ch === ";" || ch === ",")) {
      break
    }
  }
  return src.slice(i + 1, rangeIdx)
}

export function unorderedRangeCalls(src: string): number[] {
  const bad: number[] = []
  const re = /\.range\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    if (!chainBefore(src, m.index).includes(".order(")) bad.push(m.index)
  }
  return bad
}

function lineOf(src: string, idx: number): number {
  return src.slice(0, idx).split("\n").length
}

describe("ordered paging guard", () => {
  it("matcher: accepts an ordered chain and rejects an unordered one", () => {
    const ok = `const { data } = await sb.from("t").select("id").order("id", { ascending: true }).range(0, 999)\n`
    expect(unorderedRangeCalls(ok)).toEqual([])
    const multi = `    const { data, error } = await sb\n      .from("t")\n      .select("a, b")\n      .eq("x", 1)\n      .order("id", { ascending: true })\n      .range(from, from + PAGE - 1)\n`
    expect(unorderedRangeCalls(multi)).toEqual([])
    const viaBuilder = `const { data } = await build().order("id", { ascending: true }).range(off, off + 999)\n`
    expect(unorderedRangeCalls(viaBuilder)).toEqual([])
    const reassign = `q = q.order("id", { ascending: true }).range(from, from + 999)\n`
    expect(unorderedRangeCalls(reassign)).toEqual([])

    const bad = `const { data } = await sb.from("t").select("id").range(0, 999)\n`
    expect(unorderedRangeCalls(bad)).toHaveLength(1)
    // An .order() in a DIFFERENT statement does not count.
    const separate = `let q = sb.from("t").select("*").range(0, 9)\nq = q.order("id")\n`
    expect(unorderedRangeCalls(separate)).toHaveLength(1)
    const badBuilder = `const { data } = await build().range(off, off + 999)\n`
    expect(unorderedRangeCalls(badBuilder)).toHaveLength(1)
  })

  it("scans the expected source tree", () => {
    const files = listSourceFiles().map((f) => path.relative(REPO, f))
    expect(files.some((f) => f.startsWith("scripts/archive/"))).toBe(false)
    // Sanity: the known paging sites are in scope.
    for (const f of ["lib/leads.ts", "lib/relationships.ts", "app/api/leads/route.ts", "scripts/reply-review.mjs"]) {
      expect(files).toContain(f)
    }
  })

  it("every .range( call in lib/, app/, scripts/ is preceded by .order( in the same chain", () => {
    const offenders: string[] = []
    for (const file of listSourceFiles()) {
      const src = fs.readFileSync(file, "utf8")
      if (!src.includes(".range(")) continue
      for (const idx of unorderedRangeCalls(src)) {
        offenders.push(`${path.relative(REPO, file)}:${lineOf(src, idx)}`)
      }
    }
    expect(offenders, `.range( without .order( — add .order(<unique column>) (id as tiebreaker):\n${offenders.join("\n")}`).toEqual([])
  })
})
