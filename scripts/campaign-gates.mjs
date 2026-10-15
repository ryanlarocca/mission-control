// Campaign autopilot gates (2026-10-15, briefs/BRIEF_CAMPAIGN_AUTOPILOT_GATES_2026-10-14.md).
//
// Pure decision logic for the engine's guardrails — no Supabase, no network,
// no clock unless one is passed in — so every rule here is unit-tested in
// tests/campaign-gates.unit.test.ts without credentials. The engine
// (scripts/campaign-engine.mjs) owns the I/O and the Telegram wording.
//
//   Task 1  resolveAutoSend / withTouchRegated / withTouchAuto   — auto-approve lives in the DB, pinned to PROMPT_VERSION
//   Task 2  removeTripwire                                       — floored copy tripwire (removes never hold the ramp on their own)
//   Task 3  bounceBreaker / withDayStop / isDayStopped           — intraday bounce circuit breaker + per-day sender stop
//   Task 6  partitionTouchOne / t1Supply                         — touch one takes the budget first
//   Task 7  canary2ReminderDue                                   — "time to prep canary two" cadence
//   Task 8  isStaleSlot / respreadSlot                           — late approvals get a fresh send minute

export const AUTO_SEND_KEY = "auto_send_touches"

const toTouchList = (v) =>
  [...new Set((Array.isArray(v) ? v : String(v ?? "").split(",")).map((x) => Number.parseInt(String(x).trim(), 10)).filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b)

/** Parse the legacy env value ("1" / "1,2") into a touch list. */
export function parseEnvTouches(envValue) {
  return toTouchList(envValue)
}

/**
 * Which touches draft straight to `approved` this pass.
 *
 *   row            the campaign_settings `auto_send_touches` value, or null when absent
 *   envValue       CAMPAIGN_AUTO_SEND_TOUCHES (only consulted when the row is absent)
 *   promptVersion  the engine's PROMPT_VERSION constant
 *
 * Returns { touches (Set), source: "db"|"env", pinned, write, alert, logLine }:
 *   write  the row to persist (null = nothing changed)
 *   alert  Telegram text when a touch was re-gated by a prompt change (null otherwise)
 *
 * The prompt-version pin: a touch is auto ONLY while PROMPT_VERSION equals
 * the pinned version. A changed constant re-gates every auto touch, records
 * why on the row, and waits for Ryan's "auto T1 on" (which re-pins).
 */
export function resolveAutoSend({ row, envValue, promptVersion, now = new Date() } = {}) {
  const at = now.toISOString()
  if (!row || typeof row !== "object") {
    const touches = parseEnvTouches(envValue)
    const write = { touches, pinned_prompt_version: promptVersion, engine_prompt_version: promptVersion, changed_by: "engine", changed_at: at, reason: "seeded from CAMPAIGN_AUTO_SEND_TOUCHES env (row was absent)" }
    return { touches: new Set(touches), source: "env", pinned: promptVersion, write, alert: null, logLine: `auto ${touches.length ? touches.map((t) => `T${t}`).join("/") : "none"} (env fallback → writing ${AUTO_SEND_KEY} row, pinned ${promptVersion})` }
  }
  const touches = toTouchList(row.touches)
  const pinned = row.pinned_prompt_version ?? null
  if (touches.length && pinned !== promptVersion) {
    const label = touches.map((t) => `T${t}`).join("/")
    const reason = `prompt changed ${pinned ?? "(unpinned)"} → ${promptVersion}`
    const write = { ...row, touches: [], regated_touches: touches, engine_prompt_version: promptVersion, changed_by: "engine", changed_at: at, reason }
    const alert = `${label} re-gated: ${reason} — review today's drafts, then reply \`auto ${touches.map((t) => `T${t}`).join(" on` / `auto ")} on\``
    return { touches: new Set(), source: "db", pinned, write, alert, logLine: `auto none — ${label} RE-GATED (${reason})` }
  }
  const write = row.engine_prompt_version === promptVersion ? null : { ...row, engine_prompt_version: promptVersion }
  const logLine = touches.length ? `auto ${touches.map((t) => `T${t}`).join("/")} (db, pinned ${pinned})` : `auto none (db${row.reason ? `: ${row.reason}` : ""})`
  return { touches: new Set(touches), source: "db", pinned, write, alert: null, logLine }
}

/** A tripwire re-gates one touch: it leaves the row, `reason` says why. */
export function withTouchRegated(row, touch, reason, now = new Date()) {
  const cur = toTouchList(row?.touches)
  if (!cur.includes(touch)) return { row: row ?? null, changed: false }
  return { row: { ...(row ?? {}), touches: cur.filter((t) => t !== touch), regated_touches: [...new Set([...(row?.regated_touches ?? []), touch])], changed_by: "engine", changed_at: now.toISOString(), reason }, changed: true }
}

/** "auto T1 on|off" from Telegram. `on` re-pins to the prompt version given. */
export function withTouchAuto(row, touch, on, { promptVersion, by = "ryan", now = new Date() } = {}) {
  const cur = toTouchList(row?.touches)
  const next = on ? toTouchList([...cur, touch]) : cur.filter((t) => t !== touch)
  const pin = on ? promptVersion ?? row?.engine_prompt_version ?? row?.pinned_prompt_version ?? null : row?.pinned_prompt_version ?? null
  return {
    ...(row ?? {}),
    touches: next,
    pinned_prompt_version: pin,
    regated_touches: (row?.regated_touches ?? []).filter((t) => t !== touch),
    changed_by: by,
    changed_at: now.toISOString(),
    reason: `manual: auto T${touch} ${on ? "on" : "off"} (Telegram)`,
  }
}
