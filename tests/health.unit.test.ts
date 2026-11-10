import { describe, it, expect } from "vitest"
import { agoWords, buildHealthView, shapeHealthSpend, type HealthPayload } from "@/lib/health"
import { featureName, laneLabel } from "@/lib/llmFeatures"
import type { MiniJob, MiniSnapshot } from "@/lib/miniStatus"
import * as spendReport from "../scripts/llm-spend-report.mjs"

// Health page v1 (Mission Control 2.0, Part E, 2026-11-10): AI-spend shaping,
// the plain-words view, and the feature-name copy staying in step with the
// Telegram spend report.

const NOW = new Date("2026-11-10T21:30:00Z") // 1:30 PM Pacific

function job(label: string, name: string, ok = true): MiniJob {
  return { label, name, schedule: "every 5 min", keepAlive: false, loaded: true, running: false, pid: null, lastExit: ok ? 0 : 1, ok, state: ok ? "last run ok" : "last run failed" }
}

function snapshot(over: Partial<MiniSnapshot> = {}): MiniSnapshot {
  return {
    version: 1,
    at: "2026-11-10T21:28:00Z",
    jobs: [job("com.lrghomes.judge", "The judge"), job("com.lrghomes.mini-backup", "Nightly backup")],
    bridge: { running: true, connected: true, note: null, sessions: 3, capacity: 32, full: false, loginDaysLeft: 26 },
    backup: { lastAt: "2026-11-10T11:10:00Z", failedSince: false, errAt: null },
    helper: { ok: true, pid: 87149, error: null },
    textHistory: { refreshedAt: "2026-11-10T21:08:00Z", stale: false },
    disk: { freeGb: 63 },
    uptime: { bootAt: "2026-10-31T00:25:04Z" },
    errors: [],
    ...over,
  }
}

function payload(over: Partial<HealthPayload> = {}, snap: MiniSnapshot | null = snapshot()): HealthPayload {
  return {
    generatedAt: NOW.toISOString(),
    heartbeat: { beatAt: "2026-11-10T21:29:20Z", watchdogAt: "2026-11-10T21:26:00Z", freeGb: 63, lowSpace: false },
    status: snap ? { reportedAt: "2026-11-10T21:28:00Z", snapshot: snap } : null,
    judge: { at: "2026-11-10T21:15:00Z" },
    jackie: { on: true, since: "2026-10-27T17:00:00Z", callsWeek: 4 },
    spend: shapeHealthSpend([{ lane: "drafts", tag: "[reply/auto]", calls: 10, cost_usd: "12.5" }], [], "Nov"),
    errors: {},
    ...over,
  }
}

describe("shapeHealthSpend", () => {
  it("totals by key and the top five features", () => {
    const month = [
      { lane: "drafts", tag: "[reply/auto]", calls: 40, cost_usd: "10.00" },
      { lane: "drafts", tag: "[reply/coach]", calls: 5, cost_usd: "4.00" },
      { lane: "background", tag: "[judge]", calls: 200, cost_usd: "6.5" },
      { lane: "background", tag: "[inbox-agent]", calls: 90, cost_usd: 3 },
      { lane: "background", tag: "[classify]", calls: 10, cost_usd: 1 },
      { lane: "background", tag: "[market-cycle]", calls: 1, cost_usd: 0.5 },
      { lane: "background", tag: "[lead-stage]", calls: 1, cost_usd: 0.25 },
      { lane: "background", tag: "[summary]", calls: 1, cost_usd: 0.001 },
    ]
    const yesterday = [
      { lane: "drafts", tag: "[reply/auto]", calls: 3, cost_usd: "1.25" },
      { lane: "background", tag: "[judge]", calls: 10, cost_usd: "0.5" },
    ]
    const s = shapeHealthSpend(month, yesterday, "Nov")
    expect(s.monthUsd).toBe(25.25)
    expect(s.yesterdayUsd).toBe(1.75)
    expect(s.monthPct).toBeCloseTo(25.25)
    expect(s.lanes).toEqual([
      { key: "drafts", label: "Drafts & coaching", monthUsd: 14, yesterdayUsd: 1.25 },
      { key: "background", label: "Background jobs", monthUsd: 11.25, yesterdayUsd: 0.5 },
    ])
    // [inbox-agent] and [classify] are both "Inbox agent".
    expect(s.top.map((f) => f.name)).toEqual(["Auto drafts", "The judge", "Coached drafts", "Inbox agent", "Market cycle"])
    expect(s.top[3]).toEqual({ name: "Inbox agent", usd: 4, calls: 100 })
  })
  it("empty month: both keys at zero, bar capped", () => {
    const s = shapeHealthSpend([], [], "Nov")
    expect(s.monthUsd).toBe(0)
    expect(s.lanes.map((l) => l.key)).toEqual(["drafts", "background"])
    expect(s.top).toEqual([])
    expect(shapeHealthSpend([{ lane: "drafts", tag: null, cost_usd: 250 }], [], "Nov").monthPct).toBe(100)
  })
})

describe("feature names match the Telegram spend report", () => {
  const tags = ["[reply/auto]", "[reply/coach]", "[reply/critic]", "[coach/rate]", "[coach/script]", "[crms/generate]", "[draft-message]",
    "[judge]", "[lead-stage]", "[drip]", "[drip/compose]", "[analyze-call]", "[crms/call summary]", "[jackie-review]", "[triage-email]",
    "[campaign-inbox triage]", "[inbox-agent]", "[inbox-events]", "[backfill-names]", "[contact-intake]", "[campaign-compose]",
    "[reply-review]", "[market-cycle]", "[something-new]", null, ""]
  it.each(tags)("%s", (tag) => {
    const fromScript = (spendReport as unknown as { featureName: (t: string | null) => string }).featureName(tag)
    expect(featureName(tag)).toBe(fromScript)
  })
  it("lane labels", () => {
    expect(laneLabel("drafts")).toBe("Drafts & coaching")
    expect(laneLabel("background")).toBe("Background jobs")
  })
})

describe("agoWords", () => {
  it("sec / min / h / d", () => {
    expect(agoWords("2026-11-10T21:29:20Z", NOW)).toBe("40 sec ago")
    expect(agoWords("2026-11-10T21:18:00Z", NOW)).toBe("12 min ago")
    expect(agoWords("2026-11-10T16:30:00Z", NOW)).toBe("5 h ago")
    expect(agoWords("2026-11-07T21:30:00Z", NOW)).toBe("3 d ago")
  })
})

describe("buildHealthView", () => {
  it("all healthy → Everything is running.", () => {
    const v = buildHealthView(payload(), NOW)
    expect(v.problems).toBe(0)
    expect(v.verdict).toBe("Everything is running.")
    expect(v.checked).toEqual({ text: "Checked 2 min ago" })
    expect(v.cards.map((c) => c.title)).toEqual(["Mac mini", "Phone bridge", "Relationships helper", "Judge", "Jackie"])
    expect(v.cards.every((c) => c.mark === "ok")).toBe(true)
    const mini = v.cards[0].lines.map((l) => l.text)
    expect(mini).toEqual(["Checked in 40 sec ago", "Up since Oct 30, 2026", "63 GB free", "Last backup Nov 10, 2026, 3:10 AM"])
    expect(v.cards[1].lines.map((l) => l.text)).toEqual(["Connected", "3 of 32 chats open", "Claude login: 26 days left"])
    expect(v.cards[2].lines.map((l) => l.text)).toEqual(["Answering", "Text history refreshed 22 min ago"])
    expect(v.cards[3].lines[0].text).toBe("Ran today at 1:15 PM")
    expect(v.cards[4].lines.map((l) => l.text)).toEqual(["On since Oct 27, 2026", "4 calls in the last 7 days"])
    expect(v.jobs?.summary).toBe("2 jobs · all ok")
  })

  it("problems: helper down, text stale, a failed job, login 5 days, snapshot 40 min old", () => {
    const snap = snapshot({
      helper: { ok: false, pid: null, error: "no answer in 5 s" },
      textHistory: { refreshedAt: "2026-11-10T16:30:00Z", stale: true },
      jobs: [job("com.lrghomes.judge", "The judge"), job("com.lrghomes.mini-backup", "Nightly backup", false)],
      bridge: { running: true, connected: true, note: null, sessions: 3, capacity: 32, full: false, loginDaysLeft: 5 },
    })
    const p = payload({ status: { reportedAt: "2026-11-10T20:50:00Z", snapshot: snap } })
    const v = buildHealthView(p, NOW)
    // stale report + bridge (login) + helper + jobs
    expect(v.problems).toBe(4)
    expect(v.verdict).toBe("4 things need a look.")
    expect(v.checked).toEqual({ text: "The mini hasn't reported since Nov 10, 2026, 12:50 PM.", warn: true })
    expect(v.cards.find((c) => c.key === "bridge")?.lines.find((l) => l.warn)?.text).toBe("Claude login: 5 days left")
    expect(v.cards.find((c) => c.key === "helper")?.lines).toEqual([
      { text: "Not answering", warn: true },
      { text: "Text history refreshed 5 h ago", warn: true },
    ])
    expect(v.jobs?.summary).toBe("2 jobs · 1 needs a look")
    expect(v.jobs?.items[0].name).toBe("Nightly backup") // problems first
  })

  it("no mini report yet (table missing): one problem, the snapshot cards wait", () => {
    const v = buildHealthView(payload({ errors: { status: "relation \"mini_status\" does not exist" } }, null), NOW)
    expect(v.checked).toEqual({ text: "The mini hasn't reported yet.", warn: true })
    expect(v.problems).toBe(1)
    expect(v.cards.find((c) => c.key === "bridge")?.mark).toBe("unknown")
    expect(v.cards.find((c) => c.key === "helper")?.mark).toBe("unknown")
    expect(v.cards[0].mark).toBe("ok") // the check-in still works without the report
    expect(v.jobs).toBeNull()
  })

  it("a failed source marks only its card", () => {
    const v = buildHealthView(payload({ judge: null, errors: { judge: "boom" } }), NOW)
    expect(v.cards.find((c) => c.key === "judge")).toMatchObject({ mark: "warn", lines: [{ text: "Couldn't load this right now.", warn: true }] })
    expect(v.problems).toBe(1)
  })

  it("judge that last ran yesterday, quiet mini, failed backup, over budget", () => {
    const snap = snapshot({ backup: { lastAt: "2026-11-09T11:10:00Z", failedSince: true, errAt: "2026-11-10T20:08:00Z" } })
    const p = payload({
      status: { reportedAt: "2026-11-10T21:28:00Z", snapshot: snap },
      heartbeat: { beatAt: "2026-11-10T21:10:00Z", watchdogAt: "2026-11-10T21:05:00Z", freeGb: 8, lowSpace: true },
      judge: { at: "2026-11-10T07:30:00Z" },
      spend: shapeHealthSpend([{ lane: "drafts", tag: "[reply/auto]", cost_usd: 120 }], [], "Nov"),
    })
    const v = buildHealthView(p, NOW)
    const mini = v.cards[0]
    expect(mini.mark).toBe("warn")
    expect(mini.lines.filter((l) => l.warn).map((l) => l.text)).toEqual([
      "Hasn't checked in since Nov 10, 2026, 1:10 PM",
      "Only 8 GB free — getting full",
      "Last backup Nov 9, 2026, 3:10 AM — the backup after it failed",
    ])
    expect(v.cards.find((c) => c.key === "judge")?.lines[0]).toEqual({ text: "Last ran Nov 9, 2026, 11:30 PM", warn: true })
    expect(v.spend.mark).toBe("warn")
  })
})
