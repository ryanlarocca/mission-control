import type { SupabaseClient } from "@supabase/supabase-js"
import { formatUsPhone, isPlaceholderName, last10, toE164, type OfficeCaller } from "./office-inbound"

// Agents line (650) 910-4007 + agent email-campaign replies → Relationships.
//
// Ryan, 2026-10-01: "an agent that's calling me with a deal is someone I want
// to stay in touch with" — so every human who calls, texts or emails back on
// the campaign lands on a Relationships card (never a lead), tier B by
// default, and the campaign contact remembers which card it is
// (campaign_contacts.relationship_id). Same plumbing as the business-card
// office lines (lib/office-inbound.ts), with the campaign list checked FIRST
// because the touch number / drip context lives there.
//
// Check order: campaign contact's linked card → Relationships by phone →
// Relationships by email → (phone channels only) existing Lead stays a lead
// → create the card, seeded from the campaign row when there is one.

export const AGENTS_LINE = "+16509104007"
export const AGENTS_LINE_DISPLAY = "(650) 910-4007"
export const AGENT_CONTACT_CATEGORY = "Agent"
export const AGENT_CONTACT_TIER = "B" // Ryan 2026-10-01: agents default to B
export const AGENTS_LINE_SOURCE = "Agents Line"
export const AGENT_EMAIL_SOURCE = "Agent Email Campaign"

export interface CampaignContactLite {
  id: string
  name: string | null
  email: string | null
  phone: string | null
  relationship_id: string | null
  touch_number: number
  status: string
}

export type AgentContact =
  | { kind: "lead" }
  | (Extract<OfficeCaller, { kind: "relationship" }> & { campaign: CampaignContactLite | null })

const CONTACT_COLS = "id, name, email, phone, relationship_id, touch_number, status"

export async function findCampaignContactByPhone(sb: SupabaseClient, phone: string): Promise<CampaignContactLite | null> {
  const d = last10(phone)
  if (d.length !== 10) return null
  const { data } = await sb
    .from("campaign_contacts")
    .select(CONTACT_COLS)
    .or(`phone.eq.${d},alt_phones.cs.{${d}}`)
    .limit(1)
  return (data?.[0] as CampaignContactLite) ?? null
}

function stampDay(): string {
  return new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" })
}

type RelRow = { id: string; name: string | null; category: string | null; tier: string | null; status: string | null; phone: string | null; email: string | null }
const REL_COLS = "id, name, category, tier, status, phone, email"

async function relById(sb: SupabaseClient, id: string): Promise<RelRow | null> {
  const { data } = await sb.from("relationships").select(REL_COLS).eq("id", id).limit(1)
  return (data?.[0] as RelRow) ?? null
}
async function relByPhone(sb: SupabaseClient, phone: string): Promise<RelRow | null> {
  const d = last10(phone)
  if (d.length !== 10) return null
  const { data } = await sb
    .from("relationships")
    .select(REL_COLS)
    .like("phone", `%${d}`)
    .order("status", { ascending: true }) // "active" < "do_not_contact"
    .limit(5)
  return (data?.[0] as RelRow) ?? null
}
async function relByEmail(sb: SupabaseClient, email: string): Promise<RelRow | null> {
  const e = email.trim().toLowerCase()
  if (!e.includes("@")) return null
  const { data } = await sb
    .from("relationships")
    .select(REL_COLS)
    .ilike("email", e)
    .order("status", { ascending: true })
    .limit(5)
  return (data?.[0] as RelRow) ?? null
}

function toContact(rel: RelRow, phone: string | null, campaign: CampaignContactLite | null, isNew: boolean): AgentContact {
  const keyPhone = phone || rel.phone || ""
  return {
    kind: "relationship",
    id: rel.id,
    name: rel.name || (keyPhone ? formatUsPhone(keyPhone) : rel.email || "Unknown"),
    category: rel.category ?? null,
    tier: rel.tier ?? null,
    isNew,
    placeholderName: keyPhone ? isPlaceholderName(rel.name, keyPhone) : !rel.name,
    campaign,
  }
}

/**
 * Resolve an agent who reached out (call/text on the agents line, or an email
 * reply) to a Relationships card, creating one when nobody has it. Never
 * throws — a lookup failure resolves to "lead" so the caller falls back to
 * the campaign-only behaviour that existed before (alert + timeline event).
 */
export async function resolveAgentContact(
  sb: SupabaseClient,
  args: {
    phone?: string | null
    email?: string | null
    campaign?: CampaignContactLite | null
    channel: "call" | "sms" | "email"
    source?: string
    // An agent reaching out is someone Ryan wants to stay in touch with
    // (2026-10-01): a card parked as do_not_contact by the 07-16 Cleanup
    // triage ("never" — out of the daily queue) comes back to active on
    // a genuine inbound. Pass false for STOP / unsubscribe texts & emails.
    reactivate?: boolean
  }
): Promise<AgentContact> {
  const phone = args.phone?.trim() || null
  const email = (args.email?.trim().toLowerCase() || args.campaign?.email?.trim().toLowerCase()) || null
  const campaign = args.campaign ?? null
  try {
    // 1. The campaign contact already knows its card.
    if (campaign?.relationship_id) {
      const rel = await relById(sb, campaign.relationship_id)
      if (rel) return toContact(await maybeReactivate(sb, rel, args), phone, campaign, false)
    }
    // 2./3. Relationships by phone, then by email (caller's, else the campaign row's).
    let rel = phone ? await relByPhone(sb, phone) : null
    if (!rel && email) rel = await relByEmail(sb, email)
    if (!rel && campaign?.phone && !phone) rel = await relByPhone(sb, campaign.phone)
    if (rel) {
      await linkCampaignContact(sb, campaign, rel.id)
      return toContact(await maybeReactivate(sb, rel, args), phone, campaign, false)
    }
    // 4. A phone caller who is already a seller lead stays a lead (Ryan's
    //    2026-09-24 office-line rule; the Leads/Relationships hide rule would
    //    otherwise make them vanish from the Leads tab).
    if (phone && args.channel !== "email" && !campaign) {
      const e164 = toE164(phone)
      if (e164) {
        const { data: leads } = await sb
          .from("leads")
          .select("id")
          .eq("caller_phone", e164)
          .not("twilio_number", "is", null)
          .limit(1)
        if (leads && leads.length > 0) return { kind: "lead" }
      }
    }
    // 5. Nobody has them — create the card.
    const created = await createAgentRelationship(sb, { phone, email, campaign, channel: args.channel, source: args.source })
    if (!created) return { kind: "lead" }
    await linkCampaignContact(sb, campaign, created.id)
    return toContact(created, phone, campaign, true)
  } catch (e) {
    console.error("[agents-inbound] resolve failed, falling back to campaign-only path:", e instanceof Error ? e.message : String(e))
    return { kind: "lead" }
  }
}

async function maybeReactivate(
  sb: SupabaseClient,
  rel: RelRow,
  args: { channel: "call" | "sms" | "email"; reactivate?: boolean }
): Promise<RelRow> {
  if (args.reactivate === false || rel.status !== "do_not_contact") return rel
  const verb = args.channel === "call" ? "called" : args.channel === "sms" ? "texted" : "emailed"
  const where = args.channel === "email" ? "replied to the agent email campaign" : `${verb} the agents line`
  const { data: cur } = await sb.from("relationships").select("notes").eq("id", rel.id).single()
  const prev = String(cur?.notes ?? "").trim()
  const line = `[${stampDay()}] Reactivated — ${where}; back in the Relationships queue.`
  const { error } = await sb
    .from("relationships")
    .update({ status: "active", notes: prev ? `${prev}\n\n${line}` : line })
    .eq("id", rel.id)
  if (error) {
    console.error("[agents-inbound] reactivate failed:", error.message)
    return rel
  }
  return { ...rel, status: "active" }
}

async function linkCampaignContact(sb: SupabaseClient, campaign: CampaignContactLite | null, relationshipId: string): Promise<void> {
  if (!campaign || campaign.relationship_id === relationshipId) return
  const { error } = await sb
    .from("campaign_contacts")
    .update({ relationship_id: relationshipId, updated_at: new Date().toISOString() })
    .eq("id", campaign.id)
  if (error) console.error("[agents-inbound] campaign link failed:", error.message)
  else campaign.relationship_id = relationshipId
}

async function createAgentRelationship(
  sb: SupabaseClient,
  args: { phone: string | null; email: string | null; campaign: CampaignContactLite | null; channel: "call" | "sms" | "email"; source?: string }
): Promise<RelRow | null> {
  const { phone, email, campaign, channel } = args
  const e164 = phone ? toE164(phone) : campaign?.phone ? toE164(campaign.phone) : null
  const name = campaign?.name?.trim() || (phone ? formatUsPhone(phone) : email || "Unknown agent")
  const verb = channel === "call" ? "called" : channel === "sms" ? "texted" : "emailed"
  const where = channel === "email" ? "replied to the agent email campaign" : `${verb} the agents line (${AGENTS_LINE_DISPLAY})`
  const notes = campaign
    ? `Agent from the email campaign — ${where} ${stampDay()}${campaign.touch_number ? ` after touch ${campaign.touch_number}` : ""}. Added to Relationships automatically (tier ${AGENT_CONTACT_TIER}).`
    : `New contact — ${where} ${stampDay()}. Not previously in Leads or Relationships. Name/category are placeholders until the transcript (or Ryan) fills them in.`
  const source = args.source ?? (channel === "email" ? AGENT_EMAIL_SOURCE : AGENTS_LINE_SOURCE)
  const { data, error } = await sb
    .from("relationships")
    .insert({
      name,
      phone: e164,
      email: email ?? null,
      category: AGENT_CONTACT_CATEGORY,
      tier: AGENT_CONTACT_TIER,
      notes,
      source,
      status: "active",
      enriched_at: new Date().toISOString(),
    })
    .select(REL_COLS)
    .single()
  if (error || !data?.id) {
    console.error("[agents-inbound] relationships insert failed:", error?.message)
    return null
  }
  return data as RelRow
}

/** Mark the card do-not-contact when the agent asks to be removed (STOP text,
 * "remove"/"retired" email). The suppression table is the DNC list proper —
 * this keeps the Relationships daily cadence from reaching out too. */
export async function markRelationshipDoNotContact(sb: SupabaseClient, relationshipId: string, why: string): Promise<void> {
  const { data: cur } = await sb.from("relationships").select("notes").eq("id", relationshipId).single()
  const prev = String(cur?.notes ?? "").trim()
  const line = `[${stampDay()}] Do not contact — ${why.trim()}`
  const { error } = await sb
    .from("relationships")
    .update({ status: "do_not_contact", notes: prev ? `${prev}\n\n${line}` : line })
    .eq("id", relationshipId)
  if (error) console.error("[agents-inbound] do_not_contact update failed:", error.message)
}

export async function logInboundEmailTouch(
  sb: SupabaseClient,
  rel: Extract<AgentContact, { kind: "relationship" }>,
  body: string,
  subject: string
): Promise<boolean> {
  const text = body.trim()
  const { error } = await sb.from("relationship_touches").insert({
    relationship_id: rel.id,
    modality: "email",
    action: "inbound",
    message: (subject ? `Re: ${subject.replace(/^(re|fwd?):\s*/i, "")}\n` : "") + text.slice(0, 4000),
    tier_at_touch: rel.tier,
    category_at_touch: rel.category,
  })
  if (error) console.error("[agents-inbound] email touch insert failed:", error.message)
  return !error
}

/** Telegram label: "<b>Anna Fine</b> (Agent) (after T1) — new contact, added to Relationships (tier B)" */
export function describeAgent(rel: Extract<AgentContact, { kind: "relationship" }>): string {
  const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  let who = `<b>${esc(rel.name)}</b>`
  if (rel.category && !rel.isNew) who += ` (${esc(rel.category)})`
  if (rel.campaign) who += ` (after T${rel.campaign.touch_number})`
  else who += " (not in campaign list)"
  if (rel.isNew) who += ` — new contact, added to Relationships (tier ${AGENT_CONTACT_TIER})`
  return who
}
