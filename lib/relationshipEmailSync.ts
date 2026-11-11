// Email with Relationships contacts lands on their card, quietly (2026-11-11,
// briefs/BRIEF_RELATIONSHIP_EMAIL_SYNC_2026-11-11.md).
//
// A card only learned about email from its own Send button — what Ryan sent
// or received in Gmail on ryan@ never reached it, so the card's "last
// contacted" and history were blind to most of his email with agents and
// lenders. The Mac-mini inbox agent (scripts/inbox-agent/cards.mjs) now finds
// candidate messages on ryan@ and POSTs them to /api/crms/email-sync; this
// module matches them to cards, dedupes, logs the touch and writes notes.
//
// Rules Ryan set:
//   - never add people: an address that isn't on a card is ignored;
//   - a send to more than BLAST_RECIPIENTS outside people is a blast, skipped;
//   - inbound → the card's notes may learn a fact (lib/inboundFacts), except
//     do-not-contact and Personal cards, which are recorded as history only;
//   - sent → last_contacted_at moves forward, never back;
//   - bounce → a "bounced" touch + one dated note line, no ping.
// Silent: nothing here alerts. The mini alerts when the POST keeps failing.
//
// Idempotency: a touch carries its Gmail message id, unique per card
// (supabase/migrations/2026-11-11_relationship_email_sync.sql). A hand-logged
// email touch (no Gmail id) close in time or with the same subject that day
// gets the ids written onto it instead of a second row.

import type { SupabaseClient } from "@supabase/supabase-js"
import { stripQuoted } from "@/lib/campaignInbox"
import { isUniqueViolation } from "@/lib/emailDedupe"
import { landInboundNote, notesAllowed } from "@/lib/inboundFacts"
import { pacificDate } from "@/lib/pacificDate"
import { emailTouchMessage, isOwnMailbox, splitEmailTouch } from "@/lib/relationshipEmail"
import { appendNoteBlock, noteStampDay } from "@/lib/relationshipNotes"

export const MAX_SYNC_MESSAGES = 10
// More outside recipients than this on one send = a blast, not a conversation.
export const BLAST_RECIPIENTS = 5
// A hand-logged touch this close to the email's time is the same email.
export const STAMP_WINDOW_MS = 10 * 60_000
// Only touches from before go-live can be a hand-logged copy of a ryan@
// email (the Mega Meetup follow-ups of 2026-11-10/11). After it, every ryan@
// email touch is written with its Gmail id — an id-less email touch is then a
// campaign-mailbox reply, a different email that must not swallow this one.
export const STAMP_LEGACY_BEFORE = "2026-11-12T08:00:00Z" // end of Nov 11, Pacific

export type SyncDirection = "inbound" | "sent" | "bounce"
export type TouchAction = "inbound" | "sent" | "bounced"

export interface SyncMessage {
  gmailId: string
  threadId: string | null
  direction: SyncDirection
  /** The email's own time, ISO. */
  at: string
  from: string
  to: string[]
  subject: string
  text: string
  failedRecipient: string | null
}

export type CardStatus = "logged" | "stamped" | "duplicate" | "skipped"

export interface CardResult {
  relationshipId: string
  name: string | null
  status: CardStatus
  reason?: string
  note: string | null
}

export interface SyncResult {
  gmailId: string
  cards: CardResult[]
  /** false = the mini should send this message again next pass. */
  done: boolean
}

export interface SyncCard {
  id: string
  name: string | null
  email: string | null
  status: string | null
  tier: string | null
  category: string | null
  last_contacted_at: string | null
}

const CARD_COLS = "id, name, email, status, tier, category, last_contacted_at"

// ── Pure helpers ─────────────────────────────────────────────────────────

/** "Ashley Cao <ACao@x.com>" / " acao@x.com " → "acao@x.com"; "" when it isn't an address. */
export function normalEmail(raw: unknown): string {
  if (typeof raw !== "string") return ""
  const angled = /<([^>]+)>/.exec(raw)
  const e = (angled ? angled[1] : raw).trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+$/.test(e) ? e : ""
}

export type ParsedSyncMessage = { ok: true; msg: SyncMessage } | { ok: false; gmailId: string | null; why: string }

/** One entry of the POST body, checked. A missing gmailId can't be answered at all. */
export function parseSyncMessage(raw: unknown): ParsedSyncMessage {
  if (!raw || typeof raw !== "object") return { ok: false, gmailId: null, why: "not an object" }
  const r = raw as Record<string, unknown>
  const gmailId = typeof r.gmailId === "string" && r.gmailId.trim() ? r.gmailId.trim() : null
  if (!gmailId) return { ok: false, gmailId: null, why: "gmailId required" }
  const direction = r.direction
  if (direction !== "inbound" && direction !== "sent" && direction !== "bounce") return { ok: false, gmailId, why: `bad direction ${String(direction)}` }
  const atMs = typeof r.at === "string" ? Date.parse(r.at) : NaN
  if (!Number.isFinite(atMs)) return { ok: false, gmailId, why: "bad at" }
  const to = Array.isArray(r.to) ? r.to.map(normalEmail).filter(Boolean) : []
  return {
    ok: true,
    msg: {
      gmailId,
      threadId: typeof r.threadId === "string" && r.threadId.trim() ? r.threadId.trim() : null,
      direction,
      at: new Date(atMs).toISOString(),
      from: normalEmail(r.from),
      to: Array.from(new Set(to)),
      subject: typeof r.subject === "string" ? r.subject.trim() : "",
      text: typeof r.text === "string" ? r.text : "",
      failedRecipient: normalEmail(r.failedRecipient) || null,
    },
  }
}

/** Every card's email, lower-cased → the cards that carry it. A field holding two addresses indexes both. */
export function indexCardsByEmail(rows: readonly SyncCard[]): Map<string, SyncCard[]> {
  const out = new Map<string, SyncCard[]>()
  for (const row of rows) {
    for (const part of String(row.email ?? "").split(/[,;\s]+/)) {
      const e = normalEmail(part)
      if (!e) continue
      const list = out.get(e) ?? []
      if (!list.some((c) => c.id === row.id)) list.push(row)
      out.set(e, list)
    }
  }
  return out
}

/**
 * The cards a message belongs to. Inbound → the sender's card; bounce → the
 * card of the address that bounced; sent → every To/Cc address's card, unless
 * it went to more than BLAST_RECIPIENTS outside people (`blast` = how many;
 * the matched cards are returned so the response can say they were skipped).
 */
export function cardsForMessage(msg: SyncMessage, byEmail: ReadonlyMap<string, readonly SyncCard[]>): { cards: SyncCard[]; blast: number | null } {
  const found = new Map<string, SyncCard>()
  const add = (email: string | null) => {
    if (!email) return
    for (const c of byEmail.get(email) ?? []) found.set(c.id, c)
  }
  let blast: number | null = null
  if (msg.direction === "inbound") add(msg.from)
  else if (msg.direction === "bounce") add(msg.failedRecipient)
  else {
    const outside = msg.to.filter((e) => !isOwnMailbox(e))
    for (const e of outside) add(e)
    if (outside.length > BLAST_RECIPIENTS) blast = outside.length
  }
  return { cards: Array.from(found.values()), blast }
}

export function touchAction(direction: SyncDirection): TouchAction {
  return direction === "bounce" ? "bounced" : direction
}

/** Subject for matching: Re:/Fwd: chain dropped, spaces collapsed, case-folded. */
export function normalizeSubject(subject: string | null | undefined): string {
  return (subject ?? "").replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, "").replace(/\s+/g, " ").trim().toLowerCase()
}

export interface TouchLite {
  id: string
  occurred_at: string | null
  action: string | null
  message: string | null
  gmail_message_id: string | null
}

export type TouchPlan = { kind: "duplicate"; touchId: string } | { kind: "stamp"; touchId: string } | { kind: "insert" }

/**
 * Already logged? A touch with this Gmail id = duplicate. Otherwise an email
 * touch from before go-live (STAMP_LEGACY_BEFORE) with no Gmail id, the same
 * action, and either within STAMP_WINDOW_MS of the email or the same subject
 * on the same Pacific day = the same email logged by hand → stamp the ids
 * onto it (the closest in time wins).
 */
export function planTouchWrite(msg: SyncMessage, touches: readonly TouchLite[]): TouchPlan {
  const dup = touches.find((t) => t.gmail_message_id === msg.gmailId)
  if (dup) return { kind: "duplicate", touchId: dup.id }
  const action = touchAction(msg.direction)
  const at = Date.parse(msg.at)
  const day = pacificDate(new Date(at))
  const subject = normalizeSubject(msg.subject)
  const legacyBefore = Date.parse(STAMP_LEGACY_BEFORE)
  let best: { id: string; gap: number } | null = null
  for (const t of touches) {
    if (t.gmail_message_id || t.action !== action) continue
    const when = Date.parse(t.occurred_at ?? "")
    if (!Number.isFinite(when) || when >= legacyBefore) continue
    const gap = Math.abs(when - at)
    const near = gap <= STAMP_WINDOW_MS
    const sameSubjectSameDay = !!subject && normalizeSubject(splitEmailTouch(t.message ?? "").subject) === subject && pacificDate(new Date(when)) === day
    if ((near || sameSubjectSameDay) && (!best || gap < best.gap)) best = { id: t.id, gap }
  }
  return best ? { kind: "stamp", touchId: best.id } : { kind: "insert" }
}

/** True when `at` is later than the card's last contact (or it has none) — never move it back. */
export function advancesContact(lastContactedAt: string | null, at: string): boolean {
  const next = Date.parse(at)
  if (!Number.isFinite(next)) return false
  const prev = Date.parse(lastContactedAt ?? "")
  return !Number.isFinite(prev) || next > prev
}

/** `[Nov 11, 2026 email] Email to a@b.com bounced — the address on this card may be wrong.` */
export function bounceNoteLine(day: string, address: string): string {
  return `[${day} email] Email to ${address} bounced — the address on this card may be wrong.`
}

/** What the touch says below the subject: only the new text of a reply (quoted history cut). */
export function touchBody(msg: SyncMessage): string {
  if (msg.direction === "bounce") return `Email to ${msg.failedRecipient ?? "this address"} bounced — the address on this card may be wrong.`
  // A bare forward has no new text — keep what was forwarded rather than nothing.
  return stripQuoted(msg.text) || msg.text.trim()
}

// ── IO ───────────────────────────────────────────────────────────────────

/** Every card with an email, paged — the table is over PostgREST's 1,000-row cap. */
export async function loadCardsByEmail(sb: SupabaseClient): Promise<Map<string, SyncCard[]>> {
  const PAGE = 1000
  const rows: SyncCard[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("relationships")
      .select(CARD_COLS)
      .not("email", "is", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`card lookup failed: ${error.message}`)
    const page = (data ?? []) as unknown as SyncCard[]
    rows.push(...page)
    if (page.length < PAGE) break
  }
  return indexCardsByEmail(rows)
}

type NoteJob = () => Promise<void>

async function advanceLastContacted(sb: SupabaseClient, card: SyncCard, at: string): Promise<void> {
  if (!advancesContact(card.last_contacted_at, at)) return
  // Conditional, so a newer contact written meanwhile is never overwritten.
  const q = sb.from("relationships").update({ last_contacted_at: at }).eq("id", card.id)
  const { error } = card.last_contacted_at ? await q.lt("last_contacted_at", at) : await q.is("last_contacted_at", null)
  if (error) throw new Error(`last_contacted_at update failed: ${error.message}`)
  card.last_contacted_at = at
}

async function appendBounceNote(sb: SupabaseClient, card: SyncCard, msg: SyncMessage): Promise<string> {
  const line = bounceNoteLine(noteStampDay(new Date(msg.at)), msg.failedRecipient ?? card.email ?? "this address")
  const { data: fresh, error: readErr } = await sb.from("relationships").select("notes").eq("id", card.id).maybeSingle<{ notes: string | null }>()
  if (readErr) throw new Error(`notes read failed: ${readErr.message}`)
  const { error } = await sb.from("relationships").update({ notes: appendNoteBlock(fresh?.notes, line) }).eq("id", card.id)
  if (error) throw new Error(`bounce note failed: ${error.message}`)
  return line
}

async function syncCard(sb: SupabaseClient, msg: SyncMessage, card: SyncCard, queueNote: (cardId: string, job: NoteJob) => void): Promise<CardResult> {
  const base = { relationshipId: card.id, name: card.name }
  const action = touchAction(msg.direction)
  const at = Date.parse(msg.at)
  // Wide enough for "same Pacific day" either side of the email.
  const from = new Date(at - 25 * 3600_000).toISOString()
  const to = new Date(at + 25 * 3600_000).toISOString()
  const cols = "id, occurred_at, action, message, gmail_message_id"
  const [dup, near] = await Promise.all([
    sb.from("relationship_touches").select(cols).eq("relationship_id", card.id).eq("gmail_message_id", msg.gmailId).limit(1),
    sb
      .from("relationship_touches")
      .select(cols)
      .eq("relationship_id", card.id)
      .eq("modality", "email")
      .eq("action", action)
      .is("gmail_message_id", null)
      .gte("occurred_at", from)
      .lte("occurred_at", to)
      .order("occurred_at", { ascending: false })
      .limit(50),
  ])
  if (dup.error) throw new Error(`touch lookup failed: ${dup.error.message}`)
  if (near.error) throw new Error(`touch lookup failed: ${near.error.message}`)
  const plan = planTouchWrite(msg, [...((dup.data ?? []) as TouchLite[]), ...((near.data ?? []) as TouchLite[])])
  if (plan.kind === "duplicate") return { ...base, status: "duplicate", note: null }

  const ids = { gmail_message_id: msg.gmailId, gmail_thread_id: msg.threadId }
  if (plan.kind === "stamp") {
    // The hand-logged row already did its own bookkeeping (and its note) —
    // only the ids go on, plus the never-backwards contact clock for a send.
    const { data, error } = await sb.from("relationship_touches").update(ids).eq("id", plan.touchId).is("gmail_message_id", null).select("id")
    if (error && isUniqueViolation(error)) return { ...base, status: "duplicate", note: null }
    if (error) throw new Error(`touch stamp failed: ${error.message}`)
    // Stamped by another message in the meantime — re-plan on the next pass.
    if (!data?.length) throw new Error("touch was stamped meanwhile")
    if (action === "sent") await advanceLastContacted(sb, card, msg.at)
    return { ...base, status: "stamped", note: null }
  }

  const body = touchBody(msg)
  const { error } = await sb.from("relationship_touches").insert({
    relationship_id: card.id,
    modality: "email",
    action,
    message: emailTouchMessage(msg.subject, body),
    occurred_at: msg.at,
    tier_at_touch: card.tier,
    category_at_touch: card.category,
    ...ids,
  })
  if (error && isUniqueViolation(error)) return { ...base, status: "duplicate", note: null }
  if (error) throw new Error(`touch insert failed: ${error.message}`)

  const result: CardResult = { ...base, status: "logged", note: null }
  if (action === "sent") await advanceLastContacted(sb, card, msg.at)
  else if (action === "bounced") {
    // A do-not-contact card is history only. (A Personal card still gets the
    // line: it's about the address, not what anyone wrote.)
    if (card.status !== "do_not_contact") result.note = await appendBounceNote(sb, card, msg)
  } else if (notesAllowed(card)) {
    queueNote(card.id, async () => {
      result.note = await landInboundNote(card.id, "email", body, msg.subject)
    })
  }
  return result
}

async function syncMessage(sb: SupabaseClient, msg: SyncMessage, byEmail: ReadonlyMap<string, readonly SyncCard[]>, queueNote: (cardId: string, job: NoteJob) => void): Promise<SyncResult> {
  const { cards, blast } = cardsForMessage(msg, byEmail)
  if (blast !== null) {
    return { gmailId: msg.gmailId, cards: cards.map((c) => ({ relationshipId: c.id, name: c.name, status: "skipped", reason: `sent to ${blast} people — a blast`, note: null })), done: true }
  }
  const out: CardResult[] = []
  let done = true
  for (const card of cards) {
    try {
      out.push(await syncCard(sb, msg, card, queueNote))
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      console.error(`[email-sync] ${msg.gmailId} → ${card.name ?? card.id}: ${why}`)
      out.push({ relationshipId: card.id, name: card.name, status: "skipped", reason: `failed: ${why}`, note: null })
      done = false
    }
  }
  return { gmailId: msg.gmailId, cards: out, done }
}

/**
 * One POST from the mini. Each message is handled on its own — one failing
 * doesn't stop the others. Inbound notes run after every touch is written,
 * one card at a time per card (so two emails can't race on its notes field),
 * cards in parallel. Throws only when the card list itself can't load.
 */
export async function syncRelationshipEmails(sb: SupabaseClient, raw: readonly unknown[]): Promise<SyncResult[]> {
  const byEmail = await loadCardsByEmail(sb)
  const jobs = new Map<string, NoteJob[]>()
  const queueNote = (cardId: string, job: NoteJob) => jobs.set(cardId, [...(jobs.get(cardId) ?? []), job])

  const results: SyncResult[] = []
  for (const entry of raw) {
    const parsed = parseSyncMessage(entry)
    if (!parsed.ok) {
      console.warn(`[email-sync] bad message ${parsed.gmailId ?? "(no id)"}: ${parsed.why}`)
      if (parsed.gmailId) results.push({ gmailId: parsed.gmailId, cards: [], done: false })
      continue
    }
    try {
      results.push(await syncMessage(sb, parsed.msg, byEmail, queueNote))
    } catch (e) {
      console.error(`[email-sync] ${parsed.msg.gmailId} threw:`, e instanceof Error ? e.message : String(e))
      results.push({ gmailId: parsed.msg.gmailId, cards: [], done: false })
    }
  }

  // landInboundNote never throws; a missed note costs nothing but the note.
  await Promise.all(Array.from(jobs.values()).map(async (list) => {
    for (const job of list) await job()
  }))
  return results
}
