// Market-cycle comps context (briefs/BRIEF_MARKET_CYCLE_TRACKER_2026-11-01.md §3.7).
// lib/cycleContext.ts (the /api/cycle/context route) must print exactly what
// scripts/market-cycle/cycle-context.py prints for the same data. Renders the
// shared fixture through both; the Python half is skipped when python3 is absent.
import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { NA, fnum, fsigned, renderCycleContext, type CycleContextData } from "@/lib/cycleContext"

const ROOT = path.resolve(__dirname, "..")
const FIXTURE = path.join(ROOT, "scripts/market-cycle/tests/fixtures/context_95123.json")
const SCRIPT = path.join(ROOT, "scripts/market-cycle/cycle-context.py")
const data = JSON.parse(fs.readFileSync(FIXTURE, "utf-8")) as CycleContextData

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}
function python(args: string[]): string[] {
  const out = execFileSync("python3", [SCRIPT, "--fixture", FIXTURE, "--json", ...args], { encoding: "utf-8" })
  return JSON.parse(out).lines
}

const CASES: Array<{ name: string; zip: string; price: number; exitMonth: string | null; today: string | null; args: string[] }> = [
  { name: "95123 $1.15M exit Apr 2027", zip: "95123", price: 1150000, exitMonth: "2027-04", today: null, args: ["--zip", "95123", "--price", "1150000", "--exit-month", "2027-04"] },
  { name: "95123 no exit", zip: "95123", price: 1150000, exitMonth: null, today: null, args: ["--zip", "95123", "--price", "1150000"] },
  { name: "95118 $2.4M, after the first formal review", zip: "95118", price: 2400000, exitMonth: "2028-12", today: "2027-02-01", args: ["--zip", "95118", "--price", "2400000", "--exit-month", "2028-12", "--today", "2027-02-01"] },
  { name: "exact tier edge $1.3M", zip: "95130", price: 1300000, exitMonth: "2026-10", today: null, args: ["--zip", "95130", "--price", "1300000", "--exit-month", "2026-10"] },
]

describe.skipIf(!hasPython())("TS block = Python block (same fixture)", () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(renderCycleContext(data, { zip: c.zip, price: c.price, exitMonth: c.exitMonth, today: c.today })).toEqual(python(c.args))
    })
  }
})

describe("renderCycleContext", () => {
  const lines = renderCycleContext(data, { zip: "95123", price: 1150000, exitMonth: "2027-04" })
  it("≤ 10 lines, labelled as context", () => {
    expect(lines.length).toBeLessThanOrEqual(10)
    expect(lines[0]).toMatch(/^MACRO CONTEXT \(market-cycle tracker\) — context, not comps/)
  })
  it("missing readings say n/a, never a number", () => {
    expect(lines[2]).toContain(`list-to-sale ${NA}`)
    expect(lines[3]).toContain(`days on site ${NA}`)
  })
  it("drift from the zip level series", () => {
    expect(lines[5]).toContain("60d -0.9% · 90d -1.4%")
  })
  it("no exit line without an exit month", () => {
    expect(renderCycleContext(data, { zip: "95123", price: 1150000 }).some((l) => l.startsWith("Exit"))).toBe(false)
  })
  it("rounding is half-up on the binary value and never prints -0.0", () => {
    expect(fnum(2.25, 1)).toBe("2.3")
    expect(fnum(-2.25, 1)).toBe("-2.3")
    expect(fnum(-0.04, 1)).toBe("0.0")
    expect(fsigned(0.04)).toBe("0.0%")
    expect(fsigned(1.25)).toBe("+1.3%")
  })
})
