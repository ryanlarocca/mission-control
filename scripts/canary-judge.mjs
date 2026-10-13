// Canary judge — reads each day's canary placement straight from the judge
// inbox (CAMPAIGN_CANARY_TO, a consumer Gmail nobody opens) instead of
// waiting for Ryan to read it and reply "canary <label> <verdict>" on
// Telegram. Brief: briefs/BRIEF_CANARY_JUDGE_AUTOMATION_2026-10-12.md.
//
// Gmail's API exposes placement as labels on the message (SPAM,
// CATEGORY_PROMOTIONS, INBOX, …); reading via the API leaves the message
// unread and unopened, which is better for the test than a human opening it.
//
// Layout: the decision logic is pure and unit-tested
// (tests/canary-judge.unit.test.ts); the Gmail read lives at the bottom so
// the engine's judgePass() stays thin. The Telegram verdict path
// (lib/campaignSenders.ts recordCanaryVerdict) writes the same
// `canary_verdicts[day]` slot — Ryan's reply is the override and is never
// overwritten here.

import { google } from "googleapis"

export const JUDGE_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
/** Minutes between a canary leaving the sender mailbox and the first judge read (gives Gmail a beat to classify). */
export const JUDGE_MIN_AGE_MINUTES = 20

const PROMO_LABELS = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS"]

// ---------- pure logic ----------

/**
 * Gmail labelIds → canary verdict. Spam wins over everything; any non-Primary
 * tab counts as Promotions (the gate only cares about Primary vs not); INBOX
 * without a tab label is Primary; anything else (archived, trashed, unknown)
 * is null = "not found", never a verdict.
 */
export function verdictFromLabels(labelIds) {
  const ids = new Set((Array.isArray(labelIds) ? labelIds : []).map((l) => String(l).toUpperCase()))
  if (ids.has("SPAM")) return "spam"
  if (PROMO_LABELS.some((l) => ids.has(l))) return "promotions"
  if (ids.has("INBOX")) return "primary"
  return null
}

/** `[C8 buys] Quick question about …` → { n: 8, label: "buys" }, else null. */
export function parseCanarySubject(subject) {
  const m = /^\s*(?:(?:re|fwd?)\s*:\s*)*\[C(\d+)\s+([^\]\s]+)\]/i.exec(String(subject ?? ""))
  if (!m) return null
  return { n: Number(m[1]), label: m[2].toLowerCase() }
}

/** `Ryan LaRocca <ryan@lrghomesbuys.com>` / `ryan@lrghomesbuys.com` → lowercase address, else null. */
export function parseSenderAddress(fromHeader) {
  const s = String(fromHeader ?? "").trim()
  const m = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(s) ?? /^([^<>\s]+@[^<>\s]+)$/.exec(s)
  return m ? m[1].toLowerCase() : null
}

/** Gmail `internalDate` (epoch ms, often a string) → PT day `YYYY-MM-DD`, or null when unparseable. */
export function ptDayFromInternalDate(internalDate) {
  const ms = Number(internalDate)
  if (!Number.isFinite(ms) || ms <= 0) return null
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms))
}

/** The canary prefix the engine stamps on the subject: `[C<n> <label>]`. */
export function canarySubjectTag(code, label) {
  return `[${code} ${label}]`
}

/** Gmail search for one sender's canary of the day. */
export function judgeQueryFor(senderEmail, code, label) {
  return `from:${senderEmail} subject:"${canarySubjectTag(code, label)}" newer_than:3d`
}

export const BACKFILL_QUERY = 'subject:"[C" newer_than:30d'

/**
 * Pure: given what Gmail returned for one (sender, day) and the sender's
 * current state, decide what to record. Ryan's own verdict for that day is
 * the override: an existing verdict is never overwritten.
 *
 *   { action: "skip", reason: "already recorded", existing }
 *   { action: "skip", reason: "not found" }            (no message, or no verdict-bearing label)
 *   { action: "record", verdict }
 */
export function decideVerdict({ state, day, labelIds, found = true }) {
  const existing = state?.canary_verdicts?.[day] ?? null
  if (existing) return { action: "skip", reason: "already recorded", existing }
  if (!found) return { action: "skip", reason: "not found" }
  const verdict = verdictFromLabels(labelIds)
  if (!verdict) return { action: "skip", reason: "not found" }
  return { action: "record", verdict }
}

/** True once at least `minMinutes` have passed since `sentAtIso` (an unknown sent time is treated as old enough). */
export function canaryOldEnough(sentAtIso, now = Date.now(), minMinutes = JUDGE_MIN_AGE_MINUTES) {
  if (!sentAtIso) return true
  const t = new Date(sentAtIso).getTime()
  if (!Number.isFinite(t)) return true
  return now - t >= minMinutes * 60_000
}

/** `primary` → `Primary` for the Telegram line. */
export function verdictWord(verdict) {
  const v = String(verdict ?? "")
  return v ? v[0].toUpperCase() + v.slice(1) : v
}

/**
 * Backfill planner (pure). `messages` = [{ from, subject, internalDate,
 * labelIds }] from the judge inbox; `senders` = engine SENDERS; `states` =
 * Map(email → sender state). Returns one row per canary message, newest
 * message per (sender, day) winning, with the action for each:
 * record / skip (already recorded | not found | unknown sender | label mismatch).
 */
export function planBackfill({ messages, senders, states }) {
  const byEmail = new Map(senders.map((s) => [s.email, s]))
  const latest = new Map() // `${email}|${day}` → candidate
  const rows = []
  for (const msg of messages ?? []) {
    const tag = parseCanarySubject(msg.subject)
    const from = parseSenderAddress(msg.from)
    const day = ptDayFromInternalDate(msg.internalDate)
    if (!tag || !from || !day) continue
    const sender = byEmail.get(from)
    const base = { sender: from, label: tag.label, code: `C${tag.n}`, day, labels: msg.labelIds ?? [], internalDate: Number(msg.internalDate) }
    if (!sender) { rows.push({ ...base, action: "skip", reason: "unknown sender" }); continue }
    if (sender.label.toLowerCase() !== tag.label) { rows.push({ ...base, action: "skip", reason: `label mismatch (${sender.label})` }); continue }
    const key = `${from}|${day}`
    const prev = latest.get(key)
    if (!prev || base.internalDate > prev.internalDate) latest.set(key, base)
  }
  for (const cand of latest.values()) {
    const d = decideVerdict({ state: states?.get?.(cand.sender), day: cand.day, labelIds: cand.labels })
    rows.push({ ...cand, action: d.action, reason: d.reason ?? null, verdict: d.verdict ?? null, existing: d.existing ?? null })
  }
  return rows.sort((a, b) => (a.day === b.day ? a.sender.localeCompare(b.sender) : a.day < b.day ? -1 : 1))
}

/**
 * Stall watchdog (pure). A sender is "stalled on the judge" when the day's
 * ramp decision is hold, it has banked enough healthy days, and the canary
 * gate is the ONLY failing check — i.e. the sends are fine and only the
 * verdict bookkeeping is missing. Returns the reason text, or null.
 */
export function stallReason(evaluation, gates, senderLabel = null) {
  if (!evaluation || evaluation.decision !== "hold") return null
  const healthy = Number(evaluation.state?.healthy_days ?? 0)
  const min = Number(gates?.minHealthyDays ?? 3)
  if (healthy < min) return null
  const failing = (evaluation.checks ?? []).filter((c) => !c.pass)
  if (failing.length !== 1 || !/^canary/i.test(failing[0].name)) return null
  // The gate also fails on recorded non-Primary verdicts — that is a real
  // placement hold, not a bookkeeping stall. Stalled = verdicts missing or stale.
  const canary = evaluation.canary ?? {}
  const recorded = Array.isArray(canary.recent) ? canary.recent.length : 0
  const stale = canary.stale === true
  if (recorded >= min && !stale) return null
  const label = senderLabel ?? "sender"
  const why = recorded < min ? `only ${recorded}/${min} canary verdicts` : `its newest canary verdict is ${canary.ageDays} days old`
  return `ramp stalled: ${label} has ${healthy} healthy days but ${why} — the judge is not recording. Check CANARY_JUDGE_OAUTH_REFRESH_TOKEN or reply "canary ${label} primary|promotions|spam".`
}

/**
 * Upsert `KEY='value'` into .env.local contents: replace the existing line
 * (plain or `export`-prefixed), else append. Single-quoted per repo
 * convention (the engine's loader strips one pair of outer quotes and does
 * no unescaping, so a value holding a single quote is refused).
 */
export function upsertEnvLine(contents, key, value) {
  if (String(value).includes("'")) throw new Error(`${key}: value contains a single quote, which .env.local cannot hold`)
  const line = `${key}='${String(value)}'`
  const lines = String(contents ?? "").split(/\r?\n/)
  const idx = lines.findIndex((l) => l.trimStart().startsWith(`${key}=`) || l.trimStart().startsWith(`export ${key}=`))
  if (idx >= 0) { lines[idx] = line; return lines.join("\n") }
  const trimmed = lines.length && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines
  return [...trimmed, line, ""].join("\n")
}

// ---------- Gmail (judge inbox, OAuth refresh token) ----------

export function judgeConfigured(env = process.env) {
  return Boolean(env.CANARY_JUDGE_OAUTH_REFRESH_TOKEN)
}

/** Gmail client for the judge inbox. Throws when the three OAuth vars are missing; auth errors surface on the first call. */
export function judgeGmailClient(env = process.env) {
  const clientId = env.CANARY_JUDGE_OAUTH_CLIENT_ID
  const clientSecret = env.CANARY_JUDGE_OAUTH_CLIENT_SECRET
  const refreshToken = env.CANARY_JUDGE_OAUTH_REFRESH_TOKEN
  if (!clientId || !clientSecret) throw new Error("CANARY_JUDGE_OAUTH_CLIENT_ID / CANARY_JUDGE_OAUTH_CLIENT_SECRET not set")
  if (!refreshToken) throw new Error("CANARY_JUDGE_OAUTH_REFRESH_TOKEN not set — run scripts/canary-judge-consent.mjs --write-env")
  const auth = new google.auth.OAuth2(clientId, clientSecret)
  auth.setCredentials({ refresh_token: refreshToken })
  return google.gmail({ version: "v1", auth })
}

/** Newest message matching `q` in the judge inbox (SPAM included) with its labels, or null. */
export async function findNewestCanary(gmail, q) {
  const list = await gmail.users.messages.list({ userId: "me", q, includeSpamTrash: true, maxResults: 10 })
  const ids = list.data.messages ?? []
  if (!ids.length) return null
  let best = null
  for (const { id } of ids) {
    const msg = await gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject"] })
    const m = summarize(msg.data)
    if (!best || m.internalDate > best.internalDate) best = m
  }
  return best
}

/** Every canary-tagged message in the judge inbox from the last 30 days (SPAM included). */
export async function listCanaryMessages(gmail, q = BACKFILL_QUERY) {
  const out = []
  let pageToken
  do {
    const list = await gmail.users.messages.list({ userId: "me", q, includeSpamTrash: true, maxResults: 100, pageToken })
    for (const { id } of list.data.messages ?? []) {
      const msg = await gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject"] })
      out.push(summarize(msg.data))
    }
    pageToken = list.data.nextPageToken ?? undefined
  } while (pageToken)
  return out
}

function summarize(data) {
  const headers = data.payload?.headers ?? []
  const h = (name) => headers.find((x) => String(x.name).toLowerCase() === name)?.value ?? ""
  return { id: data.id, from: h("from"), subject: h("subject"), internalDate: Number(data.internalDate), labelIds: data.labelIds ?? [] }
}

/** True for the OAuth/API failures that mean "re-consent", not "retry". */
export function isJudgeAuthError(err) {
  const msg = String(err?.message ?? err ?? "")
  return /invalid_grant|invalid_client|unauthorized_client|insufficient.*scope|access.*denied|\b40[13]\b|invalid_rapt|token has been expired or revoked/i.test(msg)
}
