import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

// BRIEF_TRIAGE_SONNET_DEDUPE_MATCHLINK_2026-10-21 §1: every lead-reading
// model call runs on Sonnet 5 and the HAIKU constant is gone from lib/llm,
// so nothing can regress to Haiku. This is a plain fs scan of lib/ and app/
// for the model id. lib/mockData.ts is display-only fixture data (fake
// history rows) and is excluded.

const ROOT = join(__dirname, "..")
const SKIP = new Set(["lib/mockData.ts"])
const EXT = /\.(ts|tsx|js|mjs)$/

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (EXT.test(name)) out.push(p)
  }
  return out
}

describe("no Haiku model id under lib/ or app/", () => {
  it("references claude-sonnet-5 only", () => {
    const offenders: string[] = []
    for (const top of ["lib", "app"]) {
      for (const file of walk(join(ROOT, top))) {
        const rel = relative(ROOT, file)
        if (SKIP.has(rel)) continue
        const src = readFileSync(file, "utf8")
        if (/claude-haiku/i.test(src) || /\bHAIKU\b/.test(src)) offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
  })
})
