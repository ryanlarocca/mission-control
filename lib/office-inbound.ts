// Office-line inbound routing (brief: briefs/BRIEF_OFFICE_LINE_INBOUND_2026-09-24.md).
//
// The business card carries the Office — Ryan line. Callers there are
// mostly people Ryan met in person — agents, inspectors, vendors — not
// sellers, so an unknown caller becomes a Relationships contact, not a
// lead. Ryan (2026-09-24): "check first if they're in either category. If a
// lead calls, they stay a lead. If somebody is in Relationships already,
// their card gets updated. Otherwise default to Relationships."
//
// Check order: Relationships → Leads → create a Relationship.

import type { SupabaseClient } from "@supabase/supabase-js"
import { OFFICE_NUMBERS } from "./leads"

export type OfficeCaller =
  | { kind: "lead" }
  | {
      kind: "relationship"
      id: string
      name: string
      category: string | null
      tier: string | null
      isNew: boolean
      /** true when the stored name is still the phone-number placeholder */
      placeholderName: boolean
    }

export const NEW_CONTACT_CATEGORY = "Agent"
export const NEW_CONTACT_TIER = "C"
export const NEW_CONTACT_SOURCE = "Business Card"

export function isOfficeLine(twilioNumber: string | null | undefined): boolean {
  return !!twilioNumber && OFFICE_NUMBERS.has(twilioNumber)
}

export function last10(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10)
}

export function toE164(phone: string): string | null {
  const d = last10(phone)
  return d.length === 10 ? `+1${d}` : null
}

// "(408) 555-1234" — the placeholder name for a contact we only know by number.
export function formatUsPhone(phone: string): string {
  const d = last10(phone)
  if (d.length !== 10) return phone
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

export function isPlaceholderName(name: string | null | undefined, phone: string): boolean {
  if (!name) return true
  const n = name.trim()
  return n === formatUsPhone(phone) || last10(n) === last10(phone)
}

function stampDay(): string {
  return new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" })
}

// Resolve who's calling/texting an office line. Never throws — a lookup
// failure resolves to "lead" so the caller falls through to the intake
// path that already exists (we'd rather log a lead than drop a call).
export async function resolveOfficeCaller(sb: SupabaseClient, phone: string): Promise<OfficeCaller> {
  const norm = last10(phone)
  if (norm.length < 10) return { kind: "lead" }
  try {
    // 1. Relationships — phones are stored E.164; last-10 LIKE covers any
    //    legacy formatting. Prefer an active row over do_not_contact.
    const { data: rels } = await sb
      .from("relationships")
      .select("id, name, category, tier, status")
      .like("phone", `%${norm}`)
      .order("status", { ascending: true }) // "active" < "do_not_contact"
      .limit(5)
    const rel = rels?.[0]
    if (rel?.id) {
      return {
        kind: "relationship",
        id: rel.id as string,
        name: (rel.name as string) || formatUsPhone(phone),
        category: (rel.category as string | null) ?? null,
        tier: (rel.tier as string | null) ?? null,
        isNew: false,
        placeholderName: isPlaceholderName(rel.name as string | null, phone),
      }
    }
    // 2. Leads — any prior inbound row for this number (same key the intake
    //    webhooks use for cluster inheritance).
    const { data: leads } = await sb
      .from("leads")
      .select("id")
      .eq("caller_phone", phone)
      .not("twilio_number", "is", null)
      .limit(1)
    if (leads && leads.length > 0) return { kind: "lead" }
    // 3. Nobody — create the Relationships contact.
    return await createRelationshipForCaller(sb, phone)
  } catch (e) {
    console.error("[office-inbound] resolve failed, falling back to lead path:", e instanceof Error ? e.message : String(e))
    return { kind: "lead" }
  }
}

async function createRelationshipForCaller(sb: SupabaseClient, phone: string): Promise<OfficeCaller> {
  const e164 = toE164(phone)
  if (!e164) return { kind: "lead" }
  const name = formatUsPhone(phone)
  const notes = `New contact — called the office line ${stampDay()}. Not previously in Leads or Relationships. Name/category are placeholders until the call transcript (or Ryan) fills them in.`
  const { data, error } = await sb
    .from("relationships")
    .insert({
      name,
      phone: e164,
      category: NEW_CONTACT_CATEGORY,
      tier: NEW_CONTACT_TIER,
      notes,
      source: NEW_CONTACT_SOURCE,
      status: "active",
      enriched_at: new Date().toISOString(),
    })
    .select("id")
    .single()
  if (error || !data?.id) {
    console.error("[office-inbound] relationships insert failed:", error?.message)
    return { kind: "lead" }
  }
  return {
    kind: "relationship",
    id: data.id as string,
    name,
    category: NEW_CONTACT_CATEGORY,
    tier: NEW_CONTACT_TIER,
    isNew: true,
    placeholderName: true,
  }
}

// Open the touch row for an inbound call before the Dial goes out, so its
// id can thread through the Twilio callbacks (same pattern as click-to-call).
export async function openInboundCallTouch(
  sb: SupabaseClient,
  rel: Extract<OfficeCaller, { kind: "relationship" }>,
  callSid: string | null
): Promise<string | null> {
  const { data, error } = await sb
    .from("relationship_touches")
    .insert({
      relationship_id: rel.id,
      modality: "call",
      action: "inbound",
      call_status: "ringing",
      call_sid: callSid,
      message: "📲 Inbound call to the office line — ringing",
      tier_at_touch: rel.tier,
      category_at_touch: rel.category,
    })
    .select("id")
    .single()
  if (error || !data?.id) {
    console.error("[office-inbound] touch insert failed:", error?.message)
    return null
  }
  return data.id as string
}

export async function logInboundTextTouch(
  sb: SupabaseClient,
  rel: Extract<OfficeCaller, { kind: "relationship" }>,
  body: string
): Promise<boolean> {
  const { error } = await sb.from("relationship_touches").insert({
    relationship_id: rel.id,
    modality: "sms",
    action: "inbound",
    message: body,
    tier_at_touch: rel.tier,
    category_at_touch: rel.category,
  })
  if (error) console.error("[office-inbound] text touch insert failed:", error.message)
  return !error
}

export function describeContact(rel: Extract<OfficeCaller, { kind: "relationship" }>): string {
  const who = `<b>${rel.name}</b>${rel.category && !rel.isNew ? ` (${rel.category})` : ""}`
  return rel.isNew ? `${who} — new contact, added to Relationships` : who
}
