// Lead email on ryan@ lands on the lead card (2026-11-17,
// briefs/BRIEF_LEAD_EMAIL_SYNC_2026-11-17.md).
//
// Ryan emails some leads by hand from ryan@lrghomes.com (a written offer, a
// referral) and their replies come back there. Lead email intake
// (app/api/leads/email) only watches the campaign mailboxes, so none of it
// reached the card and the judge kept ruling on stale facts. The Mac-mini
// inbox agent (scripts/inbox-agent/leadmail.mjs) already reads ryan@ every
// pass; it POSTs candidate messages to /api/leads/email-sync and this module
// matches, dedupes, writes the rows and sends the one alert. Same design as
// the Relationships sync (lib/relationshipEmailSync.ts); the matching rules
// live in scripts/inbox-agent/leadmatch.mjs, shared with the mini.
//
//   sent     one Ryan-out row (lead_type email, no line, status contacted) —
//            the same shape as the card's own send. Silent.
//   inbound  one row shaped like an inbound email lead (line
//            "email:ryan@lrghomes.com", so replying from the card or from
//            Telegram goes back out from ryan@ in the same thread), status
//            inherited from the card, DNC carried. ONE Telegram alert that
//            records the lead (Draft: / ✅ work), never on a hand catch-up.
//
// Idempotency: the row carries the Gmail message id (unique index
// leads_gmail_message_id_uniq). A row added by hand or by the card's send with
// no Gmail id, on the same card, same direction, same thread (or none), within
// ten minutes of the email = the same email → the id is stamped onto it.

import type { SupabaseClient } from "@supabase/supabase-js"
import { isUniqueViolation } from "@/lib/emailDedupe"
import { alertQuote } from "@/lib/alertText"
import type { AlertSubject } from "@/lib/alertSubject"
import { isOwnMailbox } from "@/lib/relationshipEmail"
import { isQuietRequest, MAX_SYNC_MESSAGES, parseSyncMessage, touchBody, type SyncMessage } from "@/lib/relationshipEmailSync"
import {
  LEAD_COLS,
  buildLeadIndex,
  clusterProfile,
  leadMessageText,
  leadRowMessageId,
  matchLeadClusters,
  planLeadWrite,
} from "@/scripts/inbox-agent/leadmatch.mjs"

export { isQuietRequest, MAX_SYNC_MESSAGES }

export const SYNC_MAILBOX = "ryan@lrghomes.com"
export const SYNC_MAILBOX_LINE = `email:${SYNC_MAILBOX}`

export type LeadSyncStatus = "logged" | "stamped" | "duplicate" | "skipped"

export interface LeadCardResult {
  /** The row written / stamped / already there (null when skipped). */
  leadId: string | null
  /** The card (groupLeads key: phone:… / thread:… / email:…). */
  card: string
  name: string | null
  status: LeadSyncStatus
  reason?: string
}

export interface LeadSyncResult {
  gmailId: string
  leads: LeadCardResult[]
  /** An alert for this message was sent (inbound, newly logged, not quiet). */
  alerted: boolean
  /** false = the mini should send this message again next pass. */
  done: boolean
}

export interface LeadRow {
  id: string
  created_at: string
  lead_type: string | null
  twilio_number: string | null
  caller_phone: string | null
  email: string | null
  gmail_thread_id: string | null
  gmail_message_id: string | null
  name: string | null
  property_address: string | null
  source: string | null
  source_type: string | null
  status: string | null
  is_junk: boolean | null
  is_dnc: boolean | null
}

type Profile = ReturnType<typeof clusterProfile>

// ── Pure helpers ─────────────────────────────────────────────────────────

/** What the row says below the subject: only the new text (quoted thread cut). */
export function leadEmailBody(msg: SyncMessage): string {
  return touchBody(msg)
}

/** The insert for one message on one card. */
export function buildLeadRow(msg: SyncMessage, p: Profile, args: { address: string; rowMessageId: string; mailboxLine?: string }): Record<string, unknown> {
  const inbound = msg.direction === "inbound"
  return {
    lead_type: "email",
    twilio_number: inbound ? args.mailboxLine ?? SYNC_MAILBOX_LINE : null,
    status: inbound ? p.inheritedStatus : "contacted",
    caller_phone: p.phone,
    name: p.name,
    property_address: p.property_address,
    source: p.source,
    source_type: p.source_type,
    email: args.address,
    message: leadMessageText(msg.subject, leadEmailBody(msg)),
    gmail_message_id: args.rowMessageId,
    gmail_thread_id: msg.threadId,
    created_at: msg.at,
  }
}

/** "(650) 520-7069" from E.164 / 10 digits; as-is otherwise. */
function prettyPhone(p: string): string {
  const d = p.replace(/\D/g, "")
  const ten = d.length > 10 ? d.slice(-10) : d
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : p
}

/**
 * The Telegram alert (HTML), the lead-email alert's lines:
 *   📧 <b>Email from a lead</b> (ryan@)
 *   [Website]
 *   👤 Maryam Norton · 5122 Severance Ct
 *   📧 maryamjnorton@gmail.com
 *   📞 (650) 520-7069
 *   <b>Re: Offer for 5122 Severance Ct</b>
 *   "Thanks Ryan, we'll look it over…"
 */
export function leadEmailAlertText(p: Pick<Profile, "name" | "property_address" | "source" | "phone">, msg: Pick<SyncMessage, "from" | "subject">, body: string, opts: { dnc?: boolean; optOut?: boolean } = {}): string {
  const esc = (t: string) => t.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"))
  const lines = [`📧 <b>Email from a lead</b> (ryan@)${opts.dnc ? " · do-not-contact" : ""}`]
  if (p.source) lines.push(`[${esc(p.source)}]`)
  lines.push(`👤 ${esc(p.name?.trim() || "(no name)")}${p.property_address?.trim() ? ` · ${esc(p.property_address.trim())}` : ""}`)
  if (msg.from) lines.push(`📧 ${esc(msg.from)}`)
  if (p.phone) lines.push(`📞 ${prettyPhone(p.phone)}`)
  lines.push(`<b>${esc(msg.subject.trim() || "(no subject)")}</b>`)
  if (body.trim()) lines.push(`"${alertQuote(body.trim())}"`)
  if (opts.optOut) lines.push("🚫 They asked to be removed — marked do-not-contact.")
  return lines.join("\n")
}

/** Who the alert is about: the new inbound row (Draft: builds the card from it). */
export function leadEmailAlertAbout(leadId: string, email: string | null, phone: string | null): AlertSubject {
  return { kind: "lead", leadId, email, phone }
}

/** Every To/Cc that isn't one of Ryan's own addresses. */
export function outsideRecipients(to: readonly string[]): string[] {
  return to.filter((e) => !isOwnMailbox(e))
}

// ── IO ───────────────────────────────────────────────────────────────────

/** Every lead row's identity columns, paged (PostgREST's 1,000-row cap). */
export async function loadLeadRows(sb: SupabaseClient): Promise<LeadRow[]> {
  const PAGE = 1000
  const rows: LeadRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from("leads").select(LEAD_COLS).order("id", { ascending: true }).range(from, from + PAGE - 1)
    if (error) throw new Error(`lead lookup failed: ${error.message}`)
    const page = (data ?? []) as unknown as LeadRow[]
    rows.push(...page)
    if (page.length < PAGE) break
  }
  return rows
}

type Index = ReturnType<typeof buildLeadIndex>
type AlertJob = { leadId: string; profile: Profile; msg: SyncMessage; body: string; optOut: boolean }
type AfterJob = () => Promise<void>

async function stampRow(sb: SupabaseClient, leadId: string, rowMessageId: string): Promise<"stamped" | "duplicate"> {
  const { data, error } = await sb.from("leads").update({ gmail_message_id: rowMessageId }).eq("id", leadId).is("gmail_message_id", null).select("id")
  if (error && isUniqueViolation(error)) return "duplicate"
  if (error) throw new Error(`stamp failed: ${error.message}`)
  if (!data?.length) throw new Error("row was stamped meanwhile")
  return "stamped"
}

// Sent: what the card's own send does after its row — promote a New card to
// Contacted, restart the drip clock, catch a stated offer. Skipped on a hand
// catch-up (those emails are days old; the clock reset would be wrong).
async function afterSent(sb: SupabaseClient, rowId: string, row: Record<string, unknown>, p: Profile): Promise<void> {
  const { registerManualTouch, detectOfferFromText, applyDetectedOfferToCluster } = await import("@/lib/leads")
  const phone = (row.caller_phone as string | null) ?? null
  const email = (row.email as string | null) ?? null
  const intake = p.mostRecentInbound as LeadRow | null
  if (intake && intake.status === "new") {
    const { error } = await sb.from("leads").update({ status: "contacted" }).eq("id", intake.id).eq("status", "new")
    if (error) console.warn(`[lead-email-sync] promote failed for ${intake.id}:`, error.message)
  }
  try {
    await registerManualTouch(sb, { id: rowId, caller_phone: phone, email })
  } catch (e) {
    console.warn(`[lead-email-sync] cadence reset failed for ${rowId}:`, e instanceof Error ? e.message : String(e))
  }
  try {
    const text = String(row.message ?? "")
    const offer = await detectOfferFromText(text, { channel: "email", lead_name: p.name, property: p.property_address })
    if (offer?.offer_verbalized && typeof offer.offer_amount === "number") {
      await applyDetectedOfferToCluster(sb, { leadId: rowId, caller_phone: phone, email, gmail_thread_id: (row.gmail_thread_id as string | null) ?? null, offer_amount: offer.offer_amount })
    }
  } catch (e) {
    console.warn(`[lead-email-sync] offer detection failed for ${rowId}:`, e instanceof Error ? e.message : String(e))
  }
}

// Inbound: what intake does for an inbound email on a known card — carry DNC,
// honour an explicit remove request, re-run the automatic status. Returns
// whether the row ended do-not-contact and whether they asked to be removed.
async function afterInbound(sb: SupabaseClient, rowId: string, row: Record<string, unknown>, body: string): Promise<{ dnc: boolean; optOut: boolean }> {
  const { explicitOptOutPhrase, inheritContactDnc, markContactDnc } = await import("@/lib/dnc")
  const phone = (row.caller_phone as string | null) ?? null
  const email = (row.email as string | null) ?? null
  const carried = await inheritContactDnc(sb, rowId, { phone, email })
  let optOut = false
  if (!carried.dnc && explicitOptOutPhrase(body)) {
    try {
      const out = await markContactDnc(sb, rowId, { addedBy: "ai", heardAddress: (row.property_address as string | null) ?? body })
      optOut = out.ok !== false
    } catch (e) {
      console.warn(`[lead-email-sync] opt-out DNC failed for ${rowId}:`, e instanceof Error ? e.message : String(e))
    }
  }
  return { dnc: carried.dnc || optOut, optOut }
}

async function syncOne(
  sb: SupabaseClient,
  msg: SyncMessage,
  index: Index,
  opts: { quiet: boolean; queueAlert: (job: AlertJob) => void; queueAfter: (job: AfterJob) => void }
): Promise<LeadSyncResult> {
  if (msg.direction === "bounce") return { gmailId: msg.gmailId, leads: [], alerted: false, done: true }
  const outside = outsideRecipients(msg.to)
  const m = matchLeadClusters(index, { direction: msg.direction, from: msg.from, to: outside, threadId: msg.threadId })
  const nameOf = (key: string) => clusterProfile(index.clusters.get(key) ?? []).name
  const skipped: LeadCardResult[] = m.skipped.map((s) => ({ leadId: null, card: s.key, name: nameOf(s.key), status: "skipped", reason: s.reason }))
  if (m.blast !== null) {
    return { gmailId: msg.gmailId, leads: [...m.matches.map((x) => ({ leadId: null, card: x.key, name: nameOf(x.key), status: "skipped" as const, reason: `sent to ${m.blast} people — a blast` })), ...skipped], alerted: false, done: true }
  }

  const out: LeadCardResult[] = []
  let done = true
  // One query for every id this message could carry — the unique index is
  // global, so a row with it anywhere means it's already logged.
  const rowIds = m.matches.map((x, i) => leadRowMessageId(msg.gmailId, i, x.key))
  const taken = new Map<string, string>()
  if (rowIds.length) {
    const { data, error } = await sb.from("leads").select("id, gmail_message_id").in("gmail_message_id", rowIds)
    if (error) throw new Error(`dedupe lookup failed: ${error.message}`)
    for (const r of (data ?? []) as { id: string; gmail_message_id: string }[]) taken.set(r.gmail_message_id, r.id)
  }

  for (let i = 0; i < m.matches.length; i++) {
    const match = m.matches[i]
    const rows = index.clusters.get(match.key) ?? []
    const profile = clusterProfile(rows)
    const base = { card: match.key, name: profile.name }
    const rowMessageId = rowIds[i]
    try {
      if (taken.has(rowMessageId)) {
        out.push({ ...base, leadId: taken.get(rowMessageId)!, status: "duplicate" })
        continue
      }
      const plan = planLeadWrite(msg, rowMessageId, rows, { mailboxLine: SYNC_MAILBOX_LINE })
      if (plan.kind === "duplicate") {
        out.push({ ...base, leadId: plan.leadId, status: "duplicate" })
        continue
      }
      if (plan.kind === "stamp") {
        // The hand-added row already is the card's record of this email — only the id goes on.
        out.push({ ...base, leadId: plan.leadId, status: await stampRow(sb, plan.leadId, rowMessageId) })
        continue
      }
      const row = buildLeadRow(msg, profile, { address: match.address, rowMessageId })
      const { data, error } = await sb.from("leads").insert(row).select("id").single()
      if (error && isUniqueViolation(error)) {
        out.push({ ...base, leadId: null, status: "duplicate" })
        continue
      }
      if (error) throw new Error(`insert failed: ${error.message}`)
      const rowId = (data as { id: string }).id
      out.push({ ...base, leadId: rowId, status: "logged" })
      const body = leadEmailBody(msg)
      if (msg.direction === "sent") {
        if (!opts.quiet) opts.queueAfter(() => afterSent(sb, rowId, row, profile))
      } else {
        // DNC before the alert, so the alert can say so.
        const flags = await afterInbound(sb, rowId, row, body).catch((e) => {
          console.warn(`[lead-email-sync] DNC carry failed for ${rowId}:`, e instanceof Error ? e.message : String(e))
          return { dnc: profile.dnc, optOut: false }
        })
        opts.queueAfter(async () => {
          const { runAutoStatusForLead } = await import("@/lib/leadStatus")
          await runAutoStatusForLead(rowId).catch((e) => console.warn(`[lead-email-sync] auto-status failed for ${rowId}:`, e instanceof Error ? e.message : String(e)))
        })
        if (!opts.quiet) opts.queueAlert({ leadId: rowId, profile: { ...profile, dnc: profile.dnc || flags.dnc }, msg, body, optOut: flags.optOut })
      }
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      console.error(`[lead-email-sync] ${msg.gmailId} → ${match.key}: ${why}`)
      out.push({ ...base, leadId: null, status: "skipped", reason: `failed: ${why}` })
      done = false
    }
  }
  return { gmailId: msg.gmailId, leads: [...out, ...skipped], alerted: false, done }
}

async function sendAlert(job: AlertJob): Promise<boolean> {
  try {
    const { sendTelegramAlert } = await import("@/lib/leads")
    const ok = await sendTelegramAlert(leadEmailAlertText(job.profile, job.msg, job.body, { dnc: job.profile.dnc, optOut: job.optOut }), {
      about: leadEmailAlertAbout(job.leadId, job.msg.from || null, job.profile.phone),
    })
    if (!ok) console.error(`[lead-email-sync] alert for ${job.msg.gmailId} did not send`)
    return ok
  } catch (e) {
    console.error(`[lead-email-sync] alert for ${job.msg.gmailId} threw:`, e instanceof Error ? e.message : String(e))
    return false
  }
}

/**
 * One POST from the mini. Each message on its own — one failing doesn't stop
 * the others. Alerts go out after every row is written (awaited — the mini
 * needs `alerted`); the follow-on bookkeeping (drip clock, offer, auto status)
 * runs after them, awaited, and can't change the answer.
 * Throws only when the lead rows themselves can't load.
 */
export async function syncLeadEmails(sb: SupabaseClient, raw: readonly unknown[], opts: { quiet?: boolean } = {}): Promise<LeadSyncResult[]> {
  const index = buildLeadIndex(await loadLeadRows(sb))
  const quiet = opts.quiet === true
  const alerts: AlertJob[] = []
  const after: AfterJob[] = []
  const results: LeadSyncResult[] = []
  for (const entry of raw) {
    const parsed = parseSyncMessage(entry)
    if (!parsed.ok) {
      console.warn(`[lead-email-sync] bad message ${parsed.gmailId ?? "(no id)"}: ${parsed.why}`)
      if (parsed.gmailId) results.push({ gmailId: parsed.gmailId, leads: [], alerted: false, done: false })
      continue
    }
    try {
      results.push(await syncOne(sb, parsed.msg, index, { quiet, queueAlert: (j) => alerts.push(j), queueAfter: (j) => after.push(j) }))
    } catch (e) {
      console.error(`[lead-email-sync] ${parsed.msg.gmailId} threw:`, e instanceof Error ? e.message : String(e))
      results.push({ gmailId: parsed.msg.gmailId, leads: [], alerted: false, done: false })
    }
  }
  const sent = await Promise.all(alerts.map(async (job) => ({ gmailId: job.msg.gmailId, ok: await sendAlert(job) })))
  for (const s of sent) {
    const r = results.find((x) => x.gmailId === s.gmailId)
    if (r && s.ok) r.alerted = true
  }
  // Awaited, one at a time, after the answer is decided: work handed to
  // waitUntil has been dropped silently in production before (see
  // app/api/leads/email/route.ts), and these are few and quick.
  for (const job of after) {
    try {
      await job()
    } catch (e) {
      console.warn("[lead-email-sync] follow-on step failed:", e instanceof Error ? e.message : String(e))
    }
  }
  return results
}
