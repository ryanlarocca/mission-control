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

// ---------- Task 2: removes stop holding the ramp; a floored copy tripwire replaces them ----------
//
// Ryan 2026-10-14: a "remove" reply is not a reputation signal ("hold more
// weight to a bounce than to somebody saying remove"), but an ABNORMAL remove
// day is a copy problem. Both floors must clear — the absolute count keeps a
// 1-of-3 day from tripping, the share keeps a 3-of-100 day from tripping.
export const REMOVE_TRIPWIRE = { yellowMin: 3, yellowRate: 0.1, redMin: 5, redRate: 0.15 }

/**
 * Per sender, per PT day. metrics: { sent, unsubs } (unsubs = removes today).
 *   yellow  removes ≥ 3 AND ≥ 10% of sent → hold the rung, "check the copy"
 *   red     removes ≥ 5 AND ≥ 15%          → day-stop the sender + re-gate the touch that produced them
 */
export function removeTripwire(metrics, gates = {}) {
  const sent = Number(metrics?.sent ?? 0)
  const removes = Number(metrics?.unsubs ?? metrics?.removes ?? 0)
  const g = { ...REMOVE_TRIPWIRE, ...(gates.removeTripwire ?? {}) }
  const pct = sent ? `${((100 * removes) / sent).toFixed(1)}%` : "—"
  if (removes >= g.redMin && removes >= g.redRate * sent) return { level: "red", removes, sent, text: `${removes} removes (${pct} of ${sent} sent) ≥ ${g.redMin} and ≥ ${g.redRate * 100}%` }
  if (removes >= g.yellowMin && removes >= g.yellowRate * sent) return { level: "yellow", removes, sent, text: `${removes} removes (${pct} of ${sent} sent) ≥ ${g.yellowMin} and ≥ ${g.yellowRate * 100}%` }
  return { level: "none", removes, sent, text: null }
}

/** Group today's removes by the copy that produced them: "T1 v5-2026-10-02/D ×3: subject a; subject b". */
export function describeRemovedSends(details = []) {
  const groups = new Map()
  for (const d of details ?? []) {
    if (!d) continue
    const key = `T${d.touch_number ?? "?"} ${d.prompt_version ?? "template"}${d.variant ? `/${d.variant}` : ""}`
    const g = groups.get(key) ?? { n: 0, subjects: new Set() }
    g.n++
    if (d.subject) g.subjects.add(String(d.subject).trim())
    groups.set(key, g)
  }
  return [...groups.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, g]) => `${k} ×${g.n}${g.subjects.size ? `: ${[...g.subjects].slice(0, 5).map((s) => `"${s}"`).join(", ")}` : ""}`).join(" · ")
}

/** The touch numbers behind today's removes (for the Task 2 red → re-gate step). */
export function touchesOfRemoves(details = []) {
  return [...new Set((details ?? []).map((d) => Number(d?.touch_number)).filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b)
}

// ---------- Task 3: intraday bounce circuit breaker ----------
//
// Per sender, per PT day, evaluated every engine cycle (not just at 5:15 PM):
//   1st bounce                                              → nothing (the contact is already stamped)
//   2nd bounce (below 10 sent) / rate ≥ 2% (at ≥ 10 sent)   → DAY-STOP: nothing more today, resumes next weekday
//   rate ≥ 5% at ≥ 10 sent, or 3 bounces in the first hour  → RED: the existing 48 h pauseSender + drop a rung
// Percentage conditions only apply at ≥ 10 sent, so a 1-of-3 day never
// trips; below 10 only the absolute counts apply. One bounce is never a trip.
export const BOUNCE_BREAKER = { dayStopRate: 0.02, redRate: 0.05, firstHourBounces: 3, minSentForRate: 10 }

/** metrics: { sent, bounces, bouncesFirstHour? }. Returns { level: "none"|"day_stop"|"red", text }. */
export function bounceBreaker(metrics, gates = {}) {
  const sent = Number(metrics?.sent ?? 0)
  const bounces = Number(metrics?.bounces ?? 0)
  const firstHour = Number(metrics?.bouncesFirstHour ?? 0)
  // config/campaign-senders.json still names the 2% line `bounceRedRate`; since the
  // autopilot brief that line is the day-stop, and red moved to bounceBreakerRate.
  const g = { ...BOUNCE_BREAKER, dayStopRate: gates.bounceRedRate ?? BOUNCE_BREAKER.dayStopRate, redRate: gates.bounceBreakerRate ?? BOUNCE_BREAKER.redRate, ...(gates.bounceBreaker ?? {}) }
  const pct = sent ? `${((100 * bounces) / sent).toFixed(1)}%` : "—"
  if (firstHour >= g.firstHourBounces) return { level: "red", bounces, sent, text: `${firstHour} bounces inside the first hour of sending (${bounces}/${sent} today)` }
  if (bounces < 2) return { level: "none", bounces, sent, text: null }
  const rate = sent ? bounces / sent : 0
  if (sent >= g.minSentForRate && rate >= g.redRate) return { level: "red", bounces, sent, text: `bounce rate ${pct} (${bounces}/${sent}) ≥ ${g.redRate * 100}%` }
  const stop = sent >= g.minSentForRate ? rate >= g.dayStopRate : true
  if (stop) return { level: "day_stop", bounces, sent, text: sent >= g.minSentForRate ? `bounce rate ${pct} (${bounces}/${sent}) ≥ ${g.dayStopRate * 100}%` : `${bounces} bounces on ${sent} sent (2nd bounce below ${g.minSentForRate})` }
  return { level: "none", bounces, sent, text: null }
}

/** Day-stop is a per-sender state: { day, reason, at }. It expires by the calendar — the next weekday sends again. */
export function isDayStopped(state, day) {
  return Boolean(state?.day_stop?.day) && state.day_stop.day === day
}

export function withDayStop(state, { day, reason, now = new Date() }) {
  return { ...(state ?? {}), day_stop: { day, reason: reason ?? null, at: now.toISOString() } }
}

// ---------- Task 6: touch one takes the budget first (event-based touches) ----------
//
// Ryan 2026-10-14: "finish touch one for the whole list before anyone gets
// touch two. Just to be simple." Stable partition AFTER the existing
// priority sort, so repliers / Relationships matches still lead within each
// half. The day the T1 queue is empty, T2 starts by itself, oldest due first.

/** Every touch_number === 0 contact precedes every touch_number >= 1 contact; order within each half is preserved. */
export function partitionTouchOne(list) {
  const first = []
  const rest = []
  for (const c of list ?? []) (Number(c?.touch_number ?? 0) === 0 ? first : rest).push(c)
  return [...first, ...rest]
}

/** "T1 remaining" + "days of T1 supply at current caps" (weekdays; null when no cap). */
export function t1Supply({ remaining, capTotal }) {
  const r = Math.max(0, Number(remaining) || 0)
  const cap = Math.max(0, Number(capTotal) || 0)
  return { remaining: r, capTotal: cap, days: cap > 0 ? Math.ceil(r / cap) : null }
}

export function describeT1Supply(s) {
  if (!s) return "T1 remaining: ?"
  return `T1 remaining: ${s.remaining}${s.days === null ? " (no cap — supply unknown)" : ` · ~${s.days} weekday${s.days === 1 ? "" : "s"} of supply at ${s.capTotal}/day`}`
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
