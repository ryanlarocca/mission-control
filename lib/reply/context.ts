// Reply Planner — assemble everything the planner and drafter need to know
// about a contact. One builder per side (leads / relationships). The thread
// merges Supabase rows with the live sidecar tail (chat.db + Gmail) exactly
// as /api/leads/[id]/draft-message does, so the draft reflects what was
// actually said, right now.

import { getLeadsClient, getMailboxForSource } from "@/lib/leads"
import { sidecarHeaders } from "../sidecar"
import { fetchThread } from "@/lib/relationship-messages"

export interface ThreadItem {
  at: string          // ISO
  // "call" = a recorded live conversation, both voices in one transcript
  // (coached-draft brief, 2026-10-15). Before that an outbound call row was
  // tagged "ryan" because it has no twilio_number, so the seller's half of
  // the call read as Ryan speaking. Voicemails stay "them".
  from: "them" | "ryan" | "ryan(drip)" | "call"
  channel: string | null
  text: string
  // Calls only: who placed it. Outbound = Ryan dialled from the card.
  direction?: "inbound" | "outbound"
}

export interface LeadContext {
  kind: "lead"
  leadId: string
  clusterIds: string[]
  name: string | null
  email: string | null
  phone: string | null
  property_address: string | null
  property_details: unknown
  status: string | null
  temperature: string | null
  moment: string | null
  source: string | null
  campaign_label: string | null
  ai_summary: string | null
  notes: string | null
  // The card's own money facts (coached-draft brief, 2026-10-15): the offer
  // Ryan last verbalized, so a drafter sees "Offer 1.1" before it writes a
  // new number.
  offer_amount: number | null
  offer_verbalized_at: string | null
  drip_campaign_type: string | null
  recommended_followup_date: string | null
  followup_reason: string | null
  gmail_thread_id: string | null
  inboundChannel: "email" | "sms" | "call" | null
  thread: ThreadItem[]
  lastInbound: ThreadItem | null
}

export interface RelationshipContext {
  kind: "relationship"
  relationshipId: string
  name: string | null
  phone: string | null
  email: string | null
  category: string | null
  tier: string | null
  notes: string | null
  last_contacted_at: string | null
  everContacted: boolean
  thread: ThreadItem[]
  lastInbound: ThreadItem | null
}

export type ReplyContext = LeadContext | RelationshipContext

const APPLE_EPOCH_OFFSET_MS = 978307200000
const SIDECAR_TIMEOUT_MS = 12000
const MAX_THREAD = 24
// Texts and emails are clipped per item. Call transcripts are not: a
// 20-minute seller call runs 7-8k chars and the sentences that matter (the
// floor they named, the number Ryan promised to text) sit past 4,000. The
// whole thread has a character budget instead; past it the OLDEST items are
// dropped whole, never the middle of a transcript.
export const MAX_TEXT = 4000
export const MAX_CALL_TEXT = 20000
export const MAX_THREAD_CHARS = 60000

function sidecarUrl(): string | null {
  return process.env.SIDECAR_URL?.replace(/\/+$/, "") || null
}

async function fetchLiveLeadMessages(anchor: {
  caller_phone: string | null
  gmail_thread_id: string | null
  source: string | null
}): Promise<ThreadItem[]> {
  const base = sidecarUrl()
  if (!base) return []
  const out: ThreadItem[] = []
  if (anchor.caller_phone) {
    try {
      const res = await fetch(`${base}/sync-imessage`, {
        method: "POST",
        headers: sidecarHeaders(),
        body: JSON.stringify({ phone: anchor.caller_phone }),
        signal: AbortSignal.timeout(SIDECAR_TIMEOUT_MS),
      })
      if (res.ok) {
        const data = (await res.json()) as { messages?: { timestamp: number; is_from_me: boolean; text: string }[] }
        for (const m of data.messages || []) {
          const text = (m.text || "").trim()
          if (!text) continue
          out.push({
            at: new Date(Number(m.timestamp) + APPLE_EPOCH_OFFSET_MS).toISOString(),
            from: m.is_from_me ? "ryan" : "them",
            channel: "sms",
            text,
          })
        }
      }
    } catch { /* best-effort */ }
  }
  if (anchor.gmail_thread_id) {
    const mailbox = getMailboxForSource(anchor.source)
    if (mailbox) {
      try {
        const res = await fetch(`${base}/sync-email`, {
          method: "POST",
          headers: sidecarHeaders(),
          body: JSON.stringify({ threadId: anchor.gmail_thread_id, mailbox }),
          signal: AbortSignal.timeout(SIDECAR_TIMEOUT_MS + 4000),
        })
        if (res.ok) {
          const data = (await res.json()) as { messages?: { body: string; timestamp: number; is_from_ryan: boolean }[] }
          for (const m of data.messages || []) {
            const text = (m.body || "").trim()
            if (!text) continue
            out.push({ at: new Date(Number(m.timestamp)).toISOString(), from: m.is_from_ryan ? "ryan" : "them", channel: "email", text })
          }
        }
      } catch { /* best-effort */ }
    }
  }
  return out
}

/** Sort, dedupe, clip per item (calls get the generous cap), keep the newest
 *  MAX_THREAD, then drop whole items from the oldest end until the thread
 *  fits MAX_THREAD_CHARS. Exported for the context unit test. */
export function mergeThread(items: ThreadItem[]): ThreadItem[] {
  const seen = new Set<string>()
  const out: ThreadItem[] = []
  for (const it of [...items].sort((a, b) => a.at.localeCompare(b.at))) {
    const key = it.text.toLowerCase().replace(/\s+/g, " ").slice(0, 120)
    if (seen.has(key)) continue
    seen.add(key)
    const cap = it.from === "call" || it.channel === "call" ? MAX_CALL_TEXT : MAX_TEXT
    out.push({ ...it, text: it.text.slice(0, cap) })
  }
  let kept = out.slice(-MAX_THREAD)
  let total = kept.reduce((n, t) => n + t.text.length, 0)
  while (kept.length > 1 && total > MAX_THREAD_CHARS) {
    total -= kept[0].text.length
    kept = kept.slice(1)
  }
  return kept
}

/** Is this thread item the contact speaking (their text, their voicemail,
 *  or a call they phoned in)? The planner's "last inbound" and the
 *  relationship side's everContacted both use it. */
export function isFromThem(t: ThreadItem): boolean {
  return t.from === "them" || (t.from === "call" && t.direction === "inbound")
}

interface LeadRow {
  id: string
  created_at: string
  name: string | null
  email: string | null
  caller_phone: string | null
  gmail_thread_id: string | null
  source: string | null
  campaign_label: string | null
  property_address: string | null
  property_details: unknown
  status: string | null
  temperature: string | null
  moment: string | null
  ai_summary: string | null
  notes: string | null
  lead_type: string | null
  twilio_number: string | null
  message: string | null
  offer_amount: number | null
  offer_verbalized_at: string | null
  drip_campaign_type: string | null
  recommended_followup_date: string | null
  followup_reason: string | null
}
export type LeadThreadRow = Pick<LeadRow, "created_at" | "lead_type" | "twilio_number" | "message">

const LEAD_COLS =
  "id, created_at, name, email, caller_phone, gmail_thread_id, source, campaign_label, property_address, property_details, status, temperature, moment, ai_summary, notes, lead_type, twilio_number, message, offer_amount, offer_verbalized_at, drip_campaign_type, recommended_followup_date, followup_reason"

/** Supabase lead rows → thread items. Exported for the context unit test.
 *  A "call" row (lead_type call, drip or not) is a recorded live conversation
 *  with both voices in it, so it is tagged "call" with its direction rather
 *  than attributed to whoever placed it. A voicemail is the contact alone. */
export function leadRowsToThread(rows: LeadThreadRow[]): ThreadItem[] {
  return rows
    .filter((r) => (r.message || "").trim())
    .map((r) => {
      const channel = r.lead_type?.replace(/^drip_/, "") ?? null
      const text = (r.message || "").trim()
      if (channel === "call") {
        return { at: r.created_at, from: "call" as const, channel, text, direction: r.twilio_number ? "inbound" as const : "outbound" as const }
      }
      return {
        at: r.created_at,
        from: r.twilio_number ? "them" as const : r.lead_type?.startsWith("drip_") ? "ryan(drip)" as const : "ryan" as const,
        channel,
        text,
      }
    })
}

export async function buildLeadContext(leadId: string, opts: { live?: boolean } = {}): Promise<LeadContext | null> {
  const sb = getLeadsClient()
  const { data: anchor, error } = await sb.from("leads").select(LEAD_COLS).eq("id", leadId).maybeSingle<LeadRow>()
  if (error) throw new Error(error.message)
  if (!anchor) return null

  let q = sb.from("leads").select(LEAD_COLS).order("created_at", { ascending: true }).limit(60)
  if (anchor.caller_phone) q = q.eq("caller_phone", anchor.caller_phone)
  else if (anchor.email) q = q.eq("email", anchor.email)
  else q = q.eq("id", anchor.id)
  const { data: rowsRaw } = await q.returns<LeadRow[]>()
  const rows = rowsRaw || [anchor]

  // Prefer the cluster's most complete row for anchor fields.
  const pick = <K extends keyof LeadRow>(k: K): LeadRow[K] =>
    (anchor[k] ?? [...rows].reverse().find((r) => r[k] != null)?.[k] ?? null) as LeadRow[K]

  const supaItems = leadRowsToThread(rows)
  const live = opts.live === false ? [] : await fetchLiveLeadMessages({
    caller_phone: anchor.caller_phone,
    gmail_thread_id: pick("gmail_thread_id"),
    source: pick("source"),
  })
  const thread = mergeThread([...supaItems, ...live])
  const lastInbound = [...thread].reverse().find(isFromThem) ?? null
  const lastInboundRow = [...rows].reverse().find((r) => r.twilio_number)
  const inboundChannel = lastInboundRow?.lead_type === "email" ? "email"
    : lastInboundRow?.lead_type === "sms" ? "sms"
    : lastInboundRow?.lead_type ? "call" : null

  return {
    kind: "lead",
    leadId: anchor.id,
    clusterIds: rows.map((r) => r.id),
    name: pick("name"),
    email: pick("email"),
    phone: anchor.caller_phone,
    property_address: pick("property_address"),
    property_details: pick("property_details"),
    status: lastInboundRow?.status ?? anchor.status,
    temperature: pick("temperature"),
    moment: pick("moment"),
    source: pick("source"),
    campaign_label: pick("campaign_label"),
    ai_summary: pick("ai_summary"),
    notes: rows.map((r) => (r.notes || "").trim()).filter(Boolean).join("\n") || null,
    offer_amount: pick("offer_amount"),
    offer_verbalized_at: pick("offer_verbalized_at"),
    drip_campaign_type: pick("drip_campaign_type"),
    recommended_followup_date: pick("recommended_followup_date"),
    followup_reason: pick("followup_reason"),
    gmail_thread_id: pick("gmail_thread_id"),
    inboundChannel,
    thread,
    lastInbound,
  }
}

// Emails with a relationship live in relationship_touches (modality "email":
// "inbound" rows written by the agents-line/campaign reply path, "sent" rows
// by the card's Email button). Without them the drafter only saw chat.db and
// would answer an agent's listing email blind (2026-10-09).
async function fetchRelationshipEmails(sb: ReturnType<typeof getLeadsClient>, relationshipId: string): Promise<ThreadItem[]> {
  const { data } = await sb
    .from("relationship_touches")
    .select("occurred_at, action, message")
    .eq("relationship_id", relationshipId)
    .eq("modality", "email")
    .order("occurred_at", { ascending: false })
    .limit(12)
  return (data ?? [])
    .filter((t) => typeof t.message === "string" && t.message.trim())
    .map((t) => ({ at: String(t.occurred_at), from: t.action === "inbound" ? "them" : "ryan", channel: "email", text: String(t.message).trim() }))
}

export async function buildRelationshipContext(relationshipId: string): Promise<RelationshipContext | null> {
  const sb = getLeadsClient()
  const { data: r, error } = await sb
    .from("relationships")
    .select("id, name, phone, email, category, tier, notes, last_contacted_at")
    .eq("id", relationshipId)
    .maybeSingle<{ id: string; name: string | null; phone: string | null; email: string | null; category: string | null; tier: string | null; notes: string | null; last_contacted_at: string | null }>()
  if (error) throw new Error(error.message)
  if (!r) return null
  const [live, emails] = await Promise.all([
    r.phone ? fetchThread(r.phone) : Promise.resolve([]),
    fetchRelationshipEmails(sb, r.id),
  ])
  const thread = mergeThread([
    ...live.map((m): ThreadItem => ({ at: m.at, from: m.fromMe ? "ryan" : "them", channel: "imessage", text: m.text })),
    ...emails,
  ])
  return {
    kind: "relationship",
    relationshipId: r.id,
    name: r.name,
    phone: r.phone,
    email: r.email,
    category: r.category,
    tier: r.tier,
    notes: r.notes,
    last_contacted_at: r.last_contacted_at,
    everContacted: !!r.last_contacted_at || thread.some((t) => t.from === "ryan"),
    thread,
    lastInbound: [...thread].reverse().find(isFromThem) ?? null,
  }
}

/** Prompt label for a thread item's speaker. */
export function speakerLabel(t: ThreadItem): string {
  if (t.from === "call") {
    return t.direction === "inbound" ? "inbound call transcript" : "call transcript, both voices — Ryan placed this call"
  }
  return `${t.from}${t.channel ? ` (${t.channel})` : ""}`
}

/** Compact, labelled transcript for prompts. */
export function formatThread(ctx: ReplyContext, limit = 16): string {
  const items = ctx.thread.slice(-limit)
  if (!items.length) return "(no prior messages)"
  return items
    .map((t) => `[${t.at.slice(0, 10)}] ${speakerLabel(t)}: ${t.text}`)
    .join("\n")
}

function formatMoney(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`
}

export function describeContact(ctx: ReplyContext): string {
  if (ctx.kind === "lead") {
    const pd = ctx.property_details ? JSON.stringify(ctx.property_details).slice(0, 800) : null
    return [
      `Name: ${ctx.name || "(unknown)"}`,
      `Property: ${ctx.property_address || "(unknown)"}`,
      pd ? `Property details: ${pd}` : null,
      `Lead status: ${ctx.status || "(none)"} · temperature: ${ctx.temperature || "(none)"}`,
      `Source: ${ctx.campaign_label || ctx.source || "(unknown)"}`,
      ctx.offer_amount != null
        ? `Offer on file (Ryan's last verbalized number to them): ${formatMoney(ctx.offer_amount)}${ctx.offer_verbalized_at ? ` on ${ctx.offer_verbalized_at.slice(0, 10)}` : ""}`
        : null,
      ctx.drip_campaign_type ? `Current drip track: ${ctx.drip_campaign_type}` : null,
      ctx.recommended_followup_date ? `Follow-up on file: ${ctx.recommended_followup_date} (${ctx.followup_reason || "no reason"})` : null,
      ctx.ai_summary ? `Summary so far: ${ctx.ai_summary}` : null,
      ctx.notes ? `Ryan's notes on this card (his shorthand; history lines like "Offer 1.1" are prior offers):\n${ctx.notes}` : null,
    ].filter(Boolean).join("\n")
  }
  return [
    `Name: ${ctx.name || "(unknown)"}`,
    `Category: ${ctx.category || "(none)"} · tier: ${ctx.tier || "(none)"}`,
    ctx.email ? `Email: ${ctx.email}` : null,
    ctx.last_contacted_at ? `Last contacted: ${ctx.last_contacted_at.slice(0, 10)}` : "Never contacted through the CRMS",
  ].filter(Boolean).join("\n")
}
