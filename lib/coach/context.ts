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
  // The script Opus wrote for the most recent call, if any (coach_script).
  lastScript: unknown | null
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
    timeline: [], lastScript: null,
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
    if (r.coach_script) ctx.lastScript = r.coach_script
    const mine = ryanNotes(r.notes)
    if (mine && !seenNotes.has(mine)) { seenNotes.add(mine); ctx.notes.push(mine) }
    const text = (r.message || "").trim()
    if (text) {
      const dir = r.twilio_number ? "them" : "ryan"
      ctx.timeline.push(`[${String(r.created_at).slice(0, 10)}] ${r.lead_type || "?"} (${dir}): ${text.slice(0, 3000)}`)
    }
  }
  ctx.timeline = ctx.timeline.slice(-20)
  return ctx
}

export function describeLeadContext(ctx: LeadCoachContext): string {
  const lines: string[] = []
  lines.push(`Name: ${ctx.name || "unknown"}`)
  lines.push(`Phone: ${formatPhone(ctx.phone) ?? ctx.phone}`)
  lines.push(`Property: ${ctx.propertyAddress || "unknown"}`)
  if (ctx.sources.length) lines.push(`How they reached us: ${ctx.sources.join(", ")}`)
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
