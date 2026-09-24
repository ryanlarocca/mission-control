// Reply Planner — assemble everything the planner and drafter need to know
// about a contact. One builder per side (leads / relationships). The thread
// merges Supabase rows with the live sidecar tail (chat.db + Gmail) exactly
// as /api/leads/[id]/draft-message does, so the draft reflects what was
// actually said, right now.

import { getLeadsClient, getMailboxForSource } from "@/lib/leads"
import { fetchThread } from "@/lib/relationship-messages"

export interface ThreadItem {
  at: string          // ISO
  from: "them" | "ryan" | "ryan(drip)"
  channel: string | null
  text: string
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
  category: string | null
  tier: string | null
  notes: string | null
  last_contacted_at: string | null
  thread: ThreadItem[]
  lastInbound: ThreadItem | null
}

export type ReplyContext = LeadContext | RelationshipContext

const APPLE_EPOCH_OFFSET_MS = 978307200000
const SIDECAR_TIMEOUT_MS = 12000
const MAX_THREAD = 24
const MAX_TEXT = 4000

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
        headers: { "Content-Type": "application/json" },
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
          headers: { "Content-Type": "application/json" },
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

function mergeThread(items: ThreadItem[]): ThreadItem[] {
  const seen = new Set<string>()
  const out: ThreadItem[] = []
  for (const it of [...items].sort((a, b) => a.at.localeCompare(b.at))) {
    const key = it.text.toLowerCase().replace(/\s+/g, " ").slice(0, 120)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ...it, text: it.text.slice(0, MAX_TEXT) })
  }
  return out.slice(-MAX_THREAD)
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
  drip_campaign_type: string | null
  recommended_followup_date: string | null
  followup_reason: string | null
}

const LEAD_COLS =
  "id, created_at, name, email, caller_phone, gmail_thread_id, source, campaign_label, property_address, property_details, status, temperature, moment, ai_summary, notes, lead_type, twilio_number, message, drip_campaign_type, recommended_followup_date, followup_reason"

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

  const supaItems: ThreadItem[] = rows
    .filter((r) => (r.message || "").trim())
    .map((r) => ({
      at: r.created_at,
      from: r.twilio_number ? "them" : r.lead_type?.startsWith("drip_") ? "ryan(drip)" : "ryan",
      channel: r.lead_type?.replace(/^drip_/, "") ?? null,
      text: (r.message || "").trim(),
    }))
  const live = opts.live === false ? [] : await fetchLiveLeadMessages({
    caller_phone: anchor.caller_phone,
    gmail_thread_id: pick("gmail_thread_id"),
    source: pick("source"),
  })
  const thread = mergeThread([...supaItems, ...live])
  const lastInbound = [...thread].reverse().find((t) => t.from === "them") ?? null
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
    drip_campaign_type: pick("drip_campaign_type"),
    recommended_followup_date: pick("recommended_followup_date"),
    followup_reason: pick("followup_reason"),
    gmail_thread_id: pick("gmail_thread_id"),
    inboundChannel,
    thread,
    lastInbound,
  }
}

export async function buildRelationshipContext(relationshipId: string): Promise<RelationshipContext | null> {
  const sb = getLeadsClient()
  const { data: r, error } = await sb
    .from("relationships")
    .select("id, name, phone, category, tier, notes, last_contacted_at")
    .eq("id", relationshipId)
    .maybeSingle<{ id: string; name: string | null; phone: string | null; category: string | null; tier: string | null; notes: string | null; last_contacted_at: string | null }>()
  if (error) throw new Error(error.message)
  if (!r) return null
  const live = r.phone ? await fetchThread(r.phone) : []
  const thread = mergeThread(live.map((m) => ({ at: m.at, from: m.fromMe ? "ryan" : "them", channel: "imessage", text: m.text })))
  return {
    kind: "relationship",
    relationshipId: r.id,
    name: r.name,
    phone: r.phone,
    category: r.category,
    tier: r.tier,
    notes: r.notes,
    last_contacted_at: r.last_contacted_at,
    thread,
    lastInbound: [...thread].reverse().find((t) => t.from === "them") ?? null,
  }
}

/** Compact, labelled transcript for prompts. */
export function formatThread(ctx: ReplyContext, limit = 16): string {
  const items = ctx.thread.slice(-limit)
  if (!items.length) return "(no prior messages)"
  return items
    .map((t) => `[${t.at.slice(0, 10)}] ${t.from}${t.channel ? ` (${t.channel})` : ""}: ${t.text}`)
    .join("\n")
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
      ctx.drip_campaign_type ? `Current drip track: ${ctx.drip_campaign_type}` : null,
      ctx.recommended_followup_date ? `Follow-up on file: ${ctx.recommended_followup_date} (${ctx.followup_reason || "no reason"})` : null,
      ctx.ai_summary ? `Summary so far: ${ctx.ai_summary}` : null,
    ].filter(Boolean).join("\n")
  }
  return [
    `Name: ${ctx.name || "(unknown)"}`,
    `Category: ${ctx.category || "(none)"} · tier: ${ctx.tier || "(none)"}`,
    ctx.last_contacted_at ? `Last contacted: ${ctx.last_contacted_at.slice(0, 10)}` : "Never contacted through the CRMS",
  ].join("\n")
}
