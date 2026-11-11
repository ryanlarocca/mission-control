// Inbox Agent — Relationships email sync (briefs/BRIEF_RELATIONSHIP_EMAIL_SYNC_2026-11-11.md, work package B).
//
// Ryan 2026-11-11: email with someone who has a Relationships card should land
// on the card by itself, silently, and never add people. This is the Mac-mini
// half: it finds candidate messages on ryan@lrghomes.com and POSTs them to
// Mission Control's /api/crms/email-sync, which matches, dedupes, saves and
// writes the notes. The mini does NOT decide anything about the card itself.
//
//   inbound  inbox_messages rows (kind human | deal_lead) whose sender is a card email
//   sent     `in:sent` mail with at least one To/Cc on a card
//   bounce   mailer-daemon / postmaster mail whose failed recipient is a card email
//
// Rules that shape the code:
//   - Silent on success: console log only. One Telegram alert at most per Pacific
//     day, only after three failed passes in a row (alertDecision). The pass never
//     throws — a Gmail / Supabase / Mission Control failure must not stop the rest
//     of the inbox agent.
//   - No backfill: `card_sync.since` is created as "now" on the first run, and no
//     candidate is ever older than 8 days unless --cards-since says so (the one
//     hand-run catch-up for the Mega Meetup contacts).
//   - Don't re-read what is done: a relationship_touches row with the Gmail id, or
//     an id in the settings done-list (last 500), skips a message before its body
//     is fetched. Failures simply stay out of the done-list and retry every pass.
//   - Pure logic (address parsing, own-domain stripping, candidate filtering,
//     bounce recipient extraction, alert throttle, list trimming, batching) is
//     exported and unit-tested (tests/inbox-cards.unit.test.ts); IO is at the bottom.
//
// State lives in inbox_settings key `card_sync`:
//   since         ISO start line (go-live)
//   done          [gmail id] the endpoint finished with (last 500)
//   skipped       [gmail id] looked at and not for any card / unreadable — saves re-reading
//                 sent mail every pass; a hand-run catch-up ignores it (a card added later)
//   streak        failed passes in a row
//   alerted_date  Pacific day of the last Telegram alert
//   bounce_queue  [{gmailId, name, addr, at}] lines for the next morning brief (maybeDigest reads + clears)
import { MAILBOX, fetchAll, getSetting, log, ptParts, sb, setSetting, warn } from "./env.mjs"
import { getMessage, listMessageIds } from "./gmail.mjs"
import { esc, tgSend } from "./telegram.mjs"

export const SETTING_KEY = "card_sync"
export const MAX_AGE_DAYS = 8 // never look further back than this without --cards-since
export const BATCH_SIZE = 10 // contract: at most 10 messages per POST
export const DONE_KEEP = 500
export const SKIPPED_KEEP = 800
export const ALERT_AFTER = 3 // failed passes in a row
export const MAX_TEXT_CHARS = 50_000 // keeps 10 messages well under the request body limit
export const OWN_DOMAINS = ["lrghomes.com", "lrghomesbuys.com", "lrghomesoffers.com"]
export const CARD_KINDS = ["human", "deal_lead"]

const POST_TIMEOUT_MS = 65_000 // the route's maxDuration is 60
const MC_BASE_URL = (process.env.MC_BASE_URL || "https://mission-control-three-chi.vercel.app").trim().replace(/\/$/, "")

// ------------------------------------------------------------------ pure: addresses
const EMAIL_FULL = /^[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i
const EMAIL_TOKEN = "([a-z0-9._%+'-]+@[a-z0-9-]+(?:\\.[a-z0-9-]+)+)"

/** Split a To/Cc/X-Failed-Recipients header into lower-cased addresses. Commas inside "quoted names" or <...> don't split; groups like "undisclosed-recipients:;" yield nothing. */
export function parseAddressList(header) {
  const s = String(header || "")
  const parts = []
  let cur = ""
  let quote = false
  let angle = false
  for (const ch of s) {
    if (ch === '"') quote = !quote
    else if (!quote && ch === "<") angle = true
    else if (!quote && ch === ">") angle = false
    if ((ch === "," || ch === ";") && !quote && !angle) {
      parts.push(cur)
      cur = ""
    } else cur += ch
  }
  parts.push(cur)
  const out = []
  for (const p of parts) {
    const m = /<([^<>]+)>/.exec(p)
    const email = (m ? m[1] : p).trim().replace(/^mailto:/i, "").toLowerCase()
    if (EMAIL_FULL.test(email) && !out.includes(email)) out.push(email)
  }
  return out
}

/** Ryan's own addresses: the three sending domains plus the mailbox itself. */
export function isOwnAddress(email, mailbox = MAILBOX) {
  const e = String(email || "").toLowerCase().trim()
  if (!e) return false
  if (e === String(mailbox || "").toLowerCase()) return true
  const d = e.split("@")[1] || ""
  return OWN_DOMAINS.includes(d)
}

/** To + Cc, lower-cased, de-duplicated, Ryan's own addresses removed. */
export function recipientsOf(to, cc, mailbox = MAILBOX) {
  const out = []
  for (const e of [...parseAddressList(to), ...parseAddressList(cc)]) {
    if (!isOwnAddress(e, mailbox) && !out.includes(e)) out.push(e)
  }
  return out
}

/** relationships rows → Map(lower-cased email → {id, name}). `only` (Set) narrows to a hand-picked list. First card wins on a shared address. */
export function cardEmailMap(rows, only = null) {
  const map = new Map()
  for (const r of rows || []) {
    const e = String(r?.email || "").trim().toLowerCase()
    if (!EMAIL_FULL.test(e)) continue
    if (only && !only.has(e)) continue
    if (!map.has(e)) map.set(e, { id: r.id, name: r.name || e })
  }
  return map
}

export function parseEmailList(s) {
  return new Set(String(s || "").split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter((x) => EMAIL_FULL.test(x)))
}

// ------------------------------------------------------------------ pure: window
/** "2d" / "36h" / an ISO date or timestamp → ISO string, or null when it can't be read. */
export function parseSince(s, now = Date.now()) {
  const str = String(s ?? "").trim()
  if (!str) return null
  const rel = /^(\d+(?:\.\d+)?)\s*(d|h)$/i.exec(str)
  if (rel) return new Date(now - Number(rel[1]) * (rel[2].toLowerCase() === "h" ? 3_600_000 : 86_400_000)).toISOString()
  const t = new Date(str).getTime()
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/** The oldest message time we will consider: the start line, but never older than 8 days — unless --cards-since overrides both. */
export function sinceWindow({ startLine, cliSince = null, now = Date.now() }) {
  if (cliSince) return cliSince
  const floor = new Date(now - MAX_AGE_DAYS * 86_400_000).toISOString()
  if (!startLine) return new Date(now).toISOString()
  return startLine > floor ? startLine : floor
}

// ------------------------------------------------------------------ pure: bounces
const SYSTEM_SENDER_RE = /^(mailer-daemon|postmaster)@/i
const BOUNCE_SUBJECT_RE = /^(delivery status notification|undeliverable|undelivered mail|mail delivery (failed|subsystem|notification)|returned mail|failure notice|delivery has failed)/i

/** Delivery-failure mail: a mailer-daemon / postmaster sender, or the classic subject lines. */
export function isBounce({ sender, subject }) {
  return SYSTEM_SENDER_RE.test(String(sender || "").trim()) || BOUNCE_SUBJECT_RE.test(String(subject || "").trim())
}

/**
 * Who a bounce was for. Order of trust: the X-Failed-Recipients header, then the
 * well-known phrases in the body (Gmail, DSN Final-Recipient, Postfix "<x>:"),
 * then — last resort — the first outside address anywhere in the body.
 * Returns every candidate lower-cased and de-duplicated; the caller keeps the
 * first one that is a card email (a stray address never reaches a card).
 */
export function bounceRecipients({ header = "", text = "" }, mailbox = MAILBOX) {
  const usable = (e) => e && !isOwnAddress(e, mailbox) && !SYSTEM_SENDER_RE.test(e)
  const out = []
  const add = (e) => {
    const x = String(e || "").toLowerCase()
    if (usable(x) && !out.includes(x)) out.push(x)
  }
  for (const e of parseAddressList(header)) add(e)
  const body = String(text || "")
  const patterns = [
    new RegExp(`(?:wasn['’]t delivered to|couldn['’]t be delivered to|following (?:recipient|address)(?:es)?[^:\\n]{0,60}:)\\s*[<\\s]*${EMAIL_TOKEN}`, "gi"),
    new RegExp(`(?:Final|Original)-Recipient:\\s*rfc822;\\s*<?${EMAIL_TOKEN}`, "gi"),
    new RegExp(`^\\s*<${EMAIL_TOKEN}>:`, "gim"),
  ]
  for (const re of patterns) for (const m of body.matchAll(re)) add(m[1])
  if (!out.length) for (const m of body.matchAll(new RegExp(EMAIL_TOKEN, "gi"))) add(m[1])
  return out
}

/** First failed recipient that is a card email (and, for a hand-run, in the picked list — cardEmails is already narrowed). */
export function bounceTarget(recipients, cardEmails) {
  return (recipients || []).find((e) => cardEmails.has(e)) || null
}

// ------------------------------------------------------------------ pure: candidates
/**
 * inbox_messages rows → inbound candidates: this mailbox, kind human | deal_lead,
 * at/after the window, sender on a card. Newest last.
 */
export function inboundCandidates(rows, { cardEmails, sinceIso, mailbox = MAILBOX }) {
  const out = []
  for (const r of rows || []) {
    const sender = String(r.sender || "").trim().toLowerCase()
    if (r.mailbox && String(r.mailbox).toLowerCase() !== mailbox) continue
    if (!CARD_KINDS.includes(r.kind)) continue
    if (!r.internal_date || r.internal_date < sinceIso) continue
    if (!cardEmails.has(sender) || isOwnAddress(sender, mailbox)) continue
    out.push({ gmailId: r.gmail_id, threadId: r.thread_id || null, direction: "inbound", at: r.internal_date, from: sender, subject: r.subject || "", kind: r.kind })
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : 1))
}

/** inbox_messages rows → bounce candidates (not yet matched to a card — that needs the body). */
export function bounceCandidates(rows, { sinceIso, mailbox = MAILBOX }) {
  const out = []
  for (const r of rows || []) {
    if (r.mailbox && String(r.mailbox).toLowerCase() !== mailbox) continue
    if (!r.internal_date || r.internal_date < sinceIso) continue
    if (!isBounce({ sender: r.sender, subject: r.subject })) continue
    out.push({ gmailId: r.gmail_id, threadId: r.thread_id || null, direction: "bounce", at: r.internal_date, from: String(r.sender || "").toLowerCase(), subject: r.subject || "" })
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : 1))
}

/**
 * Sent-mail metadata ({id, threadId, internalDate, to, cc}) → {matches, noCard}.
 * A match has at least one To/Cc (own addresses removed) on a card; noCard are the
 * ids looked at and not for any card (remembered so they aren't re-read every pass).
 */
export function sentCandidates(metas, { cardEmails, sinceIso, mailbox = MAILBOX }) {
  const matches = []
  const noCard = []
  for (const m of metas || []) {
    if (!m.internalDate || m.internalDate < sinceIso) continue
    const recipients = recipientsOf(m.to, m.cc, mailbox)
    const onCard = recipients.filter((e) => cardEmails.has(e))
    if (!onCard.length) noCard.push(m.id)
    else matches.push({ gmailId: m.id, threadId: m.threadId || null, direction: "sent", at: m.internalDate, recipients, cardRecipients: onCard })
  }
  matches.sort((a, b) => (a.at < b.at ? -1 : 1))
  return { matches, noCard }
}

/** Drop what is already done: in the settings done-list, skipped list (unless a hand-run), or has a touch row with that Gmail id. */
export function dropDone(cands, { done = new Set(), touched = new Set(), skipped = new Set() } = {}) {
  return (cands || []).filter((c) => !done.has(c.gmailId) && !touched.has(c.gmailId) && !skipped.has(c.gmailId))
}

// ------------------------------------------------------------------ pure: payload + results
/** One message in the contract's shape. `msg` is gmail.mjs getMessage(); `extra` carries the recipients override / failedRecipient. */
export function buildPayload(msg, direction, { failedRecipient = null, kind = null, mailbox = MAILBOX } = {}) {
  const at = msg.internalDate ? new Date(msg.internalDate).toISOString().replace(/\.\d{3}Z$/, "Z") : null
  return {
    gmailId: msg.id,
    threadId: msg.threadId || null,
    direction,
    at,
    from: String(msg.from?.email || "").toLowerCase(),
    to: direction === "bounce" ? [] : recipientsOf(msg.to, msg.cc, mailbox),
    subject: msg.subject || "",
    text: String(msg.text || "").slice(0, MAX_TEXT_CHARS),
    failedRecipient: direction === "bounce" ? failedRecipient : null,
    // Inbound only: how the poll classified it. Mission Control alerts Telegram for a card
    // contact's email, except a deal_lead — that one already got its deal card (2026-11-11).
    kind: direction === "inbound" ? kind || null : null,
  }
}

/** Chunks of at most `size` (the contract allows 10 per POST). */
export function chunk(arr, size = BATCH_SIZE) {
  const out = []
  for (let i = 0; i < (arr || []).length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** Keep the newest `max` ids, oldest dropped, duplicates collapsed (a repeat moves to the newest end). */
export function trimDone(list, max = DONE_KEEP) {
  const seen = new Set()
  const rev = []
  for (let i = (list || []).length - 1; i >= 0; i--) {
    const id = list[i]
    if (!id || seen.has(id)) continue
    seen.add(id)
    rev.push(id)
  }
  return rev.slice(0, max).reverse()
}

/**
 * Read one endpoint response against what was sent.
 *   done     ids Mission Control finished with (logged / duplicate / no card / a blast …)
 *   retry    ids to send again next pass (done:false, or missing from the response)
 *   bounces  [{gmailId, name, addr}] for bounce messages where a card was actually written (status "logged")
 */
export function interpretResults(sent, results) {
  const byId = new Map()
  for (const r of Array.isArray(results) ? results : []) if (r?.gmailId) byId.set(r.gmailId, r)
  const done = []
  const retry = []
  const bounces = []
  for (const m of sent) {
    const r = byId.get(m.gmailId)
    if (!r || r.done !== true) {
      retry.push(m.gmailId)
      continue
    }
    done.push(m.gmailId)
    if (m.direction === "bounce") {
      for (const c of r.cards || []) {
        if (c?.status === "logged") bounces.push({ gmailId: m.gmailId, name: c.name || m.failedRecipient, addr: m.failedRecipient })
      }
    }
  }
  return { done, retry, bounces }
}

// ------------------------------------------------------------------ pure: alert + brief
/** Failed passes in a row: a failed pass adds one, a good pass resets to zero. */
export function nextStreak(prev, failed) {
  return failed ? Number(prev || 0) + 1 : 0
}

/** One alert per Pacific day, only once the sync has failed `after` passes in a row. */
export function alertDecision({ streak, alertedDate, today, after = ALERT_AFTER }) {
  return Number(streak || 0) >= after && alertedDate !== today
}

export function alertText(reason) {
  const r = String(reason || "unknown error").replace(/\s+/g, " ").trim().slice(0, 160)
  return `⚠️ Relationships email sync is failing — ${esc(r)}. Nothing is lost; it will catch up.`
}

export function bounceBriefLine({ name, addr }) {
  return `📭 Your email to ${esc(name)} (${esc(addr)}) bounced — the address on their card may be wrong.`
}

/** Add bounce lines to the queue, one per Gmail message + address. */
export function queueBounces(queue, bounces, at = new Date().toISOString()) {
  const out = [...(queue || [])]
  for (const b of bounces || []) {
    if (!out.some((q) => q.gmailId === b.gmailId && q.addr === b.addr)) out.push({ gmailId: b.gmailId, name: b.name, addr: b.addr, at })
  }
  return out.slice(-50)
}

// ------------------------------------------------------------------ IO: cards, touches, Gmail
async function loadCards(only) {
  // 1,057+ rows against PostgREST's 1,000-row cap: read in pages, ordered by id so they don't overlap.
  const rows = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb().from("relationships").select("id, name, email").not("email", "is", null).order("id", { ascending: true }).range(from, from + 999)
    if (error) throw new Error(`relationships: ${error.message}`)
    rows.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  return cardEmailMap(rows, only)
}

let touchLookupWarned = false
/** Gmail ids that already have a relationship_touches row. The column comes with the other work package's migration — any error here means "none found" (logged once). */
async function touchedIds(ids) {
  const found = new Set()
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await sb().from("relationship_touches").select("gmail_message_id").in("gmail_message_id", ids.slice(i, i + 150))
    if (error) {
      if (!touchLookupWarned) {
        touchLookupWarned = true
        log(`card sync: relationship_touches.gmail_message_id lookup failed (${error.message}) — treating as none found`)
      }
      return found
    }
    for (const r of data || []) if (r.gmail_message_id) found.add(r.gmail_message_id)
  }
  return found
}

function headerOf(headers, name) {
  return (headers || []).find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || ""
}

async function sentMetas(gmail, ids) {
  const metas = []
  let failed = 0
  for (const id of ids) {
    try {
      const { data } = await gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["To", "Cc"] })
      const h = data.payload?.headers || []
      metas.push({ id, threadId: data.threadId, internalDate: data.internalDate ? new Date(Number(data.internalDate)).toISOString() : null, to: headerOf(h, "To"), cc: headerOf(h, "Cc") })
    } catch (e) {
      failed++
      warn(`card sync: sent message ${id} unreadable this pass:`, e?.response?.data?.error?.message || e.message)
    }
  }
  if (failed && failed * 2 > ids.length) throw new Error(`Gmail refused ${failed} of ${ids.length} sent messages`)
  return metas
}

async function bounceHeader(gmail, id) {
  const { data } = await gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["X-Failed-Recipients"] })
  return headerOf(data.payload?.headers, "X-Failed-Recipients")
}

const gmailGone = (e) => e?.code === 404 || e?.response?.status === 404

/** `quiet` = a hand-run catch-up: Mission Control logs the emails but sends no Telegram alert for them. */
async function postBatch(messages, quiet = false) {
  const secret = (process.env.REPLY_INTERNAL_SECRET || process.env.MC_PASSWORD || "").trim()
  if (!secret) return { ok: false, reason: "no shared secret in env (REPLY_INTERNAL_SECRET / MC_PASSWORD)" }
  try {
    const res = await fetch(`${MC_BASE_URL}/api/crms/email-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-reply-secret": secret },
      body: JSON.stringify({ messages, quiet }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    })
    const data = await res.json().catch(() => ({}))
    if (res.status === 401) return { ok: false, reason: "Mission Control rejected the shared secret (401)" }
    if (!res.ok || !Array.isArray(data.results)) return { ok: false, reason: `Mission Control answered HTTP ${res.status}${data?.error ? ` (${String(data.error).slice(0, 80)})` : ""}` }
    return { ok: true, results: data.results }
  } catch (e) {
    return { ok: false, reason: `couldn't reach Mission Control (${e.message})` }
  }
}

// ------------------------------------------------------------------ the pass
/**
 * One sync pass. Never throws. opts: { dry, since (--cards-since), emails (--cards-emails) }.
 * Dry run reads Gmail + Supabase and prints what would be POSTed — no POST, no
 * settings write (not even the start line), no Telegram.
 */
export async function syncCards(ctx, { dry = false, since = null, emails = null } = {}) {
  try {
    await runPass(ctx, { dry, since, emails })
  } catch (e) {
    // Last-resort guard: anything unexpected is a failed pass, never a crash.
    warn("card sync crashed:", e.stack || e.message)
    await recordPass({ dry, reasons: [`unexpected error: ${e.message}`] }).catch((e2) => warn("card sync: couldn't record failure:", e2.message))
  }
}

async function runPass(ctx, { dry, since, emails }) {
  const state = await getSetting(SETTING_KEY)
  const now = new Date().toISOString()
  const handRun = !!(since || emails)

  let cliSince = null
  if (since) {
    cliSince = parseSince(since)
    if (!cliSince) return warn(`card sync: can't read --cards-since=${since} (use 2d, 36h or 2026-11-10)`)
  }
  const only = emails ? parseEmailList(emails) : null
  if (emails && !only.size) return warn(`card sync: no valid address in --cards-emails=${emails}`)

  // Start line: "now" on the very first run, so nothing before go-live is ever picked up.
  if (!state.since) {
    log(`card sync: first run — start line ${now}${dry ? " (dry run, not saved)" : ""}`)
    if (!dry) await setSetting(SETTING_KEY, { since: now, done: [], skipped: [], streak: 0 })
    state.since = now
  }
  const sinceIso = sinceWindow({ startLine: state.since, cliSince })

  const reasons = []
  const cardEmails = await loadCards(only).catch((e) => (reasons.push(`couldn't read the cards (${e.message})`), null))
  if (!cardEmails) return recordPass({ dry, reasons })
  if (!cardEmails.size) return log("card sync: no card emails to match")

  const done = new Set(state.done || [])
  const skipped = handRun ? new Set() : new Set(state.skipped || [])
  const newSkipped = []
  let candidates = []

  // inbound + bounces come from rows the poll already wrote; sent mail comes from Gmail.
  try {
    const cols = "gmail_id, thread_id, mailbox, internal_date, sender, subject, kind"
    const human = await fetchAll("inbox_messages", cols, (q) => q.eq("mailbox", MAILBOX).in("kind", CARD_KINDS).gte("internal_date", sinceIso), "internal_date")
    const system = await fetchAll("inbox_messages", cols, (q) => q.eq("mailbox", MAILBOX).eq("kind", "automated").or("sender.ilike.mailer-daemon@%,sender.ilike.postmaster@%").gte("internal_date", sinceIso), "internal_date")
    candidates.push(...inboundCandidates(human, { cardEmails, sinceIso }))
    candidates.push(...bounceCandidates(system, { sinceIso }))
  } catch (e) {
    reasons.push(`couldn't read the inbox rows (${e.message})`)
  }
  try {
    const epoch = Math.floor(new Date(sinceIso).getTime() / 1000)
    const ids = await listMessageIds(ctx.gmail, `in:sent after:${epoch}`, 400)
    const fresh = ids.filter((id) => !done.has(id) && !skipped.has(id))
    const touched = await touchedIds(fresh)
    const todo = fresh.filter((id) => !touched.has(id))
    const { matches, noCard } = sentCandidates(await sentMetas(ctx.gmail, todo), { cardEmails, sinceIso })
    candidates.push(...matches)
    newSkipped.push(...noCard)
  } catch (e) {
    reasons.push(`couldn't read sent mail (${e?.response?.data?.error?.message || e.message})`)
  }

  // Drop what's done, then fetch bodies for what's left.
  const touched = await touchedIds(candidates.map((c) => c.gmailId)).catch(() => new Set())
  candidates = dropDone(candidates, { done, touched, skipped })
  const payloads = []
  for (const c of candidates) {
    try {
      const msg = await getMessage(ctx.gmail, c.gmailId)
      if (c.direction === "bounce") {
        const header = await bounceHeader(ctx.gmail, c.gmailId).catch(() => "")
        const failed = bounceTarget(bounceRecipients({ header, text: msg.text }), cardEmails)
        if (!failed) {
          newSkipped.push(c.gmailId) // a bounce for someone who isn't on a card
          continue
        }
        payloads.push(buildPayload(msg, "bounce", { failedRecipient: failed }))
      } else {
        payloads.push(buildPayload(msg, c.direction, { kind: c.kind }))
      }
    } catch (e) {
      if (gmailGone(e)) {
        newSkipped.push(c.gmailId)
        continue
      }
      reasons.push(`couldn't read message ${c.gmailId} (${e?.response?.data?.error?.message || e.message})`)
    }
  }

  log(`card sync: window since ${sinceIso}, ${cardEmails.size} card emails, ${payloads.length} to post${handRun ? " (hand run)" : ""}`)

  if (dry) {
    for (const p of payloads) {
      console.log(`  - ${p.gmailId} ${p.direction} ${p.at} from=${p.from} to=${JSON.stringify(p.to)}${p.failedRecipient ? ` failed=${p.failedRecipient}` : ""}\n      subject: ${p.subject}\n      text: ${p.text.replace(/\s+/g, " ").slice(0, 80)}`)
    }
    if (!payloads.length) console.log("  (nothing to post)")
    if (reasons.length) console.log("  would count as a failed pass:", reasons.join("; "))
    return
  }

  const queued = []
  for (const batch of chunk(payloads)) {
    const sent = batch.map((p) => ({ gmailId: p.gmailId, direction: p.direction, failedRecipient: p.failedRecipient }))
    const r = await postBatch(batch, handRun)
    if (!r.ok) {
      reasons.push(r.reason)
      break // the endpoint is down or rejecting us — later batches would fail the same way
    }
    const out = interpretResults(sent, r.results)
    queued.push(...out.bounces)
    if (out.retry.length) reasons.push(`Mission Control couldn't finish ${out.retry.length} message${out.retry.length === 1 ? "" : "s"}`)
    // Save progress per batch so a crash later in the pass doesn't re-send what is finished.
    state.done = trimDone([...(state.done || []), ...out.done])
    await setSetting(SETTING_KEY, { done: state.done }).catch((e) => warn("card sync: done-list write failed:", e.message))
  }
  await recordPass({ dry, reasons, newSkipped, bounces: queued, handRun, posted: payloads.length })
}

/** End-of-pass bookkeeping: streak, the once-a-day alert, skipped list, bounce queue. Silent on success. */
async function recordPass({ dry, reasons = [], newSkipped = [], bounces = [], handRun = false, posted = 0 }) {
  const failed = reasons.length > 0
  if (failed) warn(`card sync: pass failed — ${reasons.join("; ")}`)
  else if (posted) log(`card sync: posted ${posted}, all finished`)
  if (dry) return
  const state = await getSetting(SETTING_KEY)
  const patch = {}
  // A hand-run catch-up never moves the failure streak or alerts — whoever ran it sees the warning above.
  const streak = handRun ? Number(state.streak || 0) : nextStreak(state.streak, failed)
  if (streak !== Number(state.streak || 0)) patch.streak = streak
  if (failed && !handRun) patch.last_error = { at: new Date().toISOString(), reason: reasons[0].slice(0, 200) }
  if (newSkipped.length) patch.skipped = trimDone([...(state.skipped || []), ...newSkipped], SKIPPED_KEEP)
  if (bounces.length) patch.bounce_queue = queueBounces(state.bounce_queue, bounces)
  const today = ptParts().date
  if (failed && !handRun && alertDecision({ streak, alertedDate: state.alerted_date, today })) {
    await tgSend(alertText(reasons[0]))
    patch.alerted_date = today
  }
  if (Object.keys(patch).length) await setSetting(SETTING_KEY, patch)
}

// ------------------------------------------------------------------ morning brief
/** Lines for the daily brief: one per queued bounce. `keys` identify what was shown so only those are cleared after the brief posts. */
export async function bounceBriefLines() {
  const q = (await getSetting(SETTING_KEY)).bounce_queue || []
  return { lines: q.map(bounceBriefLine), keys: q.map((b) => `${b.gmailId}|${b.addr}`) }
}

export async function clearBounceQueue(keys) {
  if (!keys?.length) return
  const shown = new Set(keys)
  const q = (await getSetting(SETTING_KEY)).bounce_queue || []
  await setSetting(SETTING_KEY, { bounce_queue: q.filter((b) => !shown.has(`${b.gmailId}|${b.addr}`)) })
}
