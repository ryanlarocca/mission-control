// What the Sales Coach knows about a person before it writes a script or
// rates a call (2026-11-02). One gather for both: every row in the phone
// cluster, newest facts win for name/property/offer, Ryan's own notes
// (never the skip-trace block), and a dated timeline of what was said.

import type { SupabaseClient } from "@supabase/supabase-js"
import { ryanNotes } from "@/lib/lead-notes"
import { formatPhone } from "@/lib/utils"

export interface LeadCoachContext {
  phone: string
  name: string | null
  propertyAddress: string | null
  sources: string[]
  status: string | null
  temperature: string | null
  offerAmount: number | null
  offerVerbalizedAt: string | null
  mailPieces: string | null
  // Ryan's notes, deduped across the cluster, oldest first.
  notes: string[]
  aiNotes: string | null
  aiSummary: string | null
  // "[2025-08-02] voicemail (lead): hi Brian my name is Rita…" lines.
  timeline: string[]
  // The most recent script Opus wrote for this person (coach_script on any
  // row of the cluster) and when — reused by /api/coach/script while it is
  // fresh, so the tap is instant after the first generation.
  lastScript: unknown | null
  lastScriptAt: string | null
  // Newest row in the cluster — where a pre-dial script is cached.
  newestId: string | null
  // Date of the last message from THEM, and how long ago — the script's
  // hook changes register once a contact is stale (Ryan, 2026-11-02: a
  // 15-month-old text quoted back "comes off a little bit strange").
  lastFromThem: string | null
  daysSinceThem: number | null
}

export async function gatherLeadContext(sb: SupabaseClient, phone: string): Promise<LeadCoachContext> {
  const { data } = await sb
    .from("leads")
    .select("id, created_at, lead_type, twilio_number, message, name, property_address, notes, ai_notes, ai_summary, source, status, temperature, offer_amount, offer_verbalized_at, mail_pieces_detail, coach_script")
    .eq("caller_phone", phone)
    .order("created_at", { ascending: true })
    .limit(60)
  const rows = data ?? []
  const ctx: LeadCoachContext = {
    phone, name: null, propertyAddress: null, sources: [], status: null, temperature: null,
    offerAmount: null, offerVerbalizedAt: null, mailPieces: null, notes: [], aiNotes: null, aiSummary: null,
    timeline: [], lastScript: null, lastScriptAt: null, newestId: null, lastFromThem: null, daysSinceThem: null,
  }
  const seenNotes = new Set<string>()
  for (const r of rows) {
    if (r.name) ctx.name = r.name
    if (r.property_address) ctx.propertyAddress = r.property_address
    if (r.source && !ctx.sources.includes(r.source)) ctx.sources.push(r.source)
    if (r.status) ctx.status = r.status
    if (r.temperature) ctx.temperature = r.temperature
    if (typeof r.offer_amount === "number") { ctx.offerAmount = r.offer_amount; ctx.offerVerbalizedAt = r.offer_verbalized_at ?? null }
    if (r.mail_pieces_detail) ctx.mailPieces = typeof r.mail_pieces_detail === "string" ? r.mail_pieces_detail : JSON.stringify(r.mail_pieces_detail)
    if (r.ai_notes) ctx.aiNotes = r.ai_notes
    if (r.ai_summary) ctx.aiSummary = r.ai_summary
    ctx.newestId = r.id
    if (r.coach_script && typeof r.coach_script === "object") {
      const at = (r.coach_script as { generatedAt?: unknown }).generatedAt
      const atStr = typeof at === "string" ? at : null
      if (!ctx.lastScriptAt || (atStr && atStr > ctx.lastScriptAt)) { ctx.lastScript = r.coach_script; ctx.lastScriptAt = atStr }
    }
    const mine = ryanNotes(r.notes)
    if (mine && !seenNotes.has(mine)) { seenNotes.add(mine); ctx.notes.push(mine) }
    const text = (r.message || "").trim()
    if (text) {
      const dir = r.twilio_number ? "them" : "ryan"
      ctx.timeline.push(`[${String(r.created_at).slice(0, 10)}] ${r.lead_type || "?"} (${dir}): ${text.slice(0, 3000)}`)
      if (r.twilio_number) ctx.lastFromThem = String(r.created_at).slice(0, 10)
    }
  }
  ctx.timeline = ctx.timeline.slice(-20)
  if (ctx.lastFromThem) ctx.daysSinceThem = Math.max(0, Math.round((Date.now() - new Date(ctx.lastFromThem).getTime()) / 86_400_000))
  return ctx
}

// Ryan's own recent voicemails, for the script's voice. Outbound call rows
// whose transcript holds his message: dual-channel ones are read from the
// "Ryan:" turns; older mixed ones are taken whole when they are clearly a
// message (not a no-answer stamp). Short greetings-only rows are skipped.
export async function gatherRyanVoiceSamples(sb: SupabaseClient, limit = 8): Promise<string[]> {
  const { data } = await sb
    .from("leads")
    .select("message, created_at")
    .is("twilio_number", null)
    .eq("lead_type", "call")
    .not("message", "is", null)
    .order("created_at", { ascending: false })
    .limit(40)
  const out: string[] = []
  for (const r of data ?? []) {
    const text = String(r.message || "")
    if (text.startsWith("📵")) continue
    let mine: string
    if (/^Ryan:/m.test(text)) {
      mine = text.split("\n").filter((l) => l.startsWith("Ryan:")).map((l) => l.slice(5).trim()).join(" ")
    } else {
      // Mixed transcript: skip the other side's greeting / screener prompt
      // and start where his message starts.
      const m = text.match(/\b(yeah,?\s+)?(hi|hey|hello)\b[^.]{0,40}?\b(this is|it'?s) ryan\b|\bthis is ryan\b/i)
      mine = m && m.index != null ? text.slice(m.index) : text
    }
    mine = mine.replace(/\s+/g, " ").trim()
    // A real message, not "this is Ryan, looking for Rita" at a screener.
    if (mine.length < 140 || mine.length > 900) continue
    out.push(mine)
    if (out.length >= limit) break
  }
  return out
}

export function describeLeadContext(ctx: LeadCoachContext): string {
  const lines: string[] = []
  lines.push(`Name: ${ctx.name || "unknown"}`)
  lines.push(`Phone: ${formatPhone(ctx.phone) ?? ctx.phone}`)
  lines.push(`Property: ${ctx.propertyAddress || "unknown"}`)
  if (ctx.sources.length) lines.push(`How they reached us: ${ctx.sources.join(", ")}`)
  if (ctx.lastFromThem) {
    const d = ctx.daysSinceThem ?? 0
    const stale = d > 180
    lines.push(`Last message from them: ${ctx.lastFromThem} (${d} days ago)${stale ? " — STALE: they will not remember the exchange; soft reminder with an out, no details quoted back" : " — recent: use their words"}`)
  }
  if (ctx.status) lines.push(`Status: ${ctx.status}${ctx.temperature ? ` · ${ctx.temperature}` : ""}`)
  if (ctx.offerAmount != null) lines.push(`Offer on file: $${ctx.offerAmount.toLocaleString()}${ctx.offerVerbalizedAt ? ` (verbalized ${ctx.offerVerbalizedAt.slice(0, 10)})` : ""}`)
  if (ctx.mailPieces) lines.push(`Mail they received: ${ctx.mailPieces.slice(0, 600)}`)
  if (ctx.aiSummary) lines.push(`Card summary: ${ctx.aiSummary}`)
  if (ctx.aiNotes) lines.push(`Last call notes: ${ctx.aiNotes}`)
  if (ctx.notes.length) lines.push(`Ryan's notes:\n${ctx.notes.map((n) => `  ${n.replace(/\n/g, "\n  ")}`).join("\n")}`)
  lines.push(ctx.timeline.length ? `Timeline (oldest first):\n${ctx.timeline.join("\n")}` : "Timeline: no prior messages or calls on record.")
  return lines.join("\n")
}

export interface RelationshipCoachContext {
  name: string
  category: string | null
  notes: string | null
  recentTouches: string[]
}

export async function gatherRelationshipContext(sb: SupabaseClient, relationshipId: string): Promise<RelationshipCoachContext> {
  const { data: rel } = await sb.from("relationships").select("name, category, notes").eq("id", relationshipId).single()
  const { data: touches } = await sb
    .from("relationship_touches")
    .select("occurred_at, modality, action, message")
    .eq("relationship_id", relationshipId)
    .order("occurred_at", { ascending: false })
    .limit(8)
  return {
    name: rel?.name || "a contact",
    category: rel?.category ?? null,
    notes: rel?.notes ?? null,
    recentTouches: (touches ?? [])
      .filter((t) => t.message)
      .reverse()
      .map((t) => `[${String(t.occurred_at).slice(0, 10)}] ${t.modality}/${t.action}: ${String(t.message).slice(0, 800)}`),
  }
}

export function describeRelationshipContext(ctx: RelationshipCoachContext): string {
  const lines = [`Name: ${ctx.name}`, `Category: ${ctx.category || "unknown"}`]
  if (ctx.notes) lines.push(`Card notes:\n${ctx.notes.slice(0, 4000)}`)
  lines.push(ctx.recentTouches.length ? `Recent touches (oldest first):\n${ctx.recentTouches.join("\n")}` : "Recent touches: none on record.")
  return lines.join("\n")
}
