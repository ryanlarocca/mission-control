import { describe, it, expect } from "vitest"
import {
  EMPTY_ALERT_STATE, alertStep, backupOk, calendarWords, clock, intervalWords, isTextHistoryStale, jobName, judgeJob,
  parseBootTime, parseCtlStatus, parseDfFreeGb, parseLaunchctlList, scheduleWords,
  type MiniJob, type MiniSnapshot,
} from "@/lib/miniStatus"
import * as script from "../scripts/mini-status.mjs"

// Health page v1 (Mission Control 2.0, Part E, 2026-11-10): the pure parts of
// scripts/mini-status.mjs, the reporter that runs on the Mac mini every 5 min.

describe("script module", () => {
  it("imports without running (main is guarded)", () => {
    expect(typeof (script as unknown as Record<string, unknown>).collect).toBe("function")
  })
})

describe("plist schedule → words", () => {
  it("KeepAlive is always on, whatever else is set", () => {
    expect(scheduleWords({ KeepAlive: true, RunAtLoad: true })).toBe("always on")
    expect(scheduleWords({ KeepAlive: { SuccessfulExit: false } })).toBe("always on")
    expect(scheduleWords({ KeepAlive: false, RunAtLoad: true })).toBe("at startup")
  })
  it("StartInterval", () => {
    expect(scheduleWords({ StartInterval: 300 })).toBe("every 5 min")
    expect(scheduleWords({ StartInterval: 60, RunAtLoad: true })).toBe("every minute")
    expect(scheduleWords({ StartInterval: 3600 })).toBe("hourly")
    expect(scheduleWords({ StartInterval: 7200 })).toBe("every 2 hours")
    expect(scheduleWords({ StartInterval: 172800 })).toBe("every 2 days")
    expect(intervalWords(90)).toBe("every 90 sec")
  })
  it("StartCalendarInterval", () => {
    expect(scheduleWords({ StartCalendarInterval: { Hour: 3, Minute: 10 } })).toBe("daily 3:10 AM")
    expect(scheduleWords({ StartCalendarInterval: { Weekday: 1, Hour: 8, Minute: 40 } })).toBe("Mondays 8:40 AM")
    expect(scheduleWords({ StartCalendarInterval: { Weekday: 0, Hour: 4, Minute: 20 } })).toBe("Sundays 4:20 AM")
    expect(scheduleWords({ StartCalendarInterval: { Weekday: 7, Hour: 16 } })).toBe("Sundays 4:00 PM")
    expect(scheduleWords({ StartCalendarInterval: { Minute: 10 } })).toBe("hourly at :10")
    expect(scheduleWords({ StartCalendarInterval: { Hour: 9, Minute: 0 } })).toBe("daily 9:00 AM")
    expect(calendarWords({ Day: 1, Hour: 0, Minute: 5 })).toBe("monthly on the 1st, 12:05 AM")
    expect(scheduleWords({ StartCalendarInterval: [{ Hour: 8, Minute: 0 }, { Hour: 17, Minute: 30 }] })).toBe("daily 8:00 AM, daily 5:30 PM")
  })
  it("calendar beats interval; nothing set is on demand", () => {
    expect(scheduleWords({ StartCalendarInterval: { Hour: 6, Minute: 30 }, StartInterval: 300 })).toBe("daily 6:30 AM")
    expect(scheduleWords({ WatchPaths: ["/tmp/x"] })).toBe("when files change")
    expect(scheduleWords({})).toBe("on demand")
  })
  it("clock", () => {
    expect(clock(0, 0)).toBe("12:00 AM")
    expect(clock(12, 5)).toBe("12:05 PM")
    expect(clock(23, 59)).toBe("11:59 PM")
  })
})

describe("job names", () => {
  it("known labels get plain names; unknown ones dashes → spaces", () => {
    expect(jobName("com.lrghomes.crms-update-sidecar-url")).toBe("Helper address sync")
    expect(jobName("com.lrghomes.claude-remote-spawn")).toBe("Phone bridge keeper")
    expect(jobName("com.lrghomes.mini-heartbeat")).toBe("Mini check-in")
    expect(jobName("com.lrghomes.brand-new-thing")).toBe("Brand new thing")
  })
})

describe("launchctl list parsing", () => {
  const text = [
    "PID\tStatus\tLabel",
    "-\t0\tcom.lrghomes.judge",
    "93719\t-15\tcom.lrghomes.esign",
    "-\t1\tcom.lrghomes.mini-backup",
    "717\t0\tcom.lrghomes.esign-tunnel",
    "garbage line",
    "",
  ].join("\n")
  it("reads pid and last exit", () => {
    const m = parseLaunchctlList(text)
    expect(m["com.lrghomes.judge"]).toEqual({ pid: null, lastExit: 0 })
    expect(m["com.lrghomes.esign"]).toEqual({ pid: 93719, lastExit: -15 })
    expect(m["com.lrghomes.mini-backup"]).toEqual({ pid: null, lastExit: 1 })
    expect(Object.keys(m)).toHaveLength(4)
  })
})

describe("judgeJob", () => {
  it("an always-on job restarted by a signal is fine while it runs", () => {
    expect(judgeJob({ keepAlive: true, loaded: true, pid: 93719, lastExit: -15 })).toEqual({ ok: true, state: "running" })
    expect(judgeJob({ keepAlive: true, loaded: true, pid: null, lastExit: -9 })).toEqual({ ok: false, state: "stopped" })
  })
  it("scheduled jobs are judged on their last exit", () => {
    expect(judgeJob({ keepAlive: false, loaded: true, pid: null, lastExit: 0 })).toEqual({ ok: true, state: "last run ok" })
    expect(judgeJob({ keepAlive: false, loaded: true, pid: 4242, lastExit: 0 })).toEqual({ ok: true, state: "running now" })
    expect(judgeJob({ keepAlive: false, loaded: true, pid: null, lastExit: 1 })).toEqual({ ok: false, state: "last run failed" })
    expect(judgeJob({ keepAlive: false, loaded: true, pid: null, lastExit: -9 })).toEqual({ ok: false, state: "last run was cut off" })
    expect(judgeJob({ keepAlive: false, loaded: false, pid: null, lastExit: null })).toEqual({ ok: false, state: "not scheduled" })
  })
})

describe("phone bridge status parsing", () => {
  it("connected", () => {
    const b = parseCtlStatus([
      "🟢 Mac mini bridge: connected",
      "Sessions open: 3 of 32",
      "Mini up: 10 days, 21:03",
      "Claude login: 26 days left",
      "Longest idle: Verizon bill (1h)",
      "Commands: mini status · mini cleanup · mini restart",
    ].join("\n"))
    expect(b).toEqual({ running: true, connected: true, note: null, sessions: 3, capacity: 32, full: false, loginDaysLeft: 26 })
  })
  it("full, starting up, unknown, red, not running", () => {
    expect(parseCtlStatus("🟢 Mac mini bridge: connected\nSessions open: 32 of 32 — FULL, new chats can't start").full).toBe(true)
    expect(parseCtlStatus("🟡 Mac mini bridge: starting up (launched 40s ago) — give it a minute").note).toBe("starting up")
    const unk = parseCtlStatus("🟡 Mac mini bridge: can't read its screen — connection state unknown")
    expect(unk.connected).toBeNull()
    const red = parseCtlStatus("🔴 Mac mini bridge: Disconnected · Ryans-Mac-mini is offline\nClaude login: 5 days left")
    expect(red).toMatchObject({ connected: false, note: "Disconnected · Ryans-Mac-mini is offline", loginDaysLeft: 5 })
    const down = parseCtlStatus("🔴 Mac mini bridge is NOT running. launchd restarts it within 5 min")
    expect(down).toMatchObject({ running: false, connected: false })
  })
  it("throws on unexpected output", () => {
    expect(() => parseCtlStatus("Traceback (most recent call last):")).toThrow()
  })
})

describe("small parsers", () => {
  it("boot time, df, staleness", () => {
    expect(parseBootTime("{ sec = 1793406304, usec = 15559 } Fri Oct 30 17:25:04 2026")).toBe("2026-10-31T00:25:04.000Z")
    expect(parseBootTime("nope")).toBeNull()
    const df = "Filesystem   1024-blocks      Used Available Capacity iused     ifree %iused  Mounted on\n/dev/disk3s5   239362496 150832936  66116208    70% 1148428 661162080    0%   /System/Volumes/Data"
    expect(parseDfFreeGb(df)).toBe(63.1)
    const now = new Date("2026-11-10T21:00:00Z")
    expect(isTextHistoryStale("2026-11-10T19:00:00Z", now)).toBe(false)
    expect(isTextHistoryStale("2026-11-10T17:30:00Z", now)).toBe(true)
    expect(isTextHistoryStale(null, now)).toBe(true)
  })
  it("backup", () => {
    const now = new Date("2026-11-10T21:00:00Z")
    expect(backupOk({ lastAt: "2026-11-10T11:10:00Z", failedSince: false, errAt: null }, now)).toBe(true)
    expect(backupOk({ lastAt: "2026-11-09T11:10:00Z", failedSince: false, errAt: null }, now)).toBe(false)
    expect(backupOk({ lastAt: "2026-11-10T11:10:00Z", failedSince: true, errAt: "2026-11-10T12:00:00Z" }, now)).toBe(false)
    expect(backupOk(null, now)).toBe(false)
  })
})

// ── alerts ──────────────────────────────────────────────────────────────────

function job(label: string, ok: boolean, state = ok ? "last run ok" : "last run failed"): MiniJob {
  return { label, name: jobName(label), schedule: "hourly", keepAlive: false, loaded: true, running: false, pid: null, lastExit: ok ? 0 : 1, ok, state }
}
function snap(over: Partial<Pick<MiniSnapshot, "helper" | "textHistory" | "jobs">> = {}): Pick<MiniSnapshot, "helper" | "textHistory" | "jobs"> {
  return {
    helper: { ok: true, pid: 1, error: null },
    textHistory: { refreshedAt: "2026-11-10T20:00:00Z", stale: false },
    jobs: [job("com.lrghomes.judge", true)],
    ...over,
  }
}

describe("alertStep — state changes only", () => {
  it("all fine from no state: nothing to say", () => {
    const r = alertStep(null, snap())
    expect(r.lines).toEqual([])
    expect(r.restartHelper).toBe(false)
    expect(r.next).toEqual(EMPTY_ALERT_STATE)
  })

  it("helper: one miss is quiet, the second restarts once, recovery says so", () => {
    const down = snap({ helper: { ok: false, pid: null, error: "no answer in 5 s" } })
    const r1 = alertStep(null, down)
    expect(r1.lines).toEqual([])
    expect(r1.restartHelper).toBe(false)
    expect(r1.next.helperMisses).toBe(1)

    const r2 = alertStep(r1.next, down)
    expect(r2.restartHelper).toBe(true)
    expect(r2.lines.join("\n")).toMatch(/Relationships helper stopped answering/)
    expect(r2.next.helperDown).toBe(true)

    const r3 = alertStep(r2.next, down)
    expect(r3.restartHelper).toBe(false)
    expect(r3.lines).toEqual([])

    const r4 = alertStep(r3.next, snap())
    expect(r4.lines.join("\n")).toMatch(/answering again/)
    expect(r4.next.helperMisses).toBe(0)
    expect(r4.next.helperDown).toBe(false)
  })

  it("a single miss followed by an answer never alerts", () => {
    const r1 = alertStep(null, snap({ helper: { ok: false, pid: null, error: "x" } }))
    const r2 = alertStep(r1.next, snap())
    expect(r2.lines).toEqual([])
  })

  it("text history: stale once, then recovery", () => {
    const stale = snap({ textHistory: { refreshedAt: "2026-11-10T10:00:00Z", stale: true } })
    const r1 = alertStep(null, stale)
    expect(r1.lines.join()).toMatch(/Text history has stopped refreshing/)
    expect(alertStep(r1.next, stale).lines).toEqual([])
    expect(alertStep(r1.next, snap()).lines.join()).toMatch(/refreshing again/)
  })

  it("an unreadable text history doesn't flip the state", () => {
    const r = alertStep({ ...EMPTY_ALERT_STATE, textStale: true }, snap({ textHistory: null }))
    expect(r.lines).toEqual([])
    expect(r.next.textStale).toBe(true)
  })

  it("failing jobs: new ones alert once, cleared ones recover; the helper's own job is skipped", () => {
    const failing = snap({ jobs: [job("com.lrghomes.mini-backup", false), job("com.lrghomes.judge", true), job("com.lrghomes.crms-sidecar", false, "stopped")] })
    const r1 = alertStep(null, failing)
    expect(r1.lines).toHaveLength(1)
    expect(r1.lines[0]).toMatch(/Nightly backup: last run failed/)
    expect(r1.next.failingJobs).toEqual(["com.lrghomes.mini-backup"])
    expect(alertStep(r1.next, failing).lines).toEqual([])

    const two = snap({ jobs: [job("com.lrghomes.mini-backup", false), job("com.lrghomes.judge", false)] })
    const r2 = alertStep(r1.next, two)
    expect(r2.lines).toHaveLength(1)
    expect(r2.lines[0]).toMatch(/The judge/)
    expect(r2.lines[0]).not.toMatch(/Nightly backup/)

    const r3 = alertStep(r2.next, snap({ jobs: [job("com.lrghomes.mini-backup", true), job("com.lrghomes.judge", false)] }))
    expect(r3.lines).toEqual(["✅ Nightly backup is running fine again."])
    expect(r3.next.failingJobs).toEqual(["com.lrghomes.judge"])
  })
})
