// "Recent history" for Follow Ups cards (Ryan 2026-10-26): what has actually
// been said with this person — calls, voicemails, texts, emails — one line
// each, newest first, in place of the skip-trace dump. Texts show as written;
// a long call/voicemail shows a one-line AI summary (`leads.history_line`,
// written once by /api/follow-ups/history-lines) and the full transcript is
// one tap away.
//
// Every event is a row in `leads` (see the conventions block on `Lead` in
// lib/leads.ts): `twilio_number` null = outbound, `message` = the SMS body /
// transcript / email text, drip-engine sends are lead_type `drip_*`.
// A contact = the rows sharing clusterKeyOrId, the same grouping the lead
// card and the worklist use.

import type { SupabaseClient } from "@supabase/supabase-js"
import { clusterKeyOrId } from "@/lib/leads"
import { completeText, hasLlmKey, SONNET } from "@/lib/llm"

export type HistoryKind = "call" | "voicemail" | "text" | "email" | "form"

export interface HistoryItem {
  id: string
  at: string
  kind: HistoryKind
  dir: "in" | "out"
  // Sent by the drip engine, not typed by Ryan.
  auto: boolean
  // The one line shown on the card.
  line: string
  // There is more than `line` to read (tap ▸).
  more: boolean
  // A long call/voicemail with no saved one-liner yet — the card asks
  // /api/follow-ups/history-lines to write it.
  needsLine: boolean
  // Full text — only filled by fetchFullHistory (the on-tap fetch).
  full?: string
}

export interface ContactHistory {
  items: HistoryItem[]
  total: number
}

// Cards show this many; "Show all" fetches the rest.
export const HISTORY_PREVIEW = 5
// Transcripts longer than this get a one-line summary; shorter ones (most
// voicemails) are shown as-is.
export const LONG_TRANSCRIPT = 200
const TEXT_CLIP = 240
const LINE_CLIP = 160
// lead_history_v cuts message / ai_notes to this many chars.
const HEAD = 400

// The lead_history_v row shape. fetchFullHistory maps full `leads` rows into
// it so both paths share toHistoryItem.
export interface HistoryRow {
  id: string
  created_at: string
  lead_type: string | null
  twilio_number: string | null
  caller_phone: string | null
  email: string | null
  gmail_thread_id: string | null
  message_head: string | null
  message_len: number
  ai_notes_head: string | null
  history_line: string | null
  has_recording: boolean
}

const VIEW_COLS =
  "id, created_at, lead_type, twilio_number, caller_phone, email, gmail_thread_id, " +
  "message_head, message_len, ai_notes_head, history_line, has_recording"

const squash = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim()

function clip(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n).replace(/\s+\S*$/, "") + "…"
}

function firstSentence(s: string): string {
  const m = s.match(/^.+?[.!?](?=\s|$)/)
  return (m ? m[0] : s).trim()
}

/** One worklist line for a lead event row; null for rows with nothing to show. */
export function toHistoryItem(r: HistoryRow): HistoryItem | null {
  const dir: "in" | "out" = r.twilio_number ? "in" : "out"
  const msg = squash(r.message_head)
  // The view cut the text — there's more than the head holds.
  const cut = r.message_len > (r.message_head?.length ?? 0)
  const base = { id: r.id, at: r.created_at, dir, auto: false, needsLine: false }

  switch (r.lead_type) {
    case "sms":
    case "drip_imessage": {
      if (!msg) return null
      const line = clip(msg, TEXT_CLIP)
      return { ...base, kind: "text", auto: r.lead_type === "drip_imessage", line, more: cut || line !== msg }
    }
    case "email":
    case "drip_email": {
      const triage = squash(r.ai_notes_head)
      // Inbound email: the triage summary reads better than the raw body
      // (quoted replies, signatures).
      if (dir === "in" && triage) {
        return { ...base, kind: "email", line: clip(firstSentence(triage), LINE_CLIP), more: !!msg }
      }
      if (!msg) return null
      const line = clip(msg, LINE_CLIP)
      return { ...base, kind: "email", auto: r.lead_type === "drip_email", line, more: cut || line !== msg }
    }
    case "call":
    case "voicemail": {
      const kind: HistoryKind = r.lead_type === "voicemail" && dir === "in" ? "voicemail" : "call"
      if (!msg) {
        const line =
          kind === "voicemail" ? "Voicemail — no transcript"
          : dir === "in" ? "Missed call — no message"
          : r.has_recording ? "Recorded — transcript not ready"
          : "No answer / not recorded"
        return { ...base, kind, line, more: false }
      }
      const saved = squash(r.history_line)
      if (saved) return { ...base, kind, line: saved, more: true }
      if (r.message_len <= LONG_TRANSCRIPT) return { ...base, kind, line: `“${msg}”`, more: false }
      // Long transcript, no one-liner yet: a stand-in until it's written.
      const notes = squash(r.ai_notes_head)
      const line = dir === "out" && notes ? clip(firstSentence(notes), LINE_CLIP) : `“${clip(msg, LINE_CLIP)}”`
      return { ...base, kind, line, more: true, needsLine: true }
    }
    case "form": {
      const line = clip(msg || "Submitted the web form", LINE_CLIP)
      return { ...base, kind: "form", line, more: cut || (!!msg && line !== msg) }
    }
    default:
      return null
  }
}

function newestFirst(a: { created_at: string }, b: { created_at: string }): number {
  return b.created_at.localeCompare(a.created_at)
}

// Page through a filtered query — PostgREST caps every response at 1000 rows.
async function pageAll<T>(
  run: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
  tag: string
): Promise<T[]> {
  const out: T[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await run(from, from + PAGE - 1)
    if (error) {
      console.error(`${tag} query failed:`, error.message)
      break
    }
    out.push(...((data ?? []) as T[]))
    if (!data || data.length < PAGE) break
  }
  return out
}

/** Preview histories (last HISTORY_PREVIEW items + total) for a set of
 *  worklist contacts, keyed by clusterKeyOrId. Reads lead_history_v so
 *  full transcripts stay out of the 30-second worklist refetch. */
export async function fetchHistoryPreviews(
  sb: SupabaseClient,
  clusterKeys: Iterable<string>
): Promise<Map<string, ContactHistory>> {
  const wanted = new Set(clusterKeys)
  const byCol: Record<string, string[]> = { caller_phone: [], gmail_thread_id: [], email: [], id: [] }
  const COL: Record<string, string> = { phone: "caller_phone", thread: "gmail_thread_id", email: "email", id: "id" }
  wanted.forEach((k) => {
    const i = k.indexOf(":")
    const col = COL[k.slice(0, i)]
    if (col) byCol[col].push(k.slice(i + 1))
  })

  const rows = new Map<string, HistoryRow>()
  const CHUNK = 100
  const jobs: Promise<void>[] = []
  for (const [col, vals] of Object.entries(byCol)) {
    for (let i = 0; i < vals.length; i += CHUNK) {
      const chunk = vals.slice(i, i + CHUNK)
      jobs.push(
        pageAll<HistoryRow>(
          (from, to) => sb.from("lead_history_v").select(VIEW_COLS).in(col, chunk).order("id").range(from, to),
          "[history]"
        ).then((got) => { for (const r of got) rows.set(r.id, r) })
      )
    }
  }
  await Promise.all(jobs)

  const grouped = new Map<string, HistoryRow[]>()
  rows.forEach((r) => {
    const key = clusterKeyOrId(r)
    if (!wanted.has(key)) return
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(r)
  })

  const out = new Map<string, ContactHistory>()
  grouped.forEach((list, key) => {
    const items = list.sort(newestFirst).map(toHistoryItem).filter((x): x is HistoryItem => !!x)
    out.set(key, { items: items.slice(0, HISTORY_PREVIEW), total: items.length })
  })
  return out
}

interface FullRow {
  id: string
  created_at: string
  lead_type: string | null
  twilio_number: string | null
  caller_phone: string | null
  email: string | null
  gmail_thread_id: string | null
  message: string | null
  ai_notes: string | null
  history_line: string | null
  recording_url: string | null
}

/** Every event for one contact (by clusterKeyOrId), newest first, with the
 *  full text attached — the card's on-tap fetch. */
export async function fetchFullHistory(sb: SupabaseClient, key: string): Promise<HistoryItem[]> {
  const i = key.indexOf(":")
  const prefix = key.slice(0, i)
  const val = key.slice(i + 1)
  if (!val) return []
  const cols =
    "id, created_at, lead_type, twilio_number, caller_phone, email, gmail_thread_id, message, ai_notes, history_line, recording_url"
  const base = () => sb.from("leads").select(cols)
  const query =
    prefix === "phone" ? (f: number, t: number) => base().eq("caller_phone", val).order("id").range(f, t)
    : prefix === "thread" ? (f: number, t: number) => base().eq("gmail_thread_id", val).order("id").range(f, t)
    : prefix === "email" ? (f: number, t: number) => base().ilike("email", val.replace(/[%_\\]/g, "\\$&")).order("id").range(f, t)
    : prefix === "id" ? (f: number, t: number) => base().eq("id", val).order("id").range(f, t)
    : null
  if (!query) return []

  const rows = (await pageAll<FullRow>(query, "[history:full]")).filter((r) => clusterKeyOrId(r) === key)
  return rows
    .sort(newestFirst)
    .map((r) => {
      const item = toHistoryItem({
        id: r.id,
        created_at: r.created_at,
        lead_type: r.lead_type,
        twilio_number: r.twilio_number,
        caller_phone: r.caller_phone,
        email: r.email,
        gmail_thread_id: r.gmail_thread_id,
        message_head: r.message ? r.message.slice(0, HEAD) : null,
        message_len: r.message?.length ?? 0,
        ai_notes_head: r.ai_notes ? r.ai_notes.slice(0, HEAD) : null,
        history_line: r.history_line,
        has_recording: !!r.recording_url,
      })
      if (item && item.more) item.full = (r.message || "").trim()
      return item
    })
    .filter((x): x is HistoryItem => !!x)
}

/** One-line summary of a long call/voicemail transcript for the card. */
export async function summarizeHistoryLine(args: {
  kind: "call" | "voicemail"
  dir: "in" | "out"
  transcript: string
}): Promise<string | null> {
  if (!hasLlmKey()) return null
  const who =
    args.dir === "out" ? "Ryan called the seller."
    : args.kind === "voicemail" ? "The seller called Ryan and left a voicemail."
    : "The seller called Ryan."
  const prompt = `Ryan is a real estate investor. Below is the transcript of one phone ${args.kind === "voicemail" ? "voicemail" : "call"} with a property owner. ${who}

Write ONE line, at most 18 words, that tells Ryan what happened on this call when he glances at it before his next touch. Lead with the outcome or the fact that matters most: interest in selling or not, a price, a timeline, a property detail, or the agreed next step. If nobody picked up, or it was only a greeting or a voicemail Ryan left, say so plainly. Refer to the seller by first name if the transcript gives it, otherwise "seller". Plain text only: no quotes, no label, no markdown.

TRANSCRIPT:
"""
${args.transcript.slice(0, 12000)}
"""`
  try {
    const out = await completeText({ model: SONNET, prompt, maxTokens: 200, thinking: false, tag: "[history-line]" })
    const line = out.text.replace(/^["'`“]+|["'`”]+$/g, "").replace(/\s+/g, " ").trim()
    return line || null
  } catch (e) {
    console.error("[history-line] threw:", e instanceof Error ? e.message : String(e))
    return null
  }
}
