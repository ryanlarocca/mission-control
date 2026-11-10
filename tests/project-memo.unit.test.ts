import { describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  LEFT_OFF_MAX, capMarkdown, cleanShipTitle, headerField, parseLeftOff, parseMemo, parseShips, parseStatus, stripInline,
} from "@/lib/projectMemo"
import {
  countsLine, groupProjects, isStaleActive, isSyncStale, newestSync, projectLine, recentlyTouched, relativeAgo,
  type ProjectSummary,
} from "@/lib/projectsView"
import * as syncModule from "../scripts/projects-sync.mjs"
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { collect } = syncModule as unknown as Record<string, any>

// Projects page (Mission Control 2.0, Part D, 2026-11-10): the memo parser the
// Mac mini's scripts/projects-sync.mjs runs, and the page's pure helpers.

const MEMO_WITH_PLAIN = `# Lead Pipeline (CRMS Phase 7)

> **Status:** 🟢 Active — all capture / triage / drip paths live; actively shipping
> **Plain:** The Leads tab: every call, text, email and web form.
> **Owns:** the **Leads tab** of Mission Control — Twilio capture, \`drip engine\`
> **Updated:** 2026-11-10  ·  **Changelog:** [CHANGELOG.md](./CHANGELOG.md)
> **Index:** [MEMO_INDEX](../MEMO_INDEX.md)

## 📍 Where we left off
- **Now —** Mailer credit is live.
- **Next —** Phase 2 before a second list.
- **Blockers / open —** none

## 🎯 Scope
**Owns:** everything
`

const MEMO_NO_PLAIN = `# Agent Email Campaign (v1)

> **Status:** 🪦 Dormant — superseded by agent-email-v2; list exhausted 2026-05-05
> **Owns:** _(historical)_ 2,500-agent Gmail outreach
> **Updated:** 2026-09-02  ·  **Changelog:** _none_

## 📍 Where we left off
- **Nov 10 (late morning) — One "Draft:" for every alert** (\`70b70b5\`, LIVE).
- **Nov 9 (afternoon) — Signed contracts update the lead card** (\`150240d\`).

### Before 10-29
- **Now (parked 10-28):** one outreach list of 110 sellers.

## 🎯 Original intent
Old stuff.
`

describe("header parsing", () => {
  it("reads name, status, Plain, Owns and Updated", () => {
    const { row, warnings } = parseMemo(MEMO_WITH_PLAIN, { slug: "lead-pipeline" })
    expect(warnings).toEqual([])
    expect(row.name).toBe("Lead Pipeline (CRMS Phase 7)")
    expect(row.status).toBe("active")
    expect(row.status_line).toBe("all capture / triage / drip paths live; actively shipping")
    expect(row.plain).toBe("The Leads tab: every call, text, email and web form.")
    expect(row.owns).toBe("the Leads tab of Mission Control — Twilio capture, drip engine")
    expect(row.updated_on).toBe("2026-11-10")
    expect(row.archived).toBe(false)
    expect(row.ships).toEqual([])
  })

  it("a memo without Plain: plain is null, the rest still parses", () => {
    const { row, warnings } = parseMemo(MEMO_NO_PLAIN, { slug: "agent-email-campaign" })
    expect(warnings).toEqual([])
    expect(row.plain).toBeNull()
    expect(row.status).toBe("retired")
    expect(row.owns).toBe("(historical) 2,500-agent Gmail outreach")
    expect(row.updated_on).toBe("2026-09-02")
  })

  it("Updated with a note after the date; colon outside the bold", () => {
    const memo = "# X\n\n> **Status**: 🟢 Active\n> **Updated:** 2026-11-10 (first Short live)  ·  **Changelog:** x\n"
    expect(headerField(memo, "Status")).toBe("🟢 Active")
    expect(parseMemo(memo, { slug: "x" }).row.updated_on).toBe("2026-11-10")
  })

  it("only the header block counts — a **Owns:** in the body is ignored", () => {
    expect(headerField(MEMO_NO_PLAIN.replace("> **Owns:** _(historical)_ 2,500-agent Gmail outreach\n", ""), "Owns")).toBeNull()
  })

  it("no title → folder name + warning; no Status → planning + a warning naming the memo", () => {
    const { row, warnings } = parseMemo("Build a UI button.\n", { slug: "project-manager-ui" })
    expect(row.name).toBe("project-manager-ui")
    expect(row.status).toBe("planning")
    expect(warnings.join("\n")).toMatch(/project-manager-ui: no Status line — showing it as Planning/)
  })

  it("anything under _archive is retired + archived, whatever it says, without a warning", () => {
    const { row, warnings } = parseMemo(MEMO_WITH_PLAIN, { slug: "lead-pipeline", archived: true })
    expect(row.status).toBe("retired")
    expect(row.archived).toBe(true)
    expect(warnings).toEqual([])
    expect(parseMemo("no header", { slug: "old", archived: true }).warnings.join()).not.toMatch(/Planning/)
  })

  it("unknown status → planning, warning names the memo", () => {
    const { row, warnings } = parseMemo("# Y\n\n> **Status:** 🔴 Blocked on Ryan\n> **Updated:** 2026-11-01\n", { slug: "y" })
    expect(row.status).toBe("planning")
    expect(row.status_line).toBe("Blocked on Ryan")
    expect(warnings).toEqual([`y: status "🔴 Blocked on Ryan" not recognised — showing it as Planning`])
  })
})

describe("status forms", () => {
  const cases: [string, string, string | null][] = [
    ["🟢 Active — offer bot v1 live (2026-10-15)", "active", "offer bot v1 live (2026-10-15)"],
    ["🟢 Active (phase 1 live 2026-11-02)", "active", "phase 1 live 2026-11-02"],
    ["🟢 Active", "active", null],
    ["🟢 v0 live (search only)", "active", "v0 live (search only)"],
    ["🟢 LIVE + RAMPING — **10/15: AUTOPILOT LIVE**; 7 send days", "active", "10/15: AUTOPILOT LIVE; 7 send days"],
    ["🟢 **44 sellers in Leads; 37 on autopilot**", "active", "44 sellers in Leads; 37 on autopilot"],
    ["🟡 Planning — designed 2026-11-07, build not started", "planning", "designed 2026-11-07, build not started"],
    ["🟡 Planning / Development — 24-source concept", "planning", "24-source concept"],
    ["⏸ Parked — Aug 2026 study finished", "parked", "Aug 2026 study finished"],
    ["⏸️ Parked — with the variation selector", "parked", "with the variation selector"],
    ["🪦 Dormant — superseded; shipped live inside the Leads tab", "retired", "superseded; shipped live inside the Leads tab"],
    ["🪦 Retired — Ryan retired it 2026-11-10", "retired", "Ryan retired it 2026-11-10"],
    // No emoji: the words decide (first one in the line wins).
    ["Active — no emoji", "active", "no emoji"],
    ["LIVE since Oct", "active", "since Oct"],
    ["live in prod", "active", "in prod"],
    ["Planning — next quarter", "planning", "next quarter"],
    ["Parked until January", "parked", "until January"],
    ["Dormant — superseded, the thing went live elsewhere", "retired", "superseded, the thing went live elsewhere"],
    ["Retired", "retired", null],
  ]
  for (const [raw, status, line] of cases) {
    it(raw, () => {
      expect(parseStatus(raw)).toEqual({ status, statusLine: line })
    })
  }
  it("unrecognised / missing", () => {
    expect(parseStatus("Something else entirely").status).toBeNull()
    expect(parseStatus(null)).toEqual({ status: null, statusLine: null })
  })
})

describe("where we left off", () => {
  it("Now / Next / Blockers bullets, up to the next ## heading", () => {
    expect(parseLeftOff(MEMO_WITH_PLAIN)).toBe(
      "- **Now —** Mailer credit is live.\n- **Next —** Phase 2 before a second list.\n- **Blockers / open —** none",
    )
  })

  it("dated bullets, keeping ### sub-sections", () => {
    const body = parseLeftOff(MEMO_NO_PLAIN)!
    expect(body.startsWith("- **Nov 10 (late morning) — One \"Draft:\" for every alert**")).toBe(true)
    expect(body).toContain("### Before 10-29")
    expect(body).toContain("one outreach list of 110 sellers.")
    expect(body).not.toContain("Original intent")
  })

  it("missing section → null", () => {
    expect(parseLeftOff("# X\n\n## 🎯 Scope\nstuff")).toBeNull()
  })

  it("capped at 6,000 chars at a line break, with …", () => {
    const long = `# X\n\n## 📍 Where we left off\n${Array.from({ length: 400 }, (_, i) => `- line ${i} ${"x".repeat(20)}`).join("\n")}\n`
    const out = parseLeftOff(long)!
    expect(out.length).toBeLessThanOrEqual(LEFT_OFF_MAX)
    expect(out.endsWith("\n…")).toBe(true)
    expect(out.split("\n").slice(-2)[0]).toMatch(/^- line \d+ x{20}$/)
    expect(capMarkdown("short", 100)).toBe("short")
  })
})

describe("changelog → ships", () => {
  it("strips commit hashes and trailing (…LIVE) parentheticals", () => {
    expect(cleanShipTitle("Signed contracts update the lead card automatically (`150240d`)")).toBe("Signed contracts update the lead card automatically")
    expect(cleanShipTitle("Mailer credit: anyone on a mailed list counts (`8b58f5a`, LIVE)")).toBe("Mailer credit: anyone on a mailed list counts")
    expect(cleanShipTitle("One \"Draft:\" for every alert (`70b70b5`, `5628b68`, LIVE)")).toBe("One \"Draft:\" for every alert")
    expect(cleanShipTitle("Basket dial moved to Tiingo (free key, capped); base fixed (main 726971f)")).toBe("Basket dial moved to Tiingo (free key, capped); base fixed")
    expect(cleanShipTitle("First live weekly write + digit fix (PR #5)")).toBe("First live weekly write + digit fix")
    expect(cleanShipTitle("Money parser (`cea96d1`, tests `b6972c4`)")).toBe("Money parser")
    expect(cleanShipTitle("Replies land on the card (owned by `lead-pipeline`)")).toBe("Replies land on the card (owned by lead-pipeline)")
    expect(cleanShipTitle("Ramp decisions applied (`c08545a`, live on the Mac mini): catch-all never on offers")).toBe("Ramp decisions applied (live on the Mac mini): catch-all never on offers")
    expect(cleanShipTitle("PR #2 merged (`8ed4626`), touch one runs unattended.")).toBe("PR #2 merged, touch one runs unattended")
  })

  const CHANGELOG = `# Lead Pipeline — CHANGELOG

## Ship index
- 2026-11-10 — index line (ignored when ## entries exist)

## 2026-11-07 (evening) — "draft:" works on lead alerts (\`d7623d4\`, LIVE)
body
## 2026-11-09 (afternoon) — Signed contracts update the lead card automatically (\`150240d\`)
body
## 2026-11-10 — One "Draft:" for every alert: alerts remember who they're about (\`70b70b5\`, \`5628b68\`, LIVE)
## 2026-11-10 — Mailer credit LIVE (\`8b58f5a\`, LIVE)
### 2026-11-08 — a sub-entry, not a ship
## 2026-11-07 → 11-09 — Limewood: first long-form video
## 2026-11-07 (evening) — "draft:" works on lead alerts (\`d7623d4\`, LIVE)
`

  it("## headings: newest first, same-day file order kept, duplicates dropped, ### ignored", () => {
    expect(parseShips(CHANGELOG)).toEqual([
      { date: "2026-11-10", title: "One \"Draft:\" for every alert: alerts remember who they're about" },
      { date: "2026-11-10", title: "Mailer credit LIVE" },
      { date: "2026-11-09", title: "Signed contracts update the lead card automatically" },
      { date: "2026-11-07", title: "\"draft:\" works on lead alerts" },
      { date: "2026-11-07", title: "Limewood: first long-form video" },
    ])
  })

  it("up to 8", () => {
    const many = Array.from({ length: 12 }, (_, i) => `## 2026-10-${String(i + 10).padStart(2, "0")} — ship ${i}`).join("\n")
    const ships = parseShips(many)
    expect(ships).toHaveLength(8)
    expect(ships[0]).toEqual({ date: "2026-10-21", title: "ship 11" })
  })

  it("falls back to a Ship index, then to **Month D, YYYY** bullets", () => {
    expect(parseShips("## Ship index\n\n- 2026-11-01 — Money parser fix\n- 2026-10-24 — Drive reorg (`1e44ff5`)\n")).toEqual([
      { date: "2026-11-01", title: "Money parser fix" },
      { date: "2026-10-24", title: "Drive reorg" },
    ])
    const v2 = "---\n\n- **November 10, 2026** — **Two texts made two cards; fixed (`0b63ba2`, live on Vercel).** Body text.\n\n- **October 27, 2026 (late morning)** — **Ramp decisions applied.** More.\n"
    expect(parseShips(v2)).toEqual([
      { date: "2026-11-10", title: "Two texts made two cards; fixed" },
      { date: "2026-10-27", title: "Ramp decisions applied" },
    ])
  })

  it("no changelog / no entries → []", () => {
    expect(parseShips(null)).toEqual([])
    expect(parseShips("# X — CHANGELOG\n\n_No ships logged yet._\n")).toEqual([])
  })
})

describe("stripInline", () => {
  it("links, bold, italics, code", () => {
    expect(stripInline("→ [lrg-public-web](../lrg-public-web/PROJECT_MEMO.md) **bold** _it_ `code`")).toBe("→ lrg-public-web bold it code")
    expect(stripInline("drip_campaign_type stays")).toBe("drip_campaign_type stays")
  })
})

describe("sync script walk", () => {
  it("skips mission-control, _tmp*, folders without a memo; _archive rows are retired", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "projects-sync-"))
    const put = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), text)
    }
    put("lead-pipeline/PROJECT_MEMO.md", MEMO_WITH_PLAIN)
    put("lead-pipeline/CHANGELOG.md", "## 2026-11-09 — A ship (`150240d`)\n")
    put("mission-control/PROJECT_MEMO.md", MEMO_WITH_PLAIN)
    put("_tmp_audit/PROJECT_MEMO.md", MEMO_WITH_PLAIN)
    put("no-memo/README.md", "hi")
    put("_archive/agent-email-campaign/PROJECT_MEMO.md", MEMO_NO_PLAIN)
    put("_archive/lead-pipeline/PROJECT_MEMO.md", MEMO_NO_PLAIN)
    const { rows, warnings } = collect(root)
    expect(rows.map((r: { slug: string }) => r.slug)).toEqual(["lead-pipeline", "agent-email-campaign"])
    expect(rows[0].ships).toEqual([{ date: "2026-11-09", title: "A ship" }])
    expect(rows[1]).toMatchObject({ status: "retired", archived: true })
    expect(warnings.join("\n")).toMatch(/lead-pipeline: memo in both/)
    fs.rmSync(root, { recursive: true, force: true })
  })
})

describe("page helpers", () => {
  const now = new Date("2026-11-10T20:00:00Z") // Nov 10, 2026, 12:00 PM Pacific
  const p = (o: Partial<ProjectSummary>): ProjectSummary => ({
    slug: "s", name: "S", status: "active", status_line: null, plain: null, owns: null,
    updated_on: "2026-11-10", archived: false, synced_at: "2026-11-10T19:00:00Z", ...o,
  })

  it("groups in order, most recently touched first, archived → retired", () => {
    const g = groupProjects([
      p({ slug: "a", name: "A", updated_on: "2026-10-01" }),
      p({ slug: "b", name: "B", updated_on: "2026-11-09" }),
      p({ slug: "c", name: "C", status: "parked" }),
      p({ slug: "d", name: "D", archived: true }),
      p({ slug: "e", name: "E", updated_on: null }),
    ])
    expect(g.active.map((r) => r.slug)).toEqual(["b", "a", "e"])
    expect(g.parked.map((r) => r.slug)).toEqual(["c"])
    expect(g.retired.map((r) => r.slug)).toEqual(["d"])
    expect(countsLine(g)).toBe("3 active · 0 planning · 1 parked")
  })

  it("amber when Active and untouched 30+ days (Pacific)", () => {
    expect(isStaleActive(p({ updated_on: "2026-10-11" }), now)).toBe(true)
    expect(isStaleActive(p({ updated_on: "2026-10-12" }), now)).toBe(false)
    expect(isStaleActive(p({ updated_on: "2026-01-01", status: "parked" }), now)).toBe(false)
  })

  it("line falls back plain → status_line → owns", () => {
    expect(projectLine(p({ plain: "P", status_line: "S", owns: "O" }))).toBe("P")
    expect(projectLine(p({ status_line: "S", owns: "O" }))).toBe("S")
    expect(projectLine(p({ owns: "O" }))).toBe("O")
  })

  it("sync freshness", () => {
    const rows = [p({ synced_at: "2026-11-09T01:00:00Z" }), p({ synced_at: "2026-11-10T19:48:00Z" })]
    expect(newestSync(rows)).toBe("2026-11-10T19:48:00Z")
    expect(relativeAgo("2026-11-10T19:48:00Z", now)).toBe("12 min ago")
    expect(isSyncStale("2026-11-09T07:59:00Z", now)).toBe(true)
    expect(isSyncStale("2026-11-09T08:01:00Z", now)).toBe(false)
    expect(isSyncStale(null, now)).toBe(false)
  })

  it("Today card: five most recent non-retired", () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => p({ slug: `p${i}`, name: `P${i}`, updated_on: `2026-11-0${i + 1}` })),
      p({ slug: "old", status: "retired", updated_on: "2026-11-10" }),
      p({ slug: "arch", archived: true, updated_on: "2026-11-10" }),
    ]
    expect(recentlyTouched(rows).map((r) => r.slug)).toEqual(["p5", "p4", "p3", "p2", "p1"])
  })
})
