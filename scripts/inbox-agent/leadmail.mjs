// Inbox Agent — lead email sync (briefs/BRIEF_LEAD_EMAIL_SYNC_2026-11-17.md).
//
// Ryan 2026-11-17: email he sends a lead by hand from ryan@ (a written offer, a
// referral) and their replies never reached the lead card, so the judge kept
// ruling on stale facts. This is the Mac-mini half, built like cards.mjs (the
// Relationships sync): it finds candidate messages on ryan@lrghomes.com and
// POSTs them to Mission Control's /api/leads/email-sync, which matches,
// dedupes, writes the rows and sends the one alert. Matching rules are shared
// with Mission Control (leadmatch.mjs), so both halves agree on what a lead is.
//
//   inbound  inbox_messages rows (kind human | deal_lead) from a lead's address,
//            or on a lead's Gmail thread
//   sent     `in:sent` mail with a lead's address in To/Cc
//
// It runs just before the card sync and leaves two things on ctx for the pass:
//   ctx.leadIndex  every lead card (loadLeadIndex) — pollInbox uses it to skip
//                  the deal screen for a lead's email (isLeadSender): the lead
//                  alert is the one alert for it
//   ctx.leadGate   tells the card sync which inbound emails are on a lead card
//                  (posted with leadCard: true, so Relationships doesn't alert
//                  too) and which to hold a pass (the lead side isn't done)
//
// Same rules as the card sync: silent on success; three failed passes in a row →
// one helper-bot line a Pacific day; the pass never throws; no backfill (start
// line "now" on the first run, never older than 8 days) except the one hand-run
// catch-up `--leads-only --leads-since=30d` (quiet: rows, no alerts).
//
// State lives in inbox_settings key `lead_mail_sync`:
//   since, done (last 500), skipped (last 800 sent ids for no lead), streak,
//   alerted_date, last_error.
import { MAILBOX, fetchAll, getSetting, log, ptParts, sb, setSetting, warn } from "./env.mjs"
import { getMessage, listMessageIds } from "./gmail.mjs"
import { esc, opsSend } from "./telegram.mjs"
import { ALERT_AFTER, DONE_KEEP, SKIPPED_KEEP, alertDecision, buildPayload, chunk, dropDone, interpretResults, nextStreak, parseSince, recipientsOf, sentMetas, sinceWindow, trimDone } from "./cards.mjs"
import { LEAD_COLS, buildLeadIndex, clusterProfile, isLeadMessage, leadRowMessageId, matchLeadClusters, planLeadWrite } from "./leadmatch.mjs"

export const LEAD_SETTING_KEY = "lead_mail_sync"
// Any label but bulk mail: the sender has to be a lead's own address (or the
// thread a lead's), so a seller's reply the poll filed as "solicitation" or
// "broker_blast" still reaches the card.
export const BULK_KINDS = ["automated", "newsletter", "promotions"]
export const PASS_SENT_MAX = 400
export const HAND_RUN_SENT_MAX = 2000

const POST_TIMEOUT_MS = 65_000 // the route's maxDuration is 60
const MC_BASE_URL = (process.env.MC_BASE_URL || "https://mission-control-three-chi.vercel.app").trim().replace(/\/$/, "")

// ------------------------------------------------------------------ pure
/**
 * inbox_messages rows → inbound candidates: this mailbox, any kind but bulk mail,
 * in the window, from a lead (or on a lead's thread). The exact call — a third
 * party replying all on a lead's thread — is Mission Control's, with the To/Cc.
 */
export function leadInboundCandidates(rows, { index, sinceIso, mailbox = MAILBOX }) {
  const out = []
  for (const r of rows || []) {
    if (r.mailbox && String(r.mailbox).toLowerCase() !== mailbox) continue
    if (BULK_KINDS.includes(r.kind)) continue
    if (!r.internal_date || r.internal_date < sinceIso) continue
    const from = String(r.sender || "").trim().toLowerCase()
    if (!from || from === mailbox) continue
    if (!isLeadMessage(index, { direction: "inbound", from, to: [], threadId: r.thread_id || null })) continue
    out.push({ gmailId: r.gmail_id, threadId: r.thread_id || null, direction: "inbound", at: r.internal_date, from, subject: r.subject || "", kind: r.kind })
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : 1))
}

/** Sent metadata ({id, threadId, internalDate, to, cc}) → {matches, noLead}. noLead ids are remembered so they aren't re-read every pass. */
export function leadSentCandidates(metas, { index, sinceIso, mailbox = MAILBOX }) {
  const matches = []
  const noLead = []
  for (const m of metas || []) {
    if (!m.internalDate || m.internalDate < sinceIso) continue
    const recipients = recipientsOf(m.to, m.cc, mailbox)
    if (isLeadMessage(index, { direction: "sent", to: recipients, threadId: m.threadId || null })) {
      matches.push({ gmailId: m.id, threadId: m.threadId || null, direction: "sent", at: m.internalDate, recipients })
    } else noLead.push(m.id)
  }
  matches.sort((a, b) => (a.at < b.at ? -1 : 1))
  return { matches, noLead }
}

/**
 * What the card sync does with an inbound email that may be on a lead card:
 *   "lead"  a lead row carries it — log it on the Relationships card quietly
 *   "hold"  it is for a lead but the lead sync hasn't finished it — wait a pass
 *   null    not a lead's, or the lead side is done with it and wrote nothing
 */
export function leadGateDecision({ isLead, hasRow, leadDone }) {
  if (!isLead) return null
  if (hasRow) return "lead"
  return leadDone ? null : "hold"
}

/** What Mission Control will do, worked out locally from the same rules — the dry run's preview. */
export function previewPlan(index, payload, mailbox = MAILBOX) {
  const m = matchLeadClusters(index, { direction: payload.direction, from: payload.from, to: payload.to, threadId: payload.threadId })
  if (m.blast !== null) return [{ card: m.matches.map((x) => x.key).join(", ") || "-", action: `skip (a blast, ${m.blast} people)` }]
  const out = m.matches.map((x, i) => {
    const rows = index.clusters.get(x.key) || []
    const p = clusterProfile(rows)
    const plan = planLeadWrite(payload, leadRowMessageId(payload.gmailId, i, x.key), rows, { mailboxLine: `email:${mailbox}` })
    const action = plan.kind === "insert" ? `insert ${payload.direction === "sent" ? "Ryan-out" : "inbound"} row (email=${x.address})` : `${plan.kind} row ${plan.leadId}`
    return { card: x.key, name: p.name, via: x.via, action }
  })
  for (const s of m.skipped) out.push({ card: s.key, name: clusterProfile(index.clusters.get(s.key) || []).name, action: `skip (${s.reason})` })
  if (!out.length) out.push({ card: "-", action: "no lead card (Mission Control will answer done)" })
  return out
}

export function leadAlertText(reason) {
  const r = String(reason || "unknown error").replace(/\s+/g, " ").trim().slice(0, 160)
  return `⚠️ Lead email sync is failing — ${esc(r)}. Nothing is lost; it will catch up.`
}

// ------------------------------------------------------------------ IO
/** Every lead row (the table is ~1.2k rows — two pages), indexed into cards. Cached on ctx for the pass. */
export async function loadLeadIndex(ctx) {
  if (ctx?.leadIndex) return ctx.leadIndex
  const rows = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb().from("leads").select(LEAD_COLS).order("id", { ascending: true }).range(from, from + 999)
    if (error) throw new Error(`leads: ${error.message}`)
    rows.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  const index = buildLeadIndex(rows)
  if (ctx) ctx.leadIndex = index
  return index
}

/** pollInbox's question: is this email from a lead (then the lead alert covers it — no deal card)? False when the leads can't be read. */
export async function isLeadSender(ctx, msg) {
  try {
    const index = await loadLeadIndex(ctx)
    return isLeadMessage(index, { direction: "inbound", from: msg.from?.email, to: recipientsOf(msg.to, msg.cc), threadId: msg.threadId || null })
  } catch (e) {
    warn("lead check failed (deal screen runs as usual):", e.message)
    return false
  }
}

/** Gmail ids already on a lead row (leads.gmail_message_id). */
async function leadRowIds(ids) {
  const found = new Set()
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await sb().from("leads").select("gmail_message_id").in("gmail_message_id", ids.slice(i, i + 150))
    if (error) throw new Error(`leads.gmail_message_id: ${error.message}`)
    for (const r of data || []) if (r.gmail_message_id) found.add(r.gmail_message_id)
  }
  return found
}

const gmailGone = (e) => e?.code === 404 || e?.response?.status === 404

async function postBatch(messages, quiet) {
  const secret = (process.env.REPLY_INTERNAL_SECRET || process.env.MC_PASSWORD || "").trim()
  if (!secret) return { ok: false, reason: "no shared secret in env (REPLY_INTERNAL_SECRET / MC_PASSWORD)" }
  try {
    const res = await fetch(`${MC_BASE_URL}/api/leads/email-sync`, {
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
 * One sync pass. Never throws. opts: { dry, since (--leads-since) }.
 * Dry run reads Gmail + Supabase and prints what would be POSTed and what
 * Mission Control would do with it — no POST, no settings write, no Telegram.
 */
export async function syncLeadMail(ctx, { dry = false, since = null } = {}) {
  try {
    await runPass(ctx, { dry, since })
  } catch (e) {
    warn("lead mail sync crashed:", e.stack || e.message)
    await recordPass({ dry, reasons: [`unexpected error: ${e.message}`] }).catch((e2) => warn("lead mail sync: couldn't record failure:", e2.message))
  }
}

async function runPass(ctx, { dry, since }) {
  const state = await getSetting(LEAD_SETTING_KEY)
  const now = new Date().toISOString()
  const handRun = !!since
  let cliSince = null
  if (since) {
    cliSince = parseSince(since)
    if (!cliSince) return warn(`lead mail sync: can't read --leads-since=${since} (use 30d, 36h or 2026-10-18)`)
  }
  if (!state.since) {
    log(`lead mail sync: first run — start line ${now}${dry ? " (dry run, not saved)" : ""}`)
    if (!dry) await setSetting(LEAD_SETTING_KEY, { since: now, done: [], skipped: [], streak: 0 })
    state.since = now
  }
  const sinceIso = sinceWindow({ startLine: state.since, cliSince })

  const reasons = []
  const index = await loadLeadIndex(ctx).catch((e) => (reasons.push(`couldn't read the leads (${e.message})`), null))
  if (!index) return recordPass({ dry, reasons })

  const done = new Set(state.done || [])
  const skipped = handRun ? new Set() : new Set(state.skipped || [])
  const newSkipped = []
  let candidates = []

  try {
    const cols = "gmail_id, thread_id, mailbox, internal_date, sender, subject, kind"
    const rows = await fetchAll("inbox_messages", cols, (q) => q.eq("mailbox", MAILBOX).not("kind", "in", `(${BULK_KINDS.join(",")})`).gte("internal_date", sinceIso), "internal_date")
    candidates.push(...leadInboundCandidates(rows, { index, sinceIso }))
  } catch (e) {
    reasons.push(`couldn't read the inbox rows (${e.message})`)
  }
  try {
    const epoch = Math.floor(new Date(sinceIso).getTime() / 1000)
    const ids = await listMessageIds(ctx.gmail, `in:sent after:${epoch}`, handRun ? HAND_RUN_SENT_MAX : PASS_SENT_MAX)
    const fresh = ids.filter((id) => !done.has(id) && !skipped.has(id))
    const onRow = await leadRowIds(fresh)
    const { matches, noLead } = leadSentCandidates(await sentMetas(ctx.gmail, fresh.filter((id) => !onRow.has(id)), "lead mail sync"), { index, sinceIso })
    candidates.push(...matches)
    newSkipped.push(...noLead)
    if (handRun) log(`lead mail sync: ${ids.length} sent message${ids.length === 1 ? "" : "s"} in the window`)
  } catch (e) {
    reasons.push(`couldn't read sent mail (${e?.response?.data?.error?.message || e.message})`)
  }

  // Drop what's done (settings list or already on a lead row), then fetch bodies.
  const onRow = await leadRowIds(candidates.map((c) => c.gmailId)).catch(() => new Set())
  candidates = dropDone(candidates, { done, touched: onRow, skipped })
  const payloads = []
  for (const c of candidates) {
    try {
      const msg = await getMessage(ctx.gmail, c.gmailId)
      payloads.push(buildPayload(msg, c.direction, { kind: c.kind }))
    } catch (e) {
      if (gmailGone(e)) {
        newSkipped.push(c.gmailId)
        continue
      }
      reasons.push(`couldn't read message ${c.gmailId} (${e?.response?.data?.error?.message || e.message})`)
    }
  }

  log(`lead mail sync: window since ${sinceIso}, ${index.clusters.size} lead cards, ${payloads.length} to post${handRun ? " (hand run, quiet)" : ""}`)

  // The card sync's hand-off for this pass (see leadGateDecision).
  ctx.leadGate = async (inbound) => {
    const out = new Map()
    const leadish = (inbound || []).filter((c) => isLeadMessage(index, { direction: "inbound", from: c.from, to: [], threadId: c.threadId || null }))
    if (!leadish.length) return out
    const withRow = await leadRowIds(leadish.map((c) => c.gmailId))
    const finished = new Set((await getSetting(LEAD_SETTING_KEY)).done || [])
    for (const c of leadish) out.set(c.gmailId, leadGateDecision({ isLead: true, hasRow: withRow.has(c.gmailId), leadDone: finished.has(c.gmailId) }))
    return out
  }

  if (dry) {
    for (const p of payloads) {
      console.log(`  - ${p.gmailId} ${p.direction} ${p.at} thread=${p.threadId} from=${p.from} to=${JSON.stringify(p.to)}${p.kind ? ` kind=${p.kind}` : ""}\n      subject: ${p.subject}\n      text: ${p.text.replace(/\s+/g, " ").slice(0, 90)}`)
      for (const r of previewPlan(index, p)) console.log(`      → ${r.name ? `${r.name} ` : ""}[${r.card}]${r.via ? ` via ${r.via}` : ""}: ${r.action}`)
    }
    if (!payloads.length) console.log("  (nothing to post)")
    if (reasons.length) console.log("  would count as a failed pass:", reasons.join("; "))
    return
  }

  for (const batch of chunk(payloads)) {
    const sent = batch.map((p) => ({ gmailId: p.gmailId, direction: p.direction }))
    const r = await postBatch(batch, handRun)
    if (!r.ok) {
      reasons.push(r.reason)
      break // the endpoint is down or rejecting us — later batches would fail the same way
    }
    const out = interpretResults(sent, r.results)
    if (out.retry.length) reasons.push(`Mission Control couldn't finish ${out.retry.length} message${out.retry.length === 1 ? "" : "s"}`)
    for (const res of r.results) {
      for (const l of res?.leads || []) if (l?.status === "logged" || l?.status === "stamped") log(`lead mail sync: ${res.gmailId} → ${l.name || l.card} (${l.status}${res.alerted ? ", alerted" : ""})`)
    }
    state.done = trimDone([...(state.done || []), ...out.done], DONE_KEEP)
    await setSetting(LEAD_SETTING_KEY, { done: state.done }).catch((e) => warn("lead mail sync: done-list write failed:", e.message))
  }
  await recordPass({ dry, reasons, newSkipped, handRun, posted: payloads.length })
}

/** End-of-pass bookkeeping: streak, the once-a-day helper-bot line, skipped list. Silent on success. */
async function recordPass({ dry, reasons = [], newSkipped = [], handRun = false, posted = 0 }) {
  const failed = reasons.length > 0
  if (failed) warn(`lead mail sync: pass failed — ${reasons.join("; ")}`)
  else if (posted) log(`lead mail sync: posted ${posted}, all finished`)
  if (dry) return
  const state = await getSetting(LEAD_SETTING_KEY)
  const patch = {}
  const streak = handRun ? Number(state.streak || 0) : nextStreak(state.streak, failed)
  if (streak !== Number(state.streak || 0)) patch.streak = streak
  if (failed && !handRun) patch.last_error = { at: new Date().toISOString(), reason: reasons[0].slice(0, 200) }
  if (newSkipped.length) patch.skipped = trimDone([...(state.skipped || []), ...newSkipped], SKIPPED_KEEP)
  const today = ptParts().date
  if (failed && !handRun && alertDecision({ streak, alertedDate: state.alerted_date, today, after: ALERT_AFTER })) {
    await opsSend(leadAlertText(reasons[0]))
    patch.alerted_date = today
  }
  if (Object.keys(patch).length) await setSetting(LEAD_SETTING_KEY, patch)
}
