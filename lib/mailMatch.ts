// Direct-mail tracking — normalizers + the lead ↔ mailed-record matcher.
//
// The same normalizers run in the list-build importer
// (scripts/import-mail-records.mjs imports this file) so the keys stored on
// mail_records and the keys computed from a caller's words agree exactly.
//
// Match order (Ryan 2026-10-08): site street (+ city when both sides have
// one) → mailing street → owner surname (+ city). Exactly one hit links the
// cluster; several hits are stored as candidates for the card picker; a
// manual link is never overwritten. The whole list is searched, including
// arm = 'none' rows, so an "in the list but not mailed" caller is visible.
import type { SupabaseClient } from "@supabase/supabase-js"

const SUFFIX: Record<string, string> = {
  STREET: "ST", AVENUE: "AVE", DRIVE: "DR", ROAD: "RD", BOULEVARD: "BLVD", COURT: "CT",
  LANE: "LN", PLACE: "PL", CIRCLE: "CIR", TERRACE: "TER", PARKWAY: "PKWY", HIGHWAY: "HWY",
}
const UNIT_RE = /\b(APT|UNIT|STE|SUITE|SPC|SPACE|BLDG|FL|FLOOR|NO)\b.*$/
const NAME_SUFFIX = new Set(["JR", "SR", "II", "III", "IV"])
const TRUST_WORDS = new Set(["TRUST", "TRUSTEE", "TRUSTEES", "TTEE", "TTEES", "REVOCABLE", "LIVING", "FAMILY", "THE", "OF", "ET", "AL", "ETAL"])

export function normText(s: unknown): string {
  return String(s ?? "")
    .toUpperCase()
    .replace(/[^\w\s#]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Street line only: unit dropped, suffixes standardized. "231 Market Pl # 290" → "231 MARKET PL". */
export function normStreet(s: unknown): string {
  let t = normText(s).replace(/#\s*\S+/g, "")
  t = t.replace(UNIT_RE, "")
  return t
    .split(" ")
    .filter(Boolean)
    .map(w => SUFFIX[w] ?? w)
    .join(" ")
    .trim()
}

export function normCity(s: unknown): string {
  return normText(s)
}

/** Last meaningful token of a name: "Donald Teixeira, Trustee" → "TEIXEIRA". */
export function normSurname(s: unknown): string {
  const toks = normText(s)
    .split(" ")
    .filter(t => t && !NAME_SUFFIX.has(t) && !TRUST_WORDS.has(t))
  return toks.length ? toks[toks.length - 1] : ""
}

export function normName(s: unknown): string {
  return normText(s)
}

/** Split a caller's free-text address: "860 24th Ave., Santa Cruz 95062" → street / city / zip. */
export function parseFreeAddress(addr: unknown): { street: string; city: string; zip: string; hasNumber: boolean } {
  const a = String(addr ?? "").trim()
  if (!a) return { street: "", city: "", zip: "", hasNumber: false }
  const zipM = a.match(/\b(\d{5})\b/)
  const zip = zipM ? zipM[1] : ""
  const parts = a.split(",").map(p => p.trim())
  let street = parts[0]
  let rest = parts.slice(1).join(" ")
  rest = rest.replace(/\b(CA|CALIFORNIA)\b/gi, "").replace(/\b\d{5}(-\d{4})?\b/g, "").replace(/\(.*?\)/g, "")
  let city = normCity(rest)
  if (!city && parts.length === 1) {
    const m = street
      .toUpperCase()
      .match(/^(\d+\s+.*?\b(?:ST|STREET|AVE|AVENUE|DR|DRIVE|RD|ROAD|BLVD|CT|COURT|LN|LANE|PL|PLACE|WAY|CIR|CIRCLE|TER|TERRACE))\.?\s+([A-Z ]+?)\s*$/)
    if (m) {
      street = m[1]
      city = normCity(m[2])
    }
  }
  const st = normStreet(street)
  return { street: st, city, zip, hasNumber: /^\d+\s+\S/.test(st) }
}

export type MailMatchMethod = "auto_address" | "auto_mail_address" | "auto_surname" | "manual"

export const MAIL_RECORD_LITE_COLUMNS =
  "id, campaign_id, record_id, owner_name, site_address, site_city, site_zip, mail_address, mail_city, mail_zip, county, arm, batch, is_seed, tenure_bucket, imp_tercile, any_signal, estate_language, family_transfer, out_of_state, multi_parcel_personal"

export interface MailRecordLite {
  id: string
  campaign_id: string
  record_id: string
  owner_name: string | null
  site_address: string | null
  site_city: string | null
  site_zip: string | null
  mail_address: string | null
  mail_city: string | null
  mail_zip: string | null
  county: string | null
  arm: "A" | "B" | "C" | "none" | "seed"
  batch: number | null
  is_seed: boolean
  tenure_bucket: string | null
  imp_tercile: string | null
  any_signal: boolean | null
  estate_language: boolean | null
  family_transfer: boolean | null
  out_of_state: boolean | null
  multi_parcel_personal: boolean | null
}

type MatchRow = MailRecordLite & { site_city_norm: string | null; mail_city_norm: string | null }

export interface MailMatchResult {
  record: MailRecordLite | null
  method: MailMatchMethod | null
  candidates: MailRecordLite[]
}

const CANDIDATE_CAP = 10

function cityFilter(rows: MatchRow[], city: string, side: "site" | "mail" | "either"): MatchRow[] {
  if (!city) return rows
  return rows.filter(r => {
    const s = r.site_city_norm ?? ""
    const m = r.mail_city_norm ?? ""
    if (side === "site") return !s || s === city
    if (side === "mail") return !m || m === city
    return (!s && !m) || s === city || m === city
  })
}

function strip(rows: MatchRow[]): MailRecordLite[] {
  return rows.map(({ site_city_norm: _s, mail_city_norm: _m, ...rest }) => rest)
}

/**
 * Find the mailed record a caller is talking about. `campaignId` scopes the
 * search (null = every campaign with records). Never throws on "no match".
 */
export async function suggestMailRecord(
  sb: SupabaseClient,
  input: { campaignId: string | null; propertyAddress: string | null; name: string | null }
): Promise<MailMatchResult> {
  const cols = `${MAIL_RECORD_LITE_COLUMNS}, site_city_norm, mail_city_norm`
  const fetchBy = async (col: string, value: string): Promise<MatchRow[]> => {
    let q = sb.from("mail_records").select(cols).eq(col, value).limit(50)
    if (input.campaignId) q = q.eq("campaign_id", input.campaignId)
    const { data } = await q
    return (data ?? []) as unknown as MatchRow[]
  }

  const addr = parseFreeAddress(input.propertyAddress)
  if (addr.hasNumber) {
    for (const [col, side, method] of [
      ["site_street_norm", "site", "auto_address"],
      ["mail_line_norm", "mail", "auto_mail_address"],
    ] as const) {
      const rows = cityFilter(await fetchBy(col, addr.street), addr.city, side)
      if (rows.length === 1) return { record: strip(rows)[0], method, candidates: [] }
      if (rows.length > 1) return { record: null, method: null, candidates: strip(rows).slice(0, CANDIDATE_CAP) }
    }
  }

  const surname = normSurname(input.name)
  if (surname && surname.length >= 3) {
    const rows = cityFilter(await fetchBy("owner_surname_norm", surname), addr.city, "either")
    if (rows.length === 1 && addr.city) return { record: strip(rows)[0], method: "auto_surname", candidates: [] }
    if (rows.length >= 1) return { record: null, method: null, candidates: strip(rows).slice(0, CANDIDATE_CAP) }
  }
  return { record: null, method: null, candidates: [] }
}

export interface ClusterIdentityLite {
  id: string
  caller_phone: string | null
  email: string | null
  gmail_thread_id?: string | null
}

const ANON = new Set(["anonymous", "restricted", "unavailable", "private", "unknown"])

/** Write the link (or clear it) on every row that shares the lead's cluster key. Returns rows updated. */
export async function linkMailRecordToCluster(
  sb: SupabaseClient,
  lead: ClusterIdentityLite,
  recordId: string | null,
  method: MailMatchMethod | null,
  candidates: string[] | null = null
): Promise<number> {
  const ors: string[] = []
  if (lead.caller_phone && !ANON.has(lead.caller_phone.trim().toLowerCase())) ors.push(`caller_phone.eq.${lead.caller_phone}`)
  if (lead.gmail_thread_id) ors.push(`gmail_thread_id.eq.${lead.gmail_thread_id}`)
  if (lead.email) ors.push(`email.eq.${lead.email.toLowerCase()}`)
  const patch = {
    mail_record_id: recordId,
    mail_match_method: recordId ? method : null,
    mail_match_candidates: recordId ? null : candidates && candidates.length ? candidates : null,
  }
  let q = sb.from("leads").update(patch).select("id")
  q = ors.length ? q.or(`id.eq.${lead.id},${ors.join(",")}`) : q.eq("id", lead.id)
  const { data, error } = await q
  if (error) throw new Error(`mail-record link failed: ${error.message}`)
  return (data ?? []).length
}

/**
 * Auto-suggest after triage or a manual edit fills name / property_address.
 * Best-effort: callers wrap it in try/catch. Skips manual links and already
 * linked clusters.
 */
export async function autoLinkMailRecord(sb: SupabaseClient, leadId: string): Promise<MailMatchResult | null> {
  const { data: lead } = await sb
    .from("leads")
    .select("id, caller_phone, email, gmail_thread_id, name, property_address, campaign_id, mail_record_id, mail_match_method")
    .eq("id", leadId)
    .maybeSingle()
  if (!lead) return null
  if (lead.mail_record_id || lead.mail_match_method === "manual") return null
  // Any sibling already linked (manual or auto) → inherit instead of re-matching.
  // Runs before the name/address check so a fresh event row from a returning
  // caller picks up the cluster's link at intake, like source/status do.
  const ors: string[] = []
  if (lead.caller_phone && !ANON.has(String(lead.caller_phone).trim().toLowerCase())) ors.push(`caller_phone.eq.${lead.caller_phone}`)
  if (lead.gmail_thread_id) ors.push(`gmail_thread_id.eq.${lead.gmail_thread_id}`)
  if (lead.email) ors.push(`email.eq.${String(lead.email).toLowerCase()}`)
  if (ors.length) {
    const { data: sib } = await sb
      .from("leads")
      .select("mail_record_id, mail_match_method")
      .or(ors.join(","))
      .not("mail_record_id", "is", null)
      .limit(1)
    if (sib && sib.length) {
      await linkMailRecordToCluster(sb, lead, sib[0].mail_record_id, (sib[0].mail_match_method as MailMatchMethod) ?? "manual")
      return null
    }
  }
  if (!lead.property_address && !lead.name) return null
  const result = await suggestMailRecord(sb, {
    campaignId: lead.campaign_id ?? null,
    propertyAddress: lead.property_address,
    name: lead.name,
  })
  if (result.record) {
    await linkMailRecordToCluster(sb, lead, result.record.id, result.method)
  } else if (result.candidates.length) {
    await linkMailRecordToCluster(sb, lead, null, null, result.candidates.map(c => c.id))
  }
  return result
}
