import { describe, it, expect } from "vitest"
// Plain ESM loaded directly (see tests/campaign-senders.unit.test.ts) — the
// engine's autopilot gates, pure and credential-free.
import * as gatesModule from "../scripts/campaign-gates.mjs"
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { resolveAutoSend, withTouchRegated, withTouchAuto, parseEnvTouches, AUTO_SEND_KEY } = gatesModule as unknown as Record<string, any>

const V5 = "v5-2026-10-02"
const V6 = "v6-2026-11-01"
const now = new Date("2026-10-15T18:00:00Z")

describe("Task 1 — auto-approve lives in the database", () => {
  it("parses the legacy env list", () => {
    expect(parseEnvTouches("1")).toEqual([1])
    expect(parseEnvTouches(" 2, 1 ,1,x")).toEqual([1, 2])
    expect(parseEnvTouches("")).toEqual([])
    expect(parseEnvTouches(undefined)).toEqual([])
    expect(AUTO_SEND_KEY).toBe("auto_send_touches")
  })

  it("absent row → env fallback, and the row gets written so the env var retires", () => {
    const r = resolveAutoSend({ row: null, envValue: "1", promptVersion: V5, now })
    expect([...r.touches]).toEqual([1])
    expect(r.source).toBe("env")
    expect(r.write).toMatchObject({ touches: [1], pinned_prompt_version: V5, changed_by: "engine", changed_at: now.toISOString() })
    expect(r.alert).toBeNull()
    expect(r.logLine).toMatch(/env fallback/)
    const none = resolveAutoSend({ row: null, envValue: "", promptVersion: V5, now })
    expect(none.touches.size).toBe(0)
    expect(none.write.touches).toEqual([])
  })

  it("db row pinned to the live prompt → auto, nothing written, log names the pin", () => {
    const row = { touches: [1], pinned_prompt_version: V5, engine_prompt_version: V5, changed_by: "seed", changed_at: "2026-10-15T00:00:00Z", reason: "seed" }
    const r = resolveAutoSend({ row, envValue: "", promptVersion: V5, now })
    expect([...r.touches]).toEqual([1])
    expect(r.source).toBe("db")
    expect(r.write).toBeNull()
    expect(r.alert).toBeNull()
    expect(r.logLine).toBe(`auto T1 (db, pinned ${V5})`)
    // the env var is ignored once the row exists
    const r2 = resolveAutoSend({ row: { ...row, touches: [] }, envValue: "1", promptVersion: V5, now })
    expect(r2.touches.size).toBe(0)
    expect(r2.logLine).toMatch(/^auto none \(db/)
  })

  it("records the engine's prompt version on the row (so Telegram 'on' can re-pin) without alerting", () => {
    const row = { touches: [1], pinned_prompt_version: V5, changed_by: "seed", changed_at: "x", reason: "seed" }
    const r = resolveAutoSend({ row, envValue: "", promptVersion: V5, now })
    expect(r.write).toMatchObject({ touches: [1], engine_prompt_version: V5 })
    expect(r.alert).toBeNull()
  })

  it("prompt change re-gates the touch, leaves the reason on the row, and tells Ryan", () => {
    const row = { touches: [1], pinned_prompt_version: V5, engine_prompt_version: V5, changed_by: "ryan", changed_at: "x", reason: "manual" }
    const r = resolveAutoSend({ row, envValue: "1", promptVersion: V6, now })
    expect(r.touches.size).toBe(0)
    expect(r.write).toMatchObject({ touches: [], regated_touches: [1], pinned_prompt_version: V5, engine_prompt_version: V6, changed_by: "engine", reason: `prompt changed ${V5} → ${V6}` })
    expect(r.alert).toBe(`T1 re-gated: prompt changed ${V5} → ${V6} — review today's drafts, then reply \`auto T1 on\``)
    // once re-gated (touches empty) a later pass is quiet
    const again = resolveAutoSend({ row: r.write, envValue: "1", promptVersion: V6, now })
    expect(again.touches.size).toBe(0)
    expect(again.alert).toBeNull()
    expect(again.write).toBeNull()
  })

  it("a tripwire re-gates one touch and keeps the others", () => {
    const row = { touches: [1, 2], pinned_prompt_version: V5 }
    const { row: next, changed } = withTouchRegated(row, 1, "5 removes (16.7%) today", now)
    expect(changed).toBe(true)
    expect(next).toMatchObject({ touches: [2], regated_touches: [1], reason: "5 removes (16.7%) today", changed_by: "engine" })
    expect(withTouchRegated(next, 1, "again", now).changed).toBe(false)
    expect(withTouchRegated(null, 1, "nothing", now)).toEqual({ row: null, changed: false })
  })

  it("'auto T1 on' re-pins to the current prompt; 'off' keeps the pin", () => {
    const regated = { touches: [], regated_touches: [1], pinned_prompt_version: V5, engine_prompt_version: V6, reason: "prompt changed" }
    const on = withTouchAuto(regated, 1, true, { promptVersion: V6, now })
    expect(on).toMatchObject({ touches: [1], pinned_prompt_version: V6, regated_touches: [], changed_by: "ryan", reason: "manual: auto T1 on (Telegram)" })
    const two = withTouchAuto(on, 2, true, { promptVersion: V6, now })
    expect(two.touches).toEqual([1, 2])
    const off = withTouchAuto(two, 1, false, { promptVersion: V6, now })
    expect(off).toMatchObject({ touches: [2], pinned_prompt_version: V6, reason: "manual: auto T1 off (Telegram)" })
    // no promptVersion given → fall back to what the engine last reported
    expect(withTouchAuto(regated, 1, true, { now }).pinned_prompt_version).toBe(V6)
    expect(withTouchAuto(null, 1, true, { promptVersion: V5, now })).toMatchObject({ touches: [1], pinned_prompt_version: V5 })
  })
})
