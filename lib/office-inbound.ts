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
import { OFFICE_NUMBERS, isOwnedNumber } from "./leads"
import { normalizeAltPhones, relationshipsByAnyPhone, settleNewRelationship } from "./relationships"

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
      /** Matched by the number signed in the text, not the sender: the
       * card's main number (E.164) — what replies go to. */
      signedAs?: string
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

// US numbers written in a text ("Fernando | (408) 309-2868"), as 10 digits,
// minus the sender's own and ours. Order kept, de-duplicated.
export function signedPhones(body: string, sender: string): string[] {
  const own = last10(sender)
  const out: string[] = []
  for (const m of Array.from(body.matchAll(/(?<!\d)(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?!\d)/g))) {
    const d = `${m[1]}${m[2]}${m[3]}`
    if (d === own || out.includes(d) || isOwnedNumber(d)) continue
    out.push(d)
  }
  return out
}

// Resolve who's calling/texting an office line. Never throws — a lookup
// failure resolves to "lead" so the caller falls through to the intake
// path that already exists (we'd rather log a lead than drop a call).
// `body` (texts only): before a new card is made, a number signed in the
// message that's already on a card claims the sender — a wholesaler's
// blast comes from a bulk line but signs with his cell (2026-11-10, a
// known agent's Union Ave blast made a second card).
export async function resolveOfficeCaller(sb: SupabaseClient, phone: string, body?: string | null): Promise<OfficeCaller> {
  const norm = last10(phone)
  if (norm.length < 10) return { kind: "lead" }
  try {
    // 1. Relationships — their main number or one of their extras
    //    (alt_phones). Prefer an active row over do_not_contact.
    const rels = await relationshipsByAnyPhone<{ id: string; name: string | null; category: string | null; tier: string | null; status: string | null }>(
      sb, norm, "id, name, category, tier, status"
    )
    const rel = rels[0]
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
    // 3. A number signed in the text that's on a card → that card.
    if (body) {
      const signed = await relationshipBySignedPhone(sb, phone, body)
      if (signed) return signed
    }
    // 4. Nobody — create the Relationships contact.
    return await createRelationshipForCaller(sb, phone)
  } catch (e) {
    console.error("[office-inbound] resolve failed, falling back to lead path:", e instanceof Error ? e.message : String(e))
    return { kind: "lead" }
  }
}

// Exactly one card must know the signed number (two = ambiguous, leave it).
// The sender's number is added to that card as an extra, so the next text
// from the bulk line lands there directly.
async function relationshipBySignedPhone(sb: SupabaseClient, phone: string, body: string): Promise<OfficeCaller | null> {
  const sender = toE164(phone)
  if (!sender) return null
  type Row = { id: string; name: string | null; phone: string | null; alt_phones: string[] | null; category: string | null; tier: string | null; notes: string | null; status: string | null }
  for (const d of signedPhones(body, phone).slice(0, 3)) {
    const rows = await relationshipsByAnyPhone<Row>(sb, d, "id, name, phone, alt_phones, category, tier, notes, status")
    if (rows.length !== 1) continue
    const r = rows[0]
    const line = `${formatUsPhone(phone)} added as an extra number ${stampDay()} — texted the office line signed with ${formatUsPhone(d)}.`
    const prev = (r.notes ?? "").trim()
    const { error } = await sb
      .from("relationships")
      .update({ alt_phones: normalizeAltPhones([...(r.alt_phones ?? []), sender], r.phone), notes: prev ? `${prev}\n\n${line}` : line })
      .eq("id", r.id)
    if (error) console.error("[office-inbound] signed-number alt phone add failed:", error.message)
    return {
      kind: "relationship",
      id: r.id,
      name: r.name || formatUsPhone(d),
      category: r.category ?? null,
      tier: r.tier ?? null,
      isNew: false,
      placeholderName: isPlaceholderName(r.name, d),
      signedAs: toE164(r.phone ?? d) ?? `+1${d}`,
    }
  }
  return null
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
  // A simultaneous webhook may have created this caller's card — use that one.
  const keepId = await settleNewRelationship(sb, data.id as string, e164)
  if (keepId !== data.id) return resolveOfficeCaller(sb, phone)
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
  callSid: string | null,
  line = "office line"
): Promise<string | null> {
  const { data, error } = await sb
    .from("relationship_touches")
    .insert({
      relationship_id: rel.id,
      modality: "call",
      action: "inbound",
      call_status: "ringing",
      call_sid: callSid,
      message: `📲 Inbound call to the ${line} — ringing`,
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

// `twilioNumber` = the line the text came in on (E.164), so the card's
// Messages box can show it and a Telegram reply goes back out on it.
export async function logInboundTextTouch(
  sb: SupabaseClient,
  rel: Extract<OfficeCaller, { kind: "relationship" }>,
  body: string,
  twilioNumber?: string | null
): Promise<boolean> {
  const { error } = await sb.from("relationship_touches").insert({
    relationship_id: rel.id,
    modality: "sms",
    action: "inbound",
    message: body,
    tier_at_touch: rel.tier,
    category_at_touch: rel.category,
    ...(twilioNumber ? { twilio_number: twilioNumber } : {}),
  })
  if (error) console.error("[office-inbound] text touch insert failed:", error.message)
  return !error
}

export function describeContact(rel: Extract<OfficeCaller, { kind: "relationship" }>): string {
  const who = `<b>${rel.name}</b>${rel.category && !rel.isNew ? ` (${rel.category})` : ""}`
  return rel.isNew ? `${who} — new contact, added to Relationships` : who
}
