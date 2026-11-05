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
// A/B piece children (2026-10-12) search their parent's list — see
// mailSearchCampaignId.
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

/**
 * Assessor parcel number key: uppercase, keep only [0-9A-Z].
 * "050-273-520" → "050273520", "058 702 030" → "058702030". Used by the
 * vendor v2 join (scripts/join-mail-records-v2.mjs) to match a re-pulled
 * county file back onto mail_records.parcel_number / parcels.
 */
export function normApn(s: unknown): string {
  return String(s ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "")
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

export type MailMatchMethod = "auto_address" | "auto_mail_address" | "auto_surname" | "auto_soundalike" | "manual"

export const MAIL_RECORD_LITE_COLUMNS =
  "id, campaign_id, record_id, owner_name, site_address, site_city, site_zip, mail_address, mail_city, mail_zip, county, arm, batch, is_seed, piece, tenure_bucket, imp_tercile, any_signal, estate_language, family_transfer, out_of_state, multi_parcel_personal, prior_pieces"

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
  // Letters this owner got from the drops before the campaign (2026-10-24).
  prior_pieces?: number | null
  /** Creative mailed (NOO Q4 2026 A/B: A = bullets, B = prose); null when the list has no split. */
  piece: string | null
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
  /** Linked on street alone: the heard city disagreed with the list, so the card's city is wrong. */
  cityCorrected?: boolean
  /** Linked by sound (see soundAlikeMatch): the card's street — and maybe the surname — was misheard. */
  soundCorrected?: boolean
}

const CANDIDATE_CAP = 10
// Sound-alike near-misses offered on the card and in the Telegram alert.
const SOUND_CANDIDATE_CAP = 5

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

// ── Sound-alike matching (2026-11-04) ──────────────────────────────────────
// Transcription mishears street names and surnames: a Jackie call heard
// "Bieber Dr" as "Viber Drive" and the owner's surname with an F for its V,
// matched nothing, and the card kept an address that doesn't exist.
// Every caller on a mailer line is answering a letter, so the mailed list is
// the lookup: same house number on that list, then the street that sounds
// like what was heard, with the owner's name as the second witness.

// Consonant classes that speech-to-text swaps (B/V/F/P, D/T, …). Vowels, H,
// W and Y carry no class.
const SOUND_CLASS: Record<string, string> = {
  B: "B", P: "B", F: "B", V: "B",
  C: "K", K: "K", Q: "K", G: "K", J: "K", X: "K",
  S: "S", Z: "S", D: "T", T: "T", M: "N", N: "N", L: "L", R: "R",
}

/** Consonant skeleton by sound class: BIEBER and VIBER are both "BBR". */
export function soundKey(word: unknown): string {
  let out = ""
  let prev = ""
  for (const ch of normText(word).replace(/[^A-Z]/g, "")) {
    const c = SOUND_CLASS[ch] ?? ""
    if (c && c !== prev) out += c
    prev = c
  }
  return out
}

// Edits between two words; two swapped letters ("Beiber") count as one.
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, x) => [x, ...Array(b.length).fill(0)])
  for (let y = 1; y <= b.length; y++) d[0][y] = y
  for (let x = 1; x <= a.length; x++)
    for (let y = 1; y <= b.length; y++) {
      d[x][y] = Math.min(d[x - 1][y] + 1, d[x][y - 1] + 1, d[x - 1][y - 1] + (a[x - 1] === b[y - 1] ? 0 : 1))
      if (x > 1 && y > 1 && a[x - 1] === b[y - 2] && a[x - 2] === b[y - 1]) d[x][y] = Math.min(d[x][y], d[x - 2][y - 2] + 1)
    }
  return d[a.length][b.length]
}

/** How alike two words are: `spelling` by letters, `sound` also counting the consonant skeleton. Both 0–1. */
export function soundAlike(a: unknown, b: unknown): { spelling: number; sound: number } {
  const x = normText(a).replace(/\s+/g, "")
  const y = normText(b).replace(/\s+/g, "")
  if (!x || !y) return { spelling: 0, sound: 0 }
  if (x === y) return { spelling: 1, sound: 1 }
  // "24TH" vs "25TH" are different streets however close they look.
  if (/\d/.test(x) || /\d/.test(y)) return { spelling: 0, sound: 0 }
  const spelling = 1 - editDistance(x, y) / Math.max(x.length, y.length)
  const kx = soundKey(x)
  const ky = soundKey(y)
  const key = kx.length >= 2 && ky.length >= 2 ? 1 - editDistance(kx, ky) / Math.max(kx.length, ky.length) : 0
  return { spelling, sound: Math.max(spelling, key * 0.9) }
}

const STREET_SUFFIXES = new Set([...Object.values(SUFFIX), "WAY", "TRL", "EXPY", "SQ", "ALY", "PLZ", "XING", "LOOP", "ROW", "WALK"])
const LEADING_DIR = new Set(["N", "S", "E", "W", "NORTH", "SOUTH", "EAST", "WEST"])

/** "314 N CREEK DR" → { num: "314", name: "CREEK" }; multi-word names are joined. */
export function streetParts(streetNorm: string): { num: string; name: string } {
  const w = streetNorm.split(" ").filter(Boolean)
  const num = /^\d+[A-Z]?$/.test(w[0] ?? "") ? w.shift()! : ""
  if (w.length > 1 && LEADING_DIR.has(w[0])) w.shift()
  if (w.length > 1 && STREET_SUFFIXES.has(w[w.length - 1])) w.pop()
  return { num, name: w.join("") }
}

/** Best sound-alike between a heard name's words and the owner-name tokens. 0–1. */
function nameSupport(heardName: string | null, ownerName: string | null): number {
  const heard = normName(heardName).split(" ").filter(t => t.length >= 3)
  const owner = ownerNameTokens(ownerName)
  let best = 0
  for (const h of heard) for (const o of owner) best = Math.max(best, soundAlike(h, o).sound)
  return best
}

export interface SoundAlikeRow {
  site_street_norm: string | null
  site_city_norm: string | null
  owner_name: string | null
}

/**
 * Among the list's records at the heard house number, the one the caller
 * meant — or none. A wrong correction is worse than an unmatched card, so a
 * record qualifies only with two witnesses: the street sounds alike AND the
 * owner's name does, or the street is nearly the same spelling in the same
 * city. Exactly one qualifier wins; otherwise the near ones come back as
 * candidates for the card picker (closest first).
 */
export function soundAlikeMatch<T extends SoundAlikeRow>(
  heard: { street: string; city: string; name: string | null },
  rows: T[]
): { winner: T | null; near: T[] } {
  const h = streetParts(heard.street)
  if (!h.num || !h.name) return { winner: null, near: [] }
  const scored = rows
    .map(r => {
      const p = streetParts(r.site_street_norm ?? "")
      if (p.num !== h.num || !p.name) return null
      const st = soundAlike(h.name, p.name)
      const name = nameSupport(heard.name, r.owner_name)
      const cityOk = !heard.city || !r.site_city_norm || r.site_city_norm === heard.city
      const qualified = (st.sound >= 0.6 && name >= 0.75) || (st.spelling >= 0.75 && cityOk)
      const near = st.sound >= 0.5 || name >= 0.75
      return { r, qualified, near, score: st.sound + name * 0.5 + (cityOk ? 0.1 : 0) }
    })
    .filter((x): x is NonNullable<typeof x> => !!x && x.near)
    .sort((a, b) => b.score - a.score)
  const qualified = scored.filter(x => x.qualified)
  return { winner: qualified.length === 1 ? qualified[0].r : null, near: scored.map(x => x.r) }
}

/**
 * The surname as the list spells it, when the heard one only sounds like
 * it: ("Carol Fardell", "Carol Vardell & The … Trust") → "Carol
 * Vardell". Null when the surname already matches or nothing sounds alike —
 * a relative calling for the owner keeps their own name.
 */
export function soundAlikeName(heardName: string | null, ownerName: string | null): string | null {
  const words = String(heardName ?? "").trim().split(/\s+/).filter(Boolean)
  if (words.length < 2) return null
  const surname = normText(words[words.length - 1])
  if (surname.length < 3) return null
  const first = normText(words[0])
  const owner = ownerNameTokens(ownerName)
  if (owner.includes(surname)) return null
  let best: { token: string; sim: number } | null = null
  for (const o of owner) {
    if (o === first) continue
    const sim = soundAlike(surname, o).sound
    if (sim >= 0.75 && (!best || sim > best.sim)) best = { token: o, sim }
  }
  if (!best) return null
  const proper = best.token.charAt(0) + best.token.slice(1).toLowerCase()
  return [...words.slice(0, -1), proper].join(" ")
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
      const all = await fetchBy(col, addr.street)
      const rows = cityFilter(all, addr.city, side)
      if (rows.length === 1) return { record: strip(rows)[0], method, candidates: [] }
      if (rows.length > 1) return { record: null, method: null, candidates: strip(rows).slice(0, CANDIDATE_CAP) }
      // Transcription mishears city names (2026-11-03: "Los Gatos" → "Las
      // Vegas"; we don't buy outside the Bay Area). Within one mailed list,
      // a street number + name that hits exactly one house is that house.
      if (side === "site" && input.campaignId && addr.city && all.length === 1) {
        return { record: strip(all)[0], method, candidates: [], cityCorrected: true }
      }
    }
  }

  // Nothing at that exact street: same house number on this list, then the
  // street that sounds like what was heard (soundAlikeMatch).
  let near: MatchRow[] = []
  const num = streetParts(addr.street).num
  if (addr.hasNumber && input.campaignId && num) {
    const { data } = await sb
      .from("mail_records")
      .select(`${cols}, site_street_norm`)
      .eq("campaign_id", input.campaignId)
      .like("site_street_norm", `${num} %`)
      .limit(200)
    const rows = (data ?? []) as unknown as (MatchRow & { site_street_norm: string | null })[]
    const m = soundAlikeMatch({ street: addr.street, city: addr.city, name: input.name }, rows)
    const lite = (r: MatchRow & { site_street_norm: string | null }): MatchRow => {
      const { site_street_norm: _n, ...rest } = r
      return rest
    }
    if (m.winner) return { record: strip([lite(m.winner)])[0], method: "auto_soundalike", candidates: [], soundCorrected: true }
    near = m.near.map(lite)
  }

  const surname = normSurname(input.name)
  if (surname && surname.length >= 3) {
    const rows = cityFilter(await fetchBy("owner_surname_norm", surname), addr.city, "either")
    if (rows.length === 1 && addr.city) return { record: strip(rows)[0], method: "auto_surname", candidates: [] }
    if (rows.length >= 1) return { record: null, method: null, candidates: strip(rows).slice(0, CANDIDATE_CAP) }
  }
  return { record: null, method: null, candidates: strip(near).slice(0, SOUND_CANDIDATE_CAP) }
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
  candidates: string[] | null = null,
  // The linked record's prior_pieces, when the caller has the record: the
  // lead's touch count = prior drops + the letter being answered.
  priorPieces: number | null = null
): Promise<number> {
  const ors: string[] = []
  if (lead.caller_phone && !ANON.has(lead.caller_phone.trim().toLowerCase())) ors.push(`caller_phone.eq.${lead.caller_phone}`)
  if (lead.gmail_thread_id) ors.push(`gmail_thread_id.eq.${lead.gmail_thread_id}`)
  if (lead.email) ors.push(`email.eq.${lead.email.toLowerCase()}`)
  const patch: Record<string, unknown> = {
    mail_record_id: recordId,
    mail_match_method: recordId ? method : null,
    mail_match_candidates: recordId ? null : candidates && candidates.length ? candidates : null,
  }
  if (recordId && typeof priorPieces === "number") patch.mail_pieces_before = priorPieces + 1
  let q = sb.from("leads").update(patch).select("id")
  q = ors.length ? q.or(`id.eq.${lead.id},${ors.join(",")}`) : q.eq("id", lead.id)
  const { data, error } = await q
  if (error) throw new Error(`mail-record link failed: ${error.message}`)
  return (data ?? []).length
}

export interface CampaignScopeLite {
  id: string
  parent_campaign_id: string | null
  piece: string | null
}

/**
 * Which campaign's mail_records to search for a lead attributed to
 * `campaign`. A/B piece children (NOO Q4 2026 — A / — B) own no records: the
 * one list lives on the parent, so a child scopes to its parent. A parent
 * (or a campaign that is nobody's child) scopes to itself. Unknown campaign
 * → the lead's own campaign_id, as before.
 */
export function mailSearchCampaignId(campaign: CampaignScopeLite | null, leadCampaignId: string | null): string | null {
  if (!campaign) return leadCampaignId
  return campaign.parent_campaign_id ?? campaign.id
}

/**
 * True when the lead's campaign says one creative (the dialed line / emailed
 * alias) but the matched record was mailed the other. Null on either side =
 * nothing to compare (pre-split rows, lists without a piece split).
 */
export function isPieceMismatch(campaignPiece: string | null | undefined, recordPiece: string | null | undefined): boolean {
  if (!campaignPiece || !recordPiece) return false
  return campaignPiece.trim().toUpperCase() !== recordPiece.trim().toUpperCase()
}

/**
 * Lead-card chip text for a piece mismatch — "⚠ piece mismatch (record B,
 * line A)" — or null when the two agree / either side is unknown. "line" is
 * the campaign the lead is attributed to (the dialed line or emailed alias
 * decides the piece); "record" is the mailed record the cluster is linked to.
 */
export function pieceMismatchLabel(campaignPiece: string | null | undefined, recordPiece: string | null | undefined): string | null {
  if (!isPieceMismatch(campaignPiece, recordPiece)) return null
  return `⚠ piece mismatch (record ${String(recordPiece).trim().toUpperCase()}, line ${String(campaignPiece).trim().toUpperCase()})`
}

/**
 * Auto-suggest after triage or a manual edit fills name / property_address.
 * Best-effort: callers wrap it in try/catch. Skips manual links and already
 * linked clusters.
 *
 * Search scope: the lead's campaign, or its parent when the campaign is an
 * A/B piece child (the records are on the parent). When the matched
 * record's `piece` disagrees with the child campaign's `piece`, the link is
 * kept as-is (the line/alias decides attribution; the record is the
 * cross-check) and a `[mail-match] piece mismatch` warning is logged.
 */
export async function autoLinkMailRecord(
  sb: SupabaseClient,
  leadId: string,
  // `alert: false` — the opt-out path runs its own looser match right after
  // and must not announce a miss it is about to resolve.
  opts: { alert?: boolean } = {}
): Promise<MailMatchResult | null> {
  const { data: lead } = await sb
    .from("leads")
    .select("id, caller_phone, email, gmail_thread_id, name, property_address, campaign_id, mail_record_id, mail_match_method, mail_match_candidates, source, source_type")
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
  let campaign: CampaignScopeLite | null = null
  if (lead.campaign_id) {
    const { data: c } = await sb
      .from("campaigns")
      .select("id, parent_campaign_id, piece")
      .eq("id", lead.campaign_id)
      .maybeSingle()
    campaign = (c as CampaignScopeLite | null) ?? null
  }
  const scope = mailSearchCampaignId(campaign, lead.campaign_id ?? null)
  const result = await suggestMailRecord(sb, {
    campaignId: scope,
    propertyAddress: lead.property_address,
    name: lead.name,
  })
  if (result.record) {
    if (isPieceMismatch(campaign?.piece, result.record.piece)) {
      console.warn(
        `[mail-match] piece mismatch: lead ${lead.id} campaign ${campaign?.id} piece ${campaign?.piece} ` +
          `matched record ${result.record.record_id} (${result.record.id}) piece ${result.record.piece} via ${result.method}`
      )
    }
    await linkMailRecordToCluster(sb, lead, result.record.id, result.method, null, result.record.prior_pieces ?? null)
    if (result.cityCorrected || result.soundCorrected) await correctLeadFromRecord(sb, lead, ors, result.record, !!result.soundCorrected)
  } else {
    // A mailer caller gave an address the list can't place — Ryan clears it
    // up from Telegram (2026-11-04). Once per contact: the candidates column
    // doubles as the "already told him" mark ([] when nothing came close).
    const unplaced = lead.source_type === "direct_mail" && !!lead.campaign_id && parseFreeAddress(lead.property_address).hasNumber
    let told = lead.mail_match_candidates != null
    if (unplaced && !told && ors.length) {
      const { data: sib } = await sb.from("leads").select("id").or(ors.join(",")).not("mail_match_candidates", "is", null).limit(1)
      told = !!sib?.length
    }
    let tell = unplaced && !told && opts.alert !== false
    // Mailers from before the lists were imported have nothing to match against.
    if (tell) {
      const { data: any } = await sb.from("mail_records").select("id").eq("campaign_id", scope).limit(1)
      tell = !!any?.length
    }
    if (result.candidates.length) {
      await linkMailRecordToCluster(sb, lead, null, null, result.candidates.map(c => c.id))
    } else if (tell) {
      const q = sb.from("leads").update({ mail_match_candidates: [] })
      await (ors.length ? q.or(`id.eq.${lead.id},${ors.join(",")}`) : q.eq("id", lead.id))
    }
    if (tell) await alertUnplacedAddress(lead, result.candidates)
  }
  return result
}

/**
 * Telegram: a mailer caller's address isn't on the list as heard.
 * Best-effort. Posts straight to the lead-alert bot (same token + chat as
 * lib/leads sendTelegramAlert) instead of importing lib/leads: the Leads
 * tab imports this file, and even a dynamic import of lib/leads drags
 * googleapis into the browser bundle and fails the build.
 */
async function alertUnplacedAddress(
  lead: { name: string | null; caller_phone: string | null; email: string | null; property_address: string | null; source: string | null },
  candidates: MailRecordLite[]
): Promise<void> {
  try {
    const token = process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
    const chatId = process.env.TELEGRAM_CHAT_ID
    if (!token || !chatId) { console.warn("[mail-match] unplaced-address alert skipped: no Telegram bot token / chat id"); return }
    const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    const who = [lead.name, lead.caller_phone ?? lead.email].filter(Boolean).join(" — ") || "Unknown caller"
    const lines = [
      `📬 Couldn't place this address on the mailing list${lead.source ? ` — <b>${esc(lead.source)}</b>` : ""}`,
      `<b>${esc(who)}</b>`,
      `Heard: "${esc(lead.property_address)}"`,
      "",
    ]
    if (candidates.length) {
      lines.push("Closest on the list:")
      for (const c of candidates) lines.push(`• ${esc(mailRecordSiteLine(c) ?? "?")} — ${esc(c.owner_name ?? "owner unknown")}`)
      lines.push("", "Pick the right one with “Link mailed record” on the card.")
    } else {
      lines.push("Nothing close at that house number. Search for it with “Link mailed record” on the card.")
    }
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: lines.join("\n"), parse_mode: "HTML" }),
    })
    if (!res.ok) console.error(`[mail-match] unplaced-address alert failed ${res.status}: ${(await res.text()).slice(0, 200)}`)
  } catch (e) {
    console.warn("[mail-match] unplaced-address alert failed:", e instanceof Error ? e.message : String(e))
  }
}

/** "140 Johnson Ave, Los Gatos, CA 95030" from the mailed record. */
export function mailRecordSiteLine(r: Pick<MailRecordLite, "site_address" | "site_city" | "site_zip">): string | null {
  if (!r.site_address) return null
  if (!r.site_city && !r.site_zip) return r.site_address
  return [r.site_address, r.site_city, ["CA", r.site_zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")
}

/**
 * The card heard it wrong: rewrite the lead's address (and the matching
 * property chip) from the mailed record. On a sound-alike match the street
 * itself was misheard, so the chip's notes keep what was heard, and a
 * surname that only sounds like the owner's is respelled on every row of
 * the contact that carries it. Best-effort.
 */
async function correctLeadFromRecord(
  sb: SupabaseClient,
  lead: { id: string; name: string | null; property_address: string | null },
  clusterOrs: string[],
  record: MailRecordLite,
  sound: boolean
): Promise<void> {
  const heard = lead.property_address
  const fixed = mailRecordSiteLine(record)
  if (!fixed || !heard) return
  const fixedName = sound ? soundAlikeName(lead.name, record.owner_name) : null
  const note = sound
    ? `Heard as "${[fixedName ? lead.name : null, heard].filter(Boolean).join(", ")}"; corrected from the mailing list.`
    : null
  const { data } = await sb.from("leads").select("property_details").eq("id", lead.id).maybeSingle()
  const details = Array.isArray(data?.property_details) ? (data.property_details as Array<{ label?: string | null; notes?: string | null }>) : null
  const patch: Record<string, unknown> = { property_address: fixed }
  if (details?.some(d => d.label === heard)) {
    patch.property_details = details.map(d =>
      d.label === heard ? { ...d, label: fixed, notes: note ? [d.notes, note].filter(Boolean).join(" ") : d.notes } : d)
  } else if (note) {
    patch.property_details = [...(details ?? []), { label: fixed, notes: note }]
  }
  if (fixedName) patch.name = fixedName
  const { error } = await sb.from("leads").update(patch).eq("id", lead.id).eq("property_address", heard)
  if (error) { console.error(`[mail-match] correction failed for ${lead.id}: ${error.message}`); return }
  console.warn(`[mail-match] lead ${lead.id}: heard "${heard}", mailed record ${record.record_id} says "${fixed}"${fixedName ? `; name "${lead.name}" → "${fixedName}"` : ""}`)
  if (fixedName && lead.name && clusterOrs.length) {
    const { error: nameErr } = await sb.from("leads").update({ name: fixedName }).or(clusterOrs.join(",")).eq("name", lead.name)
    if (nameErr) console.error(`[mail-match] name correction failed for ${lead.id}: ${nameErr.message}`)
  }
}

/**
 * Website form leads carry no campaign_id — the form isn't a mailer line —
 * so Campaign Performance never counted a mailer recipient who answered on
 * lrghomes.com (Maryam Norton, NOO Q4 B, 2026-11-02). Once the cluster is
 * linked to a mailed record, credit its website form rows to that record's
 * campaign: the A/B piece child when the list is split (record.piece), else
 * the list's own campaign. Only website FORM rows are written — a call or
 * text to a mailer line keeps that line's attribution on its own row — so a
 * re-link moves the credit and an unlink (null) clears it. Returns the
 * campaign id written, or null.
 */
export async function creditWebsiteFormToMailCampaign(
  sb: SupabaseClient,
  lead: ClusterIdentityLite,
  recordId: string | null
): Promise<string | null> {
  const ors: string[] = []
  if (lead.caller_phone && !ANON.has(lead.caller_phone.trim().toLowerCase())) ors.push(`caller_phone.eq.${lead.caller_phone}`)
  if (lead.email) ors.push(`email.eq.${lead.email.toLowerCase()}`)
  const scope = ors.length ? `id.eq.${lead.id},${ors.join(",")}` : `id.eq.${lead.id}`

  if (!recordId) {
    // Unlink: drop the campaign credit from website form rows (they never
    // have one of their own).
    const { error } = await sb.from("leads").update({ campaign_id: null })
      .or(scope).eq("lead_type", "form").eq("source_type", "website")
    if (error) throw new Error(`website campaign clear failed: ${error.message}`)
    return null
  }

  const { data: rec } = await sb.from("mail_records").select("campaign_id, piece").eq("id", recordId).maybeSingle()
  if (!rec?.campaign_id) return null
  let campaignId = rec.campaign_id as string
  if (rec.piece) {
    const { data: child } = await sb
      .from("campaigns")
      .select("id")
      .eq("parent_campaign_id", rec.campaign_id)
      .eq("piece", rec.piece)
      .limit(1)
    if (child?.[0]?.id) campaignId = child[0].id as string
  }
  const { error } = await sb.from("leads").update({ campaign_id: campaignId })
    .or(scope).eq("lead_type", "form").eq("source_type", "website")
  if (error) throw new Error(`website campaign credit failed: ${error.message}`)
  return campaignId
}

// ─── DNC mail scrub helpers (scripts/dnc-mail-scrub.mjs, 2026-11-03) ───────
// Append-only: the keys stored on mail_records (normStreet) are unchanged.
// The scrub compares raw addresses on both sides through normStreetDir, so
// "765 North Branciforte Avenue" and "765 N Branciforte Ave" agree.

const DIRECTION: Record<string, string> = {
  NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W",
  NORTHEAST: "NE", NORTHWEST: "NW", SOUTHEAST: "SE", SOUTHWEST: "SW",
}
export const DIRECTIONALS = new Set(["N", "S", "E", "W", "NE", "NW", "SE", "SW"])
const SUFFIX_EXTRA: Record<string, string> = {
  AV: "AVE", TRAIL: "TRL", EXPRESSWAY: "EXPY", SQUARE: "SQ", ALLEY: "ALY", PLAZA: "PLZ",
  POINT: "PT", CROSSING: "XING", HEIGHTS: "HTS", MOUNT: "MT",
}

/** normStreet + directionals (NORTH → N) + a wider suffix map; parentheticals dropped. */
export function normStreetDir(s: unknown): string {
  const t = normStreet(String(s ?? "").replace(/\(.*?\)/g, " "))
  return t
    .split(" ")
    .filter(Boolean)
    .map(w => DIRECTION[w] ?? SUFFIX_EXTRA[w] ?? w)
    .join(" ")
}

const NAME_NOISE = new Set([
  "AND", "MR", "MRS", "MS", "MISS", "DR",
  "INC", "LLC", "LP", "LTD", "CO", "CORP", "CORPORATION", "COMPANY", "ESTATE", "DECEASED",
])

/** Owner-name tokens with trust words, suffixes, initials and entity noise stripped. */
export function ownerNameTokens(s: unknown): string[] {
  const out = new Set<string>()
  for (const t of normName(s).split(" ")) {
    if (t.length < 2 || /\d/.test(t) || t.includes("#")) continue
    if (TRUST_WORDS.has(t) || NAME_SUFFIX.has(t) || NAME_NOISE.has(t)) continue
    out.add(t)
  }
  return Array.from(out)
}
