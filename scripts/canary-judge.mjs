// Canary judge — reads each day's canary placement straight from the judge
// inbox (CAMPAIGN_CANARY_TO, a consumer Gmail nobody opens) instead of
// waiting for Ryan to read it and reply "canary <label> <verdict>" on
// Telegram. Brief: briefs/BRIEF_CANARY_JUDGE_AUTOMATION_2026-10-12.md
// (Task 2 + the 2026-10-12 evening addendum, Task 4).
//
// The read is IMAP with a Gmail App Password (imapflow) — the OAuth app
// could not be published, and a Testing-status token expires every 7 days,
// which would re-create exactly the stall this build exists to remove.
// Placement comes from three signals, all read-only (envelope + Gmail labels
// + internalDate — never a body, never \Seen):
//   spam        the message is in `[Gmail]/Spam` (matched by Message-ID —
//               All Mail excludes Spam, and UIDs are per folder)
//   promotions  the message's UID is in the All-Mail X-GM-RAW search
//               `category:promotions OR social OR updates OR forums`
//               (categories are NOT in the labels, only searchable)
//   primary     the Gmail labels include `\Inbox`
// Gmail's tokenizer drops brackets, so `subject:"[C7 buys]"` finds nothing:
// we search `from:<sender> newer_than:Nd` and match the `[C<n> <label>]`
// prefix client-side on the envelope.
//
// Layout: the decision logic is pure and unit-tested
// (tests/canary-judge.unit.test.ts); the IMAP read lives at the bottom so
// the engine's judgePass() stays thin. The Telegram verdict path
// (lib/campaignSenders.ts recordCanaryVerdict) writes the same
// `canary_verdicts[day]` slot — Ryan's reply is the override and is never
// overwritten here.

import { ImapFlow } from "imapflow"

/** Minutes between a canary leaving the sender mailbox and the first judge read (gives Gmail a beat to classify). */
export const JUDGE_MIN_AGE_MINUTES = 20
/** Days of history the daily judge searches per sender (the canary went out today; 3d absorbs a late pass). */
export const JUDGE_SEARCH_DAYS = 3
/** Days of history `--judge-backfill` searches per sender. */
export const BACKFILL_SEARCH_DAYS = 30

export const IMAP_HOST = "imap.gmail.com"
export const IMAP_PORT = 993
export const ALL_MAIL = "[Gmail]/All Mail"
export const SPAM = "[Gmail]/Spam"
/** Any non-Primary tab counts as Promotions — the gate only cares about Primary vs not. */
export const PROMO_CATEGORIES = ["promotions", "social", "updates", "forums"]

// ---------- pure logic ----------

/**
 * Placement signals → canary verdict. Spam wins over everything; any
 * non-Primary tab counts as Promotions (the gate only cares about Primary vs
 * not); `\Inbox` without a tab is Primary; anything else (archived, trashed,
 * unknown) is null = "not found", never a verdict.
 *
 * `placement` = { inSpam, inPromotions, labels } — `labels` are Gmail IMAP
 * labels (`\Inbox`, `\Important`, user labels…); a bare `INBOX` is accepted too.
 */
export function verdictFromLabels(placement) {
  const p = placement && typeof placement === "object" && !Array.isArray(placement) ? placement : {}
  if (p.inSpam === true) return "spam"
  if (p.inPromotions === true) return "promotions"
  if (hasInboxLabel(p.labels)) return "primary"
  return null
}

/** True when the Gmail labels include `\Inbox` (any backslash count / case; a Set or an array). */
export function hasInboxLabel(labels) {
  for (const l of labels ?? []) if (normalizeLabel(l) === "inbox") return true
  return false
}

function normalizeLabel(label) {
  return String(label ?? "").replace(/^\\+/, "").trim().toLowerCase()
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

/** Gmail `internalDate` (epoch ms — number, string, or a Date from imapflow) → PT day `YYYY-MM-DD`, or null when unparseable. */
export function ptDayFromInternalDate(internalDate) {
  const ms = internalDate instanceof Date ? internalDate.getTime() : Number(internalDate)
  if (!Number.isFinite(ms) || ms <= 0) return null
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms))
}

/** The canary prefix the engine stamps on the subject: `[C<n> <label>]`. */
export function canarySubjectTag(code, label) {
  return `[${code} ${label}]`
}

/** True when `subject` carries exactly this sender's canary tag (`[C8 buys]`, case-insensitive label, Re:/Fwd: tolerated). */
export function matchesCanaryTag(subject, code, label) {
  const tag = parseCanarySubject(subject)
  if (!tag) return false
  return `C${tag.n}` === String(code).toUpperCase() && tag.label === String(label).toLowerCase()
}

/** X-GM-RAW search for one sender's mail in the judge mailbox (the subject tag is matched client-side — Gmail's tokenizer drops the brackets). */
export function judgeQueryFor(senderEmail, days = JUDGE_SEARCH_DAYS) {
  return `from:${senderEmail} newer_than:${days}d`
}

/** X-GM-RAW search for one sender's mail that Gmail filed under a non-Primary tab. */
export function promotionsQueryFor(senderEmail, days = BACKFILL_SEARCH_DAYS) {
  return `from:${senderEmail} newer_than:${days}d (${PROMO_CATEGORIES.map((c) => `category:${c}`).join(" OR ")})`
}

/** X-GM-RAW search for one sender's mail in `[Gmail]/Spam` (no age bound — Gmail empties Spam after 30 days). */
export function spamQueryFor(senderEmail) {
  return `from:${senderEmail}`
}

/** Message-ID normalised for cross-folder matching (`<id@host>` → `id@host`, lowercase). */
export function normalizeMessageId(messageId) {
  return String(messageId ?? "").trim().replace(/^<|>$/g, "").trim().toLowerCase() || null
}

/** `{ inSpam, inPromotions, labels }` for one message given the folder searches it appeared in. */
export function placementOf({ labels, messageId, spamMessageIds, promotionUids, uid, inSpam = false }) {
  const mid = normalizeMessageId(messageId)
  return {
    inSpam: inSpam === true || Boolean(mid && spamMessageIds?.has?.(mid)),
    inPromotions: Boolean(promotionUids?.has?.(uid)),
    labels: Array.from(labels ?? [], (l) => String(l)),
  }
}

/** Newest message among `messages` carrying this canary's `[C<n> <label>]` tag, or null. */
export function newestCanary(messages, code, label) {
  let best = null
  for (const m of messages ?? []) {
    if (!matchesCanaryTag(m.subject, code, label)) continue
    if (!best || Number(m.internalDate) > Number(best.internalDate)) best = m
  }
  return best
}

/** Short human note on where a message sits, for logs and the backfill table. */
export function describePlacement(message) {
  if (!message) return "—"
  const parts = []
  if (message.inSpam) parts.push("spam folder")
  if (message.inPromotions) parts.push("category:promotions")
  const labels = Array.from(message.labels ?? [], (l) => String(l))
  parts.push(labels.length ? `labels ${labels.join(",")}` : "no labels")
  return parts.join(", ")
}

/**
 * Pure: given what the judge mailbox returned for one (sender, day) and the
 * sender's current state, decide what to record. Ryan's own verdict for that
 * day is the override: an existing verdict is never overwritten.
 *
 *   { action: "skip", reason: "already recorded", existing }
 *   { action: "skip", reason: "not found" }            (no message, or no placement signal)
 *   { action: "record", verdict }
 */
export function decideVerdict({ state, day, placement, found = true }) {
  const existing = state?.canary_verdicts?.[day] ?? null
  if (existing) return { action: "skip", reason: "already recorded", existing }
  if (!found) return { action: "skip", reason: "not found" }
  const verdict = verdictFromLabels(placement)
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
 * inSpam, inPromotions, labels }] from the judge mailbox; `senders` = engine
 * SENDERS; `states` = Map(email → sender state). Returns one row per canary
 * message, newest message per (sender, day) winning, with the action for each:
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
    const internalDate = msg.internalDate instanceof Date ? msg.internalDate.getTime() : Number(msg.internalDate)
    const base = {
      sender: from, label: tag.label, code: `C${tag.n}`, day, internalDate,
      inSpam: msg.inSpam === true, inPromotions: msg.inPromotions === true, labels: Array.from(msg.labels ?? [], (l) => String(l)),
    }
    if (!sender) { rows.push({ ...base, action: "skip", reason: "unknown sender" }); continue }
    if (sender.label.toLowerCase() !== tag.label) { rows.push({ ...base, action: "skip", reason: `label mismatch (${sender.label})` }); continue }
    const key = `${from}|${day}`
    const prev = latest.get(key)
    if (!prev || base.internalDate > prev.internalDate) latest.set(key, base)
  }
  for (const cand of latest.values()) {
    const d = decideVerdict({ state: states?.get?.(cand.sender), day: cand.day, placement: cand })
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
  return `ramp stalled: ${label} has ${healthy} healthy days but ${why} — the judge is not recording. Check CANARY_JUDGE_IMAP_USER / CANARY_JUDGE_IMAP_PASSWORD or reply "canary ${label} primary|promotions|spam".`
}

// ---------- IMAP (judge mailbox, Gmail App Password) ----------

/** Both IMAP vars present. The judge pass skips with one log line otherwise; Telegram verdicts keep working. */
export function judgeConfigured(env = process.env) {
  return Boolean(env.CANARY_JUDGE_IMAP_USER && env.CANARY_JUDGE_IMAP_PASSWORD)
}

/** `{ user, pass }` for imapflow — the app password is shown by Google in 4-char groups; spaces are stripped. */
export function judgeImapAuth(env = process.env) {
  const user = String(env.CANARY_JUDGE_IMAP_USER ?? "").trim()
  const pass = String(env.CANARY_JUDGE_IMAP_PASSWORD ?? "").replace(/\s+/g, "")
  if (!user || !pass) throw new Error("CANARY_JUDGE_IMAP_USER / CANARY_JUDGE_IMAP_PASSWORD not set")
  return { user, pass }
}

/**
 * Open the one IMAP connection a pass uses. Throws on login failure (the
 * error carries `authenticationFailed: true` — see isJudgeAuthError). The
 * caller owns `client.logout()` in a `finally`.
 */
export async function connectJudge(env = process.env) {
  const client = new ImapFlow({ host: IMAP_HOST, port: IMAP_PORT, secure: true, auth: judgeImapAuth(env), logger: false, emitLogs: false })
  // A dropped socket after connect() emits 'error'; without a listener Node
  // would crash the whole engine run, not just the judge pass.
  client.on("error", (e) => console.error("[campaign] judge IMAP connection error:", String(e?.message ?? e)))
  await client.connect()
  return client
}

/** Close the connection, swallowing errors (the pass already has its result or its failure). */
export async function disconnectJudge(client) {
  if (!client) return
  try { await client.logout() } catch { try { client.close() } catch { /* already gone */ } }
}

/**
 * Read every canary-tagged message from `senderEmails` in the judge mailbox
 * from the last `days` days, with its placement signals. One pass over
 * `[Gmail]/Spam` (for the spam set + spam-filed canaries), then one over
 * `[Gmail]/All Mail` (messages + the promotions UID set). Returns
 * Map(senderEmail → [{ uid, messageId, from, subject, internalDate (ms),
 * labels, inSpam, inPromotions }]), every sender present (possibly empty).
 */
export async function readCanaryMessages(client, senderEmails, { days = JUDGE_SEARCH_DAYS } = {}) {
  const emails = [...new Set((senderEmails ?? []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))]
  const out = new Map(emails.map((e) => [e, []]))
  if (!emails.length) return out
  const spamIds = new Set() // normalised Message-IDs sitting in Spam
  const spamMessages = new Map(emails.map((e) => [e, []]))

  await withMailbox(client, SPAM, async () => {
    for (const email of emails) {
      const uids = await searchUids(client, spamQueryFor(email))
      for (const m of await fetchMeta(client, uids)) {
        const mid = normalizeMessageId(m.messageId)
        if (mid) spamIds.add(mid)
        if (parseCanarySubject(m.subject)) spamMessages.get(email).push({ ...m, inSpam: true, inPromotions: false })
      }
    }
  })

  await withMailbox(client, ALL_MAIL, async () => {
    for (const email of emails) {
      const uids = await searchUids(client, judgeQueryFor(email, days))
      const promotionUids = new Set(uids.length ? await searchUids(client, promotionsQueryFor(email, Math.max(days, BACKFILL_SEARCH_DAYS))) : [])
      const list = out.get(email)
      const seen = new Set()
      for (const m of await fetchMeta(client, uids)) {
        if (!parseCanarySubject(m.subject)) continue
        const mid = normalizeMessageId(m.messageId)
        if (mid) seen.add(mid)
        list.push({ ...m, ...placementOf({ labels: m.labels, messageId: m.messageId, spamMessageIds: spamIds, promotionUids, uid: m.uid }) })
      }
      // Spam-filed canaries are NOT in All Mail — add them unless Gmail also
      // showed the same Message-ID there (then the All Mail copy already
      // carries inSpam via the Message-ID match).
      for (const m of spamMessages.get(email)) {
        const mid = normalizeMessageId(m.messageId)
        if (mid && seen.has(mid)) continue
        list.push(m)
      }
      list.sort((a, b) => Number(b.internalDate) - Number(a.internalDate))
    }
  })
  return out
}

async function withMailbox(client, path, fn) {
  const lock = await client.getMailboxLock(path)
  try { return await fn() } finally { lock.release() }
}

/** X-GM-RAW search in the open mailbox → UIDs (imapflow returns `false` for no match). */
async function searchUids(client, gmraw) {
  const r = await client.search({ gmraw }, { uid: true })
  return Array.isArray(r) ? r : []
}

/** envelope + Gmail labels + internalDate for `uids` in the open mailbox — never a body, never \Seen. */
async function fetchMeta(client, uids) {
  const out = []
  if (!uids.length) return out
  for await (const msg of client.fetch(uids, { uid: true, envelope: true, labels: true, internalDate: true }, { uid: true })) {
    out.push(summarize(msg))
  }
  return out
}

/** imapflow FetchMessageObject → the flat shape the pure functions take. Exported for tests. */
export function summarize(msg) {
  const env = msg?.envelope ?? {}
  const sender = Array.isArray(env.from) && env.from[0] ? env.from[0] : null
  const from = sender ? (sender.name ? `${sender.name} <${sender.address ?? ""}>` : String(sender.address ?? "")) : ""
  const internal = msg?.internalDate instanceof Date ? msg.internalDate.getTime() : msg?.internalDate ? new Date(msg.internalDate).getTime() : env.date instanceof Date ? env.date.getTime() : NaN
  return {
    uid: msg?.uid,
    messageId: env.messageId ?? null,
    from,
    subject: String(env.subject ?? ""),
    internalDate: Number.isFinite(internal) ? internal : 0,
    labels: Array.from(msg?.labels ?? [], (l) => String(l)),
  }
}

/** True for the login failures that mean "rerun the app password", not "retry". */
export function isJudgeAuthError(err) {
  if (err?.authenticationFailed === true) return true
  const text = judgeErrorText(err)
  return /AUTHENTICATIONFAILED|invalid credentials|authentication failed|application-specific password required|web login required|\bLOGIN failed\b/i.test(text)
}

/** One-line error text for logs and the Telegram alert (imapflow puts the server's NO response on `response`). */
export function judgeErrorText(err) {
  if (!err) return ""
  const parts = [err.message, err.response, err.responseText, err.serverResponseCode, err.code].filter((p) => p && typeof p !== "object").map(String)
  return (parts.length ? [...new Set(parts)].join(" · ") : String(err)).trim()
}
