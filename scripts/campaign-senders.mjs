// Multi-sender config + per-sender gated warm-up ramp for the agent drip.
// Locked spec: briefs/BRIEF_SECONDARY_SENDING_DOMAIN_2026-08-25.md ("Standing
// architecture" + "Warm-up plan"). Built 2026-09-04 (September rebuild, item 2).
//
//   node scripts/campaign-senders.mjs            # print senders, caps, ramp state (read-only)
//   node scripts/campaign-senders.mjs --json
//
// Config lives in config/campaign-senders.json. Ramp state lives in
// campaign_settings under `sender:<email>` — one row per sender, so each
// domain climbs (or drops) on its own evidence. The engine never advances a
// sender on the calendar: every step needs `gates.minHealthyDays` green send
// days at the current step, and the next cap may never exceed twice the cap
// that was in force seven days earlier (Google: "immediately doubling
// previously sent volumes could result in rate limiting or reputation drops").

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(__dirname, "..")
export const SENDERS_CONFIG_PATH = path.join(REPO_ROOT, "config", "campaign-senders.json")

export const DEFAULT_GATES = {
  minHealthyDays: 3, // green send days at a step before it can advance ("canary Primary 3 days running")
  healthyDayMinFraction: 0.6, // a green day counts toward the streak only if ≥ this share of the cap went out
  maxWeekOverWeek: 2, // next cap ≤ this × the cap in force 7 days ago
  bounceHoldRate: 0.01, // yellow (hold) line
  bounceRedRate: 0.02, // red (drop a step) line, once ≥10 sent in the day
  replyCheckMinSends: 40, // once a sender has this many sends in 7 days, zero genuine replies = hold
  requireCanaryVerdict: false, // flip when the canary-verdict input exists (rebuild item 3)
  requirePostmaster: false, // flip when Postmaster reputation is ingested (rebuild item 3)
}

/** Parse config/campaign-senders.json (+ CAMPAIGN_SENDERS narrowing). Pure — no DB. */
export function loadSenderConfig({ env = process.env, configPath = SENDERS_CONFIG_PATH } = {}) {
  let raw = { senders: {}, gates: {} }
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"))
  } catch (e) {
    if (e?.code !== "ENOENT") throw new Error(`campaign-senders.json: ${e.message}`)
  }
  const gates = { ...DEFAULT_GATES, ...(raw.gates ?? {}) }
  const narrow = (env.CAMPAIGN_SENDERS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const senders = []
  for (const [emailRaw, cfg] of Object.entries(raw.senders ?? {})) {
    const email = emailRaw.trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) throw new Error(`campaign-senders.json: bad sender address "${emailRaw}"`)
    const ramp = (Array.isArray(cfg.ramp) ? cfg.ramp : []).map(Number).filter((n) => Number.isFinite(n) && n > 0)
    if (!ramp.length) throw new Error(`campaign-senders.json: ${email} needs a non-empty ramp ladder`)
    for (let i = 1; i < ramp.length; i++) if (ramp[i] < ramp[i - 1]) throw new Error(`campaign-senders.json: ${email} ramp must be non-decreasing`)
    const enabledInFile = cfg.enabled !== false
    const enabled = narrow.length ? narrow.includes(email) : enabledInFile
    senders.push({
      email,
      enabled,
      role: cfg.role === "understudy" ? "understudy" : "workhorse",
      label: cfg.label || email.split("@")[1].replace(/\.[a-z]+$/, ""),
      ramp,
      ceiling: Number.isFinite(Number(cfg.ceiling)) && Number(cfg.ceiling) > 0 ? Number(cfg.ceiling) : ramp[ramp.length - 1],
      segment: cfg.segment === "relationships" ? "relationships" : "drip",
      segmentTiers: Array.isArray(cfg.segmentTiers) ? cfg.segmentTiers.map(String) : ["A", "B", "C"],
      replyTo: cfg.replyTo === null ? null : String(cfg.replyTo || "").trim().toLowerCase() || null,
    })
  }
  for (const n of narrow) if (!senders.some((s) => s.email === n)) throw new Error(`CAMPAIGN_SENDERS names ${n}, which is not in config/campaign-senders.json`)
  let enabled = senders.filter((s) => s.enabled)
  // Legacy fallback: an env-only single sender keeps old deployments working
  // until the config file is populated. It ramps on the workhorse ladder.
  if (!enabled.length && env.CAMPAIGN_SEND_AS) {
    const email = env.CAMPAIGN_SEND_AS.trim().toLowerCase()
    enabled = [{ email, enabled: true, role: "workhorse", label: email.split("@")[0], ramp: [5, 10, 20, 35, 50, 75, 100], ceiling: 100, segment: "drip", segmentTiers: [], replyTo: null, legacy: true }]
  }
  const workhorse = enabled.find((s) => s.role === "workhorse") ?? enabled[0] ?? null
  return { gates, all: senders, senders: enabled, workhorse }
}

export const stateKey = (email) => `sender:${email.toLowerCase()}`

export function freshState() {
  return { step: 0, entered_step: null, healthy_days: 0, held_reason: null, last_change: null, paused: false, paused_reason: null, history: [] }
}

/** Ramp state per enabled sender (campaign_settings `sender:<email>`; fresh if absent). */
export async function loadSenderStates(sb, senders) {
  const keys = senders.map((s) => stateKey(s.email))
  const states = new Map(senders.map((s) => [s.email, freshState()]))
  if (!keys.length) return states
  const { data, error } = await sb.from("campaign_settings").select("key, value").in("key", keys)
  if (error) throw new Error(`sender states: ${error.message}`)
  for (const row of data ?? []) {
    const email = row.key.slice("sender:".length)
    states.set(email, { ...freshState(), ...(row.value ?? {}) })
  }
  return states
}

export async function saveSenderState(sb, email, state) {
  const value = { ...state, updated_at: new Date().toISOString() }
  const { error } = await sb.from("campaign_settings").upsert({ key: stateKey(email), value, updated_at: value.updated_at })
  if (error) throw new Error(`save sender state ${email}: ${error.message}`)
  return value
}

/** Live daily cap = the ramp step's number, never above the sender's ceiling. */
export function capFor(sender, state) {
  const step = Math.max(0, Math.min(Number(state?.step ?? 0), sender.ramp.length - 1))
  return Math.min(sender.ramp[step], sender.ceiling)
}

function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** The cap this sender was running `daysAgo` days before `day`, from its history (ramp[0] before any history). */
export function capAsOf(sender, state, day, daysAgo = 7) {
  const target = addDays(day, -daysAgo)
  const hist = (state?.history ?? []).filter((h) => h.day <= target).sort((a, b) => (a.day < b.day ? 1 : -1))
  if (hist.length) return Number(hist[0].cap) || sender.ramp[0]
  return sender.ramp[0]
}

/**
 * The daily ramp decision for one sender. Pure: give it the day's metrics and
 * the trailing 7-day aggregate; it returns the status, the checks that ran, the
 * decision, and the state to persist. Called once per weekday by the engine's
 * health pass; the engine also owns the Telegram wording.
 *
 * metrics:  { sent, failed, bounces, replies, unsubs, autoReplies }
 * trailing: { sent, bounces, replies }  (the previous 7 days, this sender)
 * extra:    { paused, canaryVerdicts?: {day: verdict}, postmaster?: {reputation} }
 */
export function evaluateSenderDay({ sender, state, day, metrics, trailing, gates = DEFAULT_GATES, extra = {} }) {
  const st = { ...freshState(), ...(state ?? {}) }
  const cap = capFor(sender, st)
  const m = { sent: 0, failed: 0, bounces: 0, replies: 0, unsubs: 0, autoReplies: 0, ...(metrics ?? {}) }
  const tr = { sent: 0, bounces: 0, replies: 0, ...(trailing ?? {}) }
  const checks = []
  const warnings = []
  const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "—")

  // --- day quality ---
  const bounceRate = m.sent ? m.bounces / m.sent : 0
  const red = m.sent >= 10 ? bounceRate >= gates.bounceRedRate : m.bounces >= 2
  if (red) warnings.push({ level: "red", text: `bounce rate ${pct(m.bounces, m.sent)} (${m.bounces}/${m.sent}) ≥ ${gates.bounceRedRate * 100}%` })
  else if (m.bounces && bounceRate >= gates.bounceHoldRate) warnings.push({ level: "yellow", text: `bounce rate ${pct(m.bounces, m.sent)} — watch line ${gates.bounceHoldRate * 100}%` })
  if (m.failed) warnings.push({ level: "yellow", text: `${m.failed} send failure${m.failed === 1 ? "" : "s"}` })
  if (m.unsubs >= 2) warnings.push({ level: "yellow", text: `${m.unsubs} removes in one day` })
  if (extra.paused) warnings.push({ level: "yellow", text: `paused: ${extra.paused}` }) // a pause holds the rung; only bounces drop it
  if (tr.sent >= gates.replyCheckMinSends && tr.replies === 0) warnings.push({ level: "yellow", text: `no genuine replies on the last ${tr.sent} sends (7 days)` })
  const status = warnings.some((w) => w.level === "red") ? "🔴" : warnings.length ? "🟡" : "🟢"

  // --- advancement gates (all must pass) ---
  const gap = m.sent === 0
  let healthy = st.healthy_days
  if (gap) healthy = 0 // consistency: a skipped weekday resets the streak (M3AAWG/Braze: lapses reset progress)
  else if (status === "🟢" && m.sent >= Math.ceil(cap * gates.healthyDayMinFraction)) healthy += 1
  else if (status === "🔴") healthy = 0

  const nextStep = Math.min(st.step + 1, sender.ramp.length - 1)
  const nextCap = Math.min(sender.ramp[nextStep], sender.ceiling)
  const atCeiling = cap >= sender.ceiling || nextStep === st.step || nextCap <= cap
  const weekAgoCap = capAsOf(sender, st, day, 7)
  checks.push({ name: "healthy days at step", pass: healthy >= gates.minHealthyDays, note: `${healthy}/${gates.minHealthyDays}` })
  checks.push({ name: "bounces < 2%", pass: !red, note: `${pct(m.bounces, m.sent)} today` })
  checks.push({ name: "no failures / pause", pass: !m.failed && !extra.paused, note: m.failed ? `${m.failed} failed` : extra.paused ? "paused" : "ok" })
  checks.push({ name: "replies still arriving", pass: !(tr.sent >= gates.replyCheckMinSends && tr.replies === 0), note: `${tr.replies} on ${tr.sent} (7d)` })
  checks.push({ name: "≤ 2× week-over-week", pass: nextCap <= weekAgoCap * gates.maxWeekOverWeek, note: `next ${nextCap} vs ${weekAgoCap} a week ago` })
  // Inputs that do not exist yet (rebuild item 3) are advisory until flipped in config.
  const verdicts = extra.canaryVerdicts ?? {}
  const lastVerdicts = Object.keys(verdicts).sort().slice(-gates.minHealthyDays).map((d) => verdicts[d])
  const canaryPass = lastVerdicts.length >= gates.minHealthyDays && lastVerdicts.every((v) => v === "primary")
  checks.push({ name: "canary Primary 3 days", pass: gates.requireCanaryVerdict ? canaryPass : true, note: lastVerdicts.length ? lastVerdicts.join(",") : "no verdicts recorded", advisory: !gates.requireCanaryVerdict })
  const rep = extra.postmaster?.reputation ?? null
  checks.push({ name: "Postmaster reputation", pass: gates.requirePostmaster ? rep === "HIGH" || rep === "MEDIUM" : true, note: rep ?? "not ingested", advisory: !gates.requirePostmaster })

  let decision = "hold"
  let next = { ...st, healthy_days: healthy }
  if (gap) {
    decision = "gap"
    next.held_reason = st.entered_step ? "no sends today — streak reset" : st.held_reason
  } else if (status === "🔴") {
    if (st.step > 0) {
      decision = "drop"
      next = { ...next, step: st.step - 1, entered_step: day, healthy_days: 0, held_reason: warnings.find((w) => w.level === "red")?.text ?? null, last_change: day }
    } else {
      decision = "hold"
      next.held_reason = warnings.find((w) => w.level === "red")?.text ?? null
    }
  } else if (atCeiling) {
    decision = "steady"
    next.held_reason = null
  } else if (checks.every((c) => c.pass)) {
    decision = "advance"
    next = { ...next, step: nextStep, entered_step: day, healthy_days: 0, held_reason: null, last_change: day }
  } else {
    decision = "hold"
    next.held_reason = status === "🟡" ? warnings[0].text : checks.filter((c) => !c.pass).map((c) => `${c.name} (${c.note})`).join("; ")
  }
  if (!next.entered_step && !gap) next.entered_step = day
  const entry = { day, step: st.step, cap, sent: m.sent, bounces: m.bounces, replies: m.replies, status, decision }
  next.history = [...(st.history ?? []).filter((h) => h.day !== day), entry].sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-40)
  return { status, warnings: warnings.map((w) => w.text), checks, decision, cap, nextCap: capFor(sender, next), state: next }
}

// ---------- segment + ordering helpers (engagement-first ramp) ----------

/** Emails of Relationships-table rows in the given tiers (lowercase set). */
export async function fetchRelationshipEmails(sb, tiers = ["A", "B", "C"]) {
  const out = new Set()
  for (let from = 0; ; from += 1000) {
    let q = sb.from("relationships").select("email, tier").not("email", "is", null).range(from, from + 999)
    if (tiers?.length) q = q.in("tier", tiers)
    const { data, error } = await q
    if (error) throw new Error(`relationships fetch: ${error.message}`)
    for (const r of data ?? []) if (r.email) out.add(String(r.email).trim().toLowerCase())
    if (!data || data.length < 1000) break
  }
  return out
}

/** Contact ids with at least one genuine (triage-null) email reply — the July repliers lead the ramp. */
export async function fetchReplierIds(sb) {
  const out = new Set()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("campaign_events").select("contact_id").eq("kind", "email_reply").is("triage", null).range(from, from + 999)
    if (error) throw new Error(`repliers fetch: ${error.message}`)
    for (const r of data ?? []) if (r.contact_id) out.add(r.contact_id)
    if (!data || data.length < 1000) break
  }
  return out
}

/** contact_id → sender of that contact's most recent sent row (null = pre-multi-sender). */
export async function fetchLastSenderByContact(sb, contactIds) {
  const map = new Map()
  const ids = [...new Set(contactIds)].filter(Boolean)
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    const { data, error } = await sb
      .from("campaign_sends")
      .select("contact_id, sender, sent_at")
      .in("contact_id", chunk)
      .eq("status", "sent")
      .order("sent_at", { ascending: false })
    if (error) throw new Error(`last sender fetch: ${error.message}`)
    for (const r of data ?? []) if (!map.has(r.contact_id)) map.set(r.contact_id, r.sender ? String(r.sender).toLowerCase() : null)
  }
  return map
}

/**
 * Which sender carries this contact. Sticky first (the mailbox that already
 * holds the thread), then the understudy's segment claim, then the workhorse.
 */
export function assignSender({ contact, senders, relEmails, lastSender }) {
  const email = String(contact.email ?? "").trim().toLowerCase()
  const prior = lastSender?.get?.(contact.id) ?? null
  if (prior) {
    const s = senders.find((x) => x.email === prior)
    if (s) return s
  }
  const understudy = senders.find((s) => s.segment === "relationships")
  if (understudy && relEmails?.has(email)) return understudy
  return senders.find((s) => s.segment === "drip") ?? senders[0] ?? null
}

/** 0 = replied before, 1 = Relationships match, 2 = everyone else. Lower sends first. */
export function priorityOf(contact, { replierIds, relEmails }) {
  if (replierIds?.has(contact.id)) return 0
  if (relEmails?.has(String(contact.email ?? "").trim().toLowerCase())) return 1
  return 2
}

// ---------- CLI (read-only) ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const line of fs.readFileSync(path.join(REPO_ROOT, ".env.local"), "utf-8").split(/\r?\n/)) {
    const eq = line.indexOf("=")
    if (eq < 0 || line.trim().startsWith("#")) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    if (process.env[key] === undefined) process.env[key] = val
  }
  const { createClient } = await import("@supabase/supabase-js")
  const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  const cfg = loadSenderConfig()
  const states = await loadSenderStates(sb, cfg.senders)
  const rows = cfg.senders.map((s) => {
    const st = states.get(s.email)
    return { email: s.email, role: s.role, segment: s.segment, replyTo: s.replyTo, step: st.step, cap: capFor(s, st), ceiling: s.ceiling, ramp: s.ramp.join("→"), healthy_days: st.healthy_days, entered_step: st.entered_step, held: st.held_reason, paused: st.paused ? st.paused_reason || true : false, legacy: !!s.legacy }
  })
  if (process.argv.includes("--json")) console.log(JSON.stringify({ gates: cfg.gates, senders: rows }, null, 2))
  else {
    console.log(`senders (${rows.length} enabled of ${cfg.all.length} configured; gates: ${cfg.gates.minHealthyDays} healthy days/step, ≤${cfg.gates.maxWeekOverWeek}× week-over-week)`)
    for (const r of rows) {
      console.log(`  ${r.email}  [${r.role}${r.legacy ? ", legacy env fallback" : ""}]  segment=${r.segment}  reply-to=${r.replyTo ?? "none"}`)
      console.log(`    step ${r.step} → cap ${r.cap}/day (ladder ${r.ramp}, ceiling ${r.ceiling}) · healthy days ${r.healthy_days} · since ${r.entered_step ?? "—"}${r.held ? ` · held: ${r.held}` : ""}${r.paused ? ` · PAUSED ${r.paused}` : ""}`)
    }
    if (!rows.length) console.log("  (none — populate config/campaign-senders.json or set CAMPAIGN_SEND_AS)")
  }
}
