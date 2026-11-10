// Do-not-contact — one place for "is this person DNC?", "is this an explicit
// remove request?", and "mark this contact DNC" (opt-out audit, Ryan approved
// 2026-11-03).
//
// Ryan's rule: only an explicit ask to stop contact is DNC ("take me off your
// list", "remove me", "stop texting me"). "Not selling" / "not interested" is
// never DNC — a no today is a future seller. One confirmation reply after the
// opt-out is fine ("you're off my list"); nothing after that.
//
// DNC state lives in three places: leads.is_dnc (now written on EVERY row of
// the contact's cluster so row-level checks hold), dnc_list (address /
// parcel, for the mail scrub) and suppression (the master list; DB triggers
// copy both of the others into it).

import type { SupabaseClient } from "@supabase/supabase-js"
import { isSuppressed, normalizeSuppressionEmail, normalizeSuppressionPhone, type SuppressionChannel } from "./suppression"
import {
  autoLinkMailRecord, linkMailRecordToCluster, mailSearchCampaignId, normStreet, parseFreeAddress,
  MAIL_RECORD_LITE_COLUMNS, type CampaignScopeLite, type MailRecordLite,
} from "./mailMatch"

// Same list as scripts/drip-engine.js HARD_STOP_PATTERNS — keep in step.
const EXPLICIT_OPTOUT_PATTERNS: RegExp[] = [
  /^\s*(?:stop|unsubscribe|stop all|end|quit|cancel)\s*[.!]*\s*$/i,
  /\btake me off\b/i,
  /\btake (?:my (?:name|number|address|house|property) )?off (?:of )?(?:your|the) (?:mailing |call |contact )?list\b/i,
  /\bremove me\b/i,
  /\bremove (?:my (?:name|number|address|house|property)) from\b/i,
  /\bstop (?:texting|messaging|emailing|calling|contacting|sending|mailing)\b/i,
  /\bquit (?:calling|texting|sending)\b/i,
  /\b(?:do not|don['’]?t|never) (?:ever )?(?:call|text|contact|mail|email|message) (?:me|us|this number) (?:again|anymore|ever)\b/i,
  /\b(?:do not|don['’]?t) contact me\b/i,
  /\bunsubscribe\b/i,
  /\bleave me alone\b/i,
  /\bfuck off\b/i,
  /\bcease (?:and desist|contact)\b/i,
]

/** The matched phrase when the text is an explicit remove request, else null. */
export function explicitOptOutPhrase(text: string | null | undefined): string | null {
  if (!text) return null
  for (const part of [text, ...text.split("\n")]) {
    for (const re of EXPLICIT_OPTOUT_PATTERNS) {
      const m = re.exec(part)
      if (m) return m[0]
    }
  }
  return null
}

/** Twilio's reserved opt-out keywords — Twilio itself replies and blocks the number. */
export function isTwilioStopKeyword(text: string | null | undefined): boolean {
  return /^\s*(?:stop|stopall|stop all|unsubscribe|cancel|end|quit|optout|opt out|revoke)\s*[.!]*\s*$/i.test(text ?? "")
}

/** Short courtesy replies ("thanks", "ok 👍") — no card, no reply needed. */
export function isCourtesyReply(text: string | null | undefined): boolean {
  const t = String(text ?? "").trim().toLowerCase().replace(/[.!]+/g, "").replace(/\uD83D[\uDE4F\uDC4D\uDE0A]/g, "").trim()
  if (!t) return true
  return t.length <= 40 && /^(?:ok(?:ay)?|k|thanks?(?: you)?(?: (?:so much|very much))?|thank you|ty|thx|great|perfect|appreciate (?:it|you)|got it|cool|sounds good|will do|no problem|np|you too|bye|have a (?:good|great|nice) (?:day|one|night|week))(?:[ ,]+(?:thanks?|thank you|ty|bye))*$/.test(t)
}

function phoneVariants(phone: string | null | undefined): string[] {
  const ten = normalizeSuppressionPhone(phone)
  const out = new Set<string>()
  if (phone && phone.trim()) out.add(phone.trim())
  if (ten) { out.add(`+1${ten}`); out.add(ten) }
  return Array.from(out)
}

export interface DncCheck { dnc: boolean; why: string | null }

/**
 * Is this person do-not-contact for this channel? Checks every lead row with
 * the phone or email (is_dnc) and the master suppression list. Throws when a
 * lookup fails — callers block the send (fail safe).
 */
export async function checkContactDnc(
  sb: SupabaseClient,
  who: { phone?: string | null; email?: string | null },
  channel: SuppressionChannel
): Promise<DncCheck> {
  const ors: string[] = []
  for (const p of phoneVariants(who.phone)) ors.push(`caller_phone.eq.${p}`)
  const email = normalizeSuppressionEmail(who.email)
  if (email) ors.push(`email.ilike.${email}`)
  if (!ors.length) return { dnc: false, why: null }
  const { data, error } = await sb.from("leads").select("id").or(ors.join(",")).eq("is_dnc", true).limit(1)
  if (error) throw new Error(`DNC lookup failed: ${error.message}`)
  if (data && data.length) return { dnc: true, why: "lead is DNC" }
  if (await isSuppressed(sb, { phone: who.phone, email: who.email, channel })) {
    return { dnc: true, why: "on the do-not-contact list" }
  }
  return { dnc: false, why: null }
}

/**
 * The one confirmation reply after an opt-out ("you're off my list") is
 * allowed through the DNC gate exactly once: only when nothing has been sent
 * to the contact since their opt-out arrived.
 */
export async function optOutConfirmationAllowed(
  sb: SupabaseClient,
  who: { phone?: string | null; email?: string | null }
): Promise<boolean> {
  const ors: string[] = []
  for (const p of phoneVariants(who.phone)) ors.push(`caller_phone.eq.${p}`)
  const email = normalizeSuppressionEmail(who.email)
  if (email) ors.push(`email.ilike.${email}`)
  if (!ors.length) return false
  const { data: optOut } = await sb
    .from("leads")
    .select("created_at")
    .or(ors.join(","))
    .eq("is_dnc", true)
    .not("twilio_number", "is", null)
    .order("created_at", { ascending: true })
    .limit(1)
  const since = optOut?.[0]?.created_at as string | undefined
  if (!since) return false
  // Outbound rows carry no twilio_number (that column is the line they reached).
  const { data: sent } = await sb
    .from("leads")
    .select("id")
    .or(ors.join(","))
    .is("twilio_number", null)
    .in("lead_type", ["sms", "email"])
    .gt("created_at", since)
    .limit(1)
  return !sent || sent.length === 0
}

// ─── address match for opt-outs ────────────────────────────────────────────

const STREET_IN_TEXT = /\b\d{1,6}[A-Z]?\s+(?:[NSEW]\.?\s+)?[A-Za-z0-9][\w'’.-]*(?:\s+[A-Za-z][\w'’.-]*){0,4}/

/** The street address inside free text ("…mailing list for 765 N B40\nI am…" → "765 N B40"). */
export function extractStreetAddress(text: string | null | undefined): string | null {
  const t = String(text ?? "").trim()
  if (!t) return null
  if (parseFreeAddress(t).hasNumber && t.length <= 80) return t
  for (const line of t.split("\n")) {
    const re = new RegExp(STREET_IN_TEXT.source, "g")
    let m: RegExpExecArray | null
    while ((m = re.exec(line))) {
      // Looks like a street, not "I'm 88 and thinking…": a directional, a
      // street suffix, or a capitalized street name.
      const cand = m[0].trim()
      const words = cand.split(/\s+/)
      const hasDir = /^[NSEW]\.?$/i.test(words[1] ?? "") && words.length > 2
      const suffix = /^(.*?\b(?:st|street|ave|avenue|dr|drive|rd|road|blvd|ct|court|ln|lane|pl|place|way|cir|circle|ter|terrace|pkwy|hwy))\b\.?/i.exec(cand)
      if (suffix) return suffix[1]
      const capitalized = /^[A-Z0-9]/.test(words[1] ?? "")
      if (hasDir || capitalized) return cand
    }
  }
  return null
}

const DIRECTIONAL: Record<string, string> = { NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W" }

/**
 * Opt-outs often write the address loosely ("765 N B40" for 765 N Branciforte
 * Ave). Within the mailed list for the line they contacted, a house number +
 * directional + first letter of the street name that hits exactly ONE record
 * is that house. Null otherwise — never guesses between two.
 */
export async function fuzzyMailRecordForOptOut(
  sb: SupabaseClient,
  campaignId: string | null,
  heard: string | null
): Promise<MailRecordLite | null> {
  if (!campaignId || !heard) return null
  const addr = parseFreeAddress(heard)
  if (!addr.hasNumber) return null
  const words = normStreet(addr.street).split(" ").map(w => DIRECTIONAL[w] ?? w)
  const num = words[0]
  if (!/^\d+[A-Z]?$/.test(num)) return null
  let i = 1
  const dir = ["N", "S", "E", "W"].includes(words[i] ?? "") ? words[i++] : null
  const heardName = words[i] ?? ""
  const firstLetter = heardName.charAt(0)
  if (!firstLetter) return null
  const { data } = await sb
    .from("mail_records")
    .select(`${MAIL_RECORD_LITE_COLUMNS}, site_street_norm`)
    .eq("campaign_id", campaignId)
    .like("site_street_norm", `${num} %`)
    .limit(50)
  const rows = ((data ?? []) as unknown as (MailRecordLite & { site_street_norm: string })[]).filter(r => {
    const w = String(r.site_street_norm).split(" ").map(x => DIRECTIONAL[x] ?? x)
    let j = 1
    const rDir = ["N", "S", "E", "W"].includes(w[j] ?? "") ? w[j++] : null
    if (dir && rDir !== dir) return false
    return streetNamesAgree(heardName, w[j] ?? "")
  })
  if (rows.length !== 1) return null
  const { site_street_norm: _s, ...rec } = rows[0]
  return rec
}

// Same rule as scripts/dnc-mail-scrub.mjs: a garbled / abbreviated street
// ("B40") matches on its first letter; a real word ("SWEETS") must look like
// the record's street (shared 3-letter prefix or ≤2 edits) — first letter
// alone linked 489 Sweets Dr → 489 Sioux Ln in the 11-03 test.
function streetNamesAgree(heard: string, rec: string): boolean {
  if (!heard || !rec || heard.charAt(0) !== rec.charAt(0)) return false
  if (!/^[A-Z]{3,}$/.test(heard)) return true
  if (rec.startsWith(heard) || heard.startsWith(rec)) return true
  let k = 0
  while (k < heard.length && k < rec.length && heard[k] === rec[k]) k++
  if (k >= 3) return true
  const d: number[][] = Array.from({ length: heard.length + 1 }, (_, x) => [x, ...Array(rec.length).fill(0)])
  for (let y = 1; y <= rec.length; y++) d[0][y] = y
  for (let x = 1; x <= heard.length; x++)
    for (let y = 1; y <= rec.length; y++)
      d[x][y] = Math.min(d[x - 1][y] + 1, d[x][y - 1] + 1, d[x - 1][y - 1] + (heard[x - 1] === rec[y - 1] ? 0 : 1))
  return d[heard.length][rec.length] <= 2
}

export interface OptOutRecord {
  id: string
  site_address: string | null
  site_city: string | null
  site_zip: string | null
  parcel_number: string | null
  owner_name: string | null
  mail_address: string | null
  mail_city: string | null
  mail_state: string | null
  mail_zip: string | null
  county: string | null
}

const RECORD_COLS = "id, site_address, site_city, site_zip, parcel_number, owner_name, mail_address, mail_city, mail_state, mail_zip, county"

interface LeadIdentity {
  id: string
  caller_phone: string | null
  email: string | null
  gmail_thread_id: string | null
  name: string | null
  property_address: string | null
  campaign_id: string | null
  mail_record_id: string | null
}

const ANON = new Set(["anonymous", "restricted", "unavailable", "private", "unknown"])

function clusterOr(lead: Pick<LeadIdentity, "id" | "caller_phone" | "email" | "gmail_thread_id">): string {
  const ors = [`id.eq.${lead.id}`]
  if (lead.caller_phone && !ANON.has(lead.caller_phone.trim().toLowerCase())) ors.push(`caller_phone.eq.${lead.caller_phone}`)
  if (lead.gmail_thread_id) ors.push(`gmail_thread_id.eq.${lead.gmail_thread_id}`)
  if (lead.email) ors.push(`email.ilike.${lead.email.toLowerCase()}`)
  return ors.join(",")
}

async function campaignScope(sb: SupabaseClient, campaignId: string | null): Promise<string | null> {
  if (!campaignId) return null
  const { data } = await sb.from("campaigns").select("id, parent_campaign_id, piece").eq("id", campaignId).maybeSingle()
  return mailSearchCampaignId((data as CampaignScopeLite | null) ?? null, campaignId)
}

/** An opt-out still counts as a response to the letter (a removal) — credit it like any contact. */
async function creditQuietly(sb: SupabaseClient, leadId: string): Promise<void> {
  try {
    const { creditMailPerson } = await import("./mailCredit")
    await creditMailPerson(sb, leadId, { alert: false })
  } catch (e) {
    console.warn("[dnc] mail credit failed:", e instanceof Error ? e.message : String(e))
  }
}

/** Link the cluster to the mailed record the opt-out is about (exact match first, then the loose one). */
export async function matchOptOutAddress(sb: SupabaseClient, lead: LeadIdentity, heard: string | null): Promise<OptOutRecord | null> {
  if (!lead.mail_record_id) {
    try { await autoLinkMailRecord(sb, lead.id, { alert: false }) } catch (e) {
      console.warn("[dnc] mail auto-link failed:", e instanceof Error ? e.message : String(e))
    }
    const { data: again } = await sb.from("leads").select("mail_record_id").eq("id", lead.id).maybeSingle()
    lead.mail_record_id = (again?.mail_record_id as string | null) ?? null
  }
  if (!lead.mail_record_id) {
    const fuzzy = await fuzzyMailRecordForOptOut(sb, await campaignScope(sb, lead.campaign_id), heard ?? lead.property_address)
    if (fuzzy) {
      await linkMailRecordToCluster(sb, lead, fuzzy.id, "auto_address", null, fuzzy.prior_pieces ?? null)
      lead.mail_record_id = fuzzy.id
      await creditQuietly(sb, lead.id)
    }
  }
  if (!lead.mail_record_id) return null
  const { data: rec } = await sb.from("mail_records").select(RECORD_COLS).eq("id", lead.mail_record_id).maybeSingle()
  return (rec as OptOutRecord | null) ?? null
}

function dncListFields(rec: OptOutRecord | null, fallbackAddress: string | null, fallbackName: string | null) {
  if (!rec) return { site_address: fallbackAddress, owner_name: fallbackName }
  return {
    parcel_number: rec.parcel_number,
    owner_name: rec.owner_name ?? fallbackName,
    site_address: rec.site_address,
    site_city: rec.site_city,
    site_state: rec.site_address ? "CA" : null,
    site_zip: rec.site_zip,
    mail_address: rec.mail_address,
    mail_city: rec.mail_city,
    mail_state: rec.mail_state,
    mail_zip: rec.mail_zip,
    county: rec.county,
  }
}

export interface MarkDncResult {
  ok: boolean
  error?: string
  /** The mailed record the opt-out was matched to — the address the confirmation names. */
  record: OptOutRecord | null
  /** What they wrote / what triage heard, when no record matched. */
  heardAddress: string | null
}

/**
 * Mark a contact do-not-contact: is_dnc + dead on every row of the cluster,
 * one dnc_list row carrying the matched mailed record's parcel / site /
 * mailing address, queued outreach halted. Idempotent. Alerts Telegram when
 * the flag can't be saved (10-08 → 11-03 it failed silently).
 */
export async function markContactDnc(
  sb: SupabaseClient,
  leadId: string,
  opts: { addedBy: "ai" | "ryan" | "system"; heardAddress?: string | null; reason?: string }
): Promise<MarkDncResult> {
  const { data: lead } = await sb
    .from("leads")
    .select("id, caller_phone, email, gmail_thread_id, name, property_address, campaign_id, mail_record_id")
    .eq("id", leadId)
    .maybeSingle<LeadIdentity>()
  if (!lead) return { ok: false, error: "lead not found", record: null, heardAddress: null }
  const heard = extractStreetAddress(opts.heardAddress) ?? lead.property_address ?? null

  let record: OptOutRecord | null = null
  try {
    record = await matchOptOutAddress(sb, lead, heard)
  } catch (e) {
    console.warn("[dnc] address match failed:", e instanceof Error ? e.message : String(e))
  }

  const { data: rows, error } = await sb
    .from("leads")
    .update({ is_dnc: true, status: "dead", recommended_followup_date: null })
    .or(clusterOr(lead))
    .select("id")
  if (error) {
    const { sendTelegramAlert } = await import("./leads")
    await sendTelegramAlert(`⚠️ DNC flag NOT saved — lead ${leadId} (${lead.caller_phone ?? lead.email ?? "no contact"}): ${error.message}`).catch(() => {})
    return { ok: false, error: error.message, record, heardAddress: heard }
  }
  const ids = (rows ?? []).map(r => r.id as string)
  if (!ids.includes(leadId)) ids.push(leadId)

  // One dnc_list row per contact; enrich it when the address is learned later.
  const { data: existing } = await sb.from("dnc_list").select("id, parcel_number").in("source_lead_id", ids).limit(1)
  if (!existing || existing.length === 0) {
    const { error: insErr } = await sb.from("dnc_list").insert({
      ...dncListFields(record, heard, lead.name),
      source_lead_id: leadId,
      reason: opts.reason ?? "requested",
      added_by: opts.addedBy,
    })
    if (insErr) console.warn(`[dnc] dnc_list insert failed for ${leadId}: ${insErr.message}`)
  } else if (record && !existing[0].parcel_number) {
    await sb.from("dnc_list").update(dncListFields(record, heard, lead.name)).eq("id", existing[0].id)
  }

  try {
    const { haltOutreachForCluster } = await import("./leads")
    await haltOutreachForCluster(sb, { id: leadId, caller_phone: lead.caller_phone, email: lead.email, is_dnc: true })
  } catch (e) {
    console.warn(`[dnc] halt-outreach sweep failed for ${leadId}:`, e instanceof Error ? e.message : String(e))
  }
  return { ok: true, record, heardAddress: heard }
}

/**
 * A DNC'd contact wrote back with a different address ("it's 22 Oak, not
 * 765"). Re-match on what they wrote; when it lands on one mailed record,
 * relink the cluster and move the dnc_list row to it. Returns the new record.
 */
export async function correctOptOutAddress(sb: SupabaseClient, leadId: string, text: string): Promise<OptOutRecord | null> {
  const { data: lead } = await sb
    .from("leads")
    .select("id, caller_phone, email, gmail_thread_id, name, property_address, campaign_id, mail_record_id")
    .eq("id", leadId)
    .maybeSingle<LeadIdentity>()
  if (!lead) return null
  const heard = extractStreetAddress(text)
  if (!heard) return null
  const scope = await campaignScope(sb, lead.campaign_id)
  const { suggestMailRecord } = await import("./mailMatch")
  const exact = await suggestMailRecord(sb, { campaignId: scope, propertyAddress: heard, name: null })
  const rec = exact.record ?? (await fuzzyMailRecordForOptOut(sb, scope, heard))
  if (!rec || rec.id === lead.mail_record_id) return null
  await linkMailRecordToCluster(sb, lead, rec.id, "auto_address", null, rec.prior_pieces ?? null)
  await creditQuietly(sb, lead.id)
  const { data: full } = await sb.from("mail_records").select(RECORD_COLS).eq("id", rec.id).maybeSingle()
  const record = (full as OptOutRecord | null) ?? null
  const { data: rows } = await sb.from("leads").select("id").or(clusterOr(lead))
  const ids = (rows ?? []).map(r => r.id as string)
  const { data: existing } = await sb.from("dnc_list").select("id").in("source_lead_id", ids.length ? ids : [leadId]).limit(1)
  if (existing && existing.length) {
    await sb.from("dnc_list").update(dncListFields(record, heard, lead.name)).eq("id", existing[0].id)
  } else {
    await sb.from("dnc_list").insert({ ...dncListFields(record, heard, lead.name), source_lead_id: leadId, reason: "requested", added_by: "ai" })
  }
  await sb.from("leads").update({ property_address: record?.site_address ? [record.site_address, record.site_city].filter(Boolean).join(", ") : heard }).or(clusterOr(lead))
  return record
}

/** "765 N Branciforte Ave, Santa Cruz" */
export function optOutAddressLine(rec: Pick<OptOutRecord, "site_address" | "site_city"> | null): string | null {
  if (!rec?.site_address) return null
  return [rec.site_address, rec.site_city].filter(Boolean).join(", ")
}

/** True when the Reply Planner draft is the opt-out confirmation (moment hard_no_optout). */
export async function isOptOutConfirmationDraft(sb: SupabaseClient, draftId: string | null | undefined): Promise<boolean> {
  if (!draftId) return false
  const { data } = await sb.from("reply_drafts").select("plan_json").eq("id", draftId).maybeSingle()
  const plan = (data?.plan_json ?? null) as { moment?: string } | null
  return plan?.moment === "hard_no_optout"
}
