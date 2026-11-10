// Mailer credit — "the last campaign they were part of" (Ryan 2026-11-09,
// briefs/BRIEF_MAILER_CREDIT_RULE_2026-11-09.md).
//
// Anyone linked to a MAILED record is a mailer lead, whatever door they came
// through (website form, website number, an old campaign's line, the
// callback number). This module stamps that credit on the person's inbound
// rows. It runs at every intake and after every link write (autoLinkMailRecord
// calls it on every path), and is idempotent.
//
// Rules:
//   - Credit = leads.campaign_id + leads.campaign_via. `source` and
//     `source_type` are never rewritten — they drive the sending mailbox,
//     drip cadence and prompts, and `source_type` is inherited for returning
//     callers, so the door is read from twilio_number + lead_type instead.
//   - Mailed = arm A/B/C and not a seed. arm 'none' (on the list, never
//     mailed) and seeds link but never earn credit.
//   - A mailing takes credit from its first drop date (campaigns.
//     first_drop_date on the list's campaign). Before that: linked, no credit.
//   - Strong links credit automatically (property address, a secondary
//     parcel address, sound-alike from a letter line, Ryan's manual pick).
//     Mailing-address-only and surname-only links wait for Ryan's pick.
//   - Only inbound rows (twilio_number set, or a form) dated on/after the
//     mailing's start, not already in that campaign family. Rows Ryan
//     credited by hand (campaign_via 'manual') and rows of a NEWER campaign
//     are left alone; older rows keep their credit (old campaigns keep their
//     statistic, the tag moves on).
//   - One letter version per person per mailing: once any row is in the
//     family, later credits follow that row's child campaign.
//
// Dependency-free on purpose (no lib/leads, no googleapis): lib/mailMatch
// imports this and the Leads tab imports lib/mailMatch.
import type { SupabaseClient } from "@supabase/supabase-js"
import { isAnonymousCaller } from "./anonymous"
import { pacificDate } from "./pacificDate"

/** = lib/leads WEBSITE_NUMBER (that module can't be imported here). */
export const WEBSITE_LINE = "+16506703914"

export type CampaignVia = "line" | "inherited" | "match" | "manual"

/** Link methods that credit on their own. Everything else waits for Ryan's pick. */
export const STRONG_LINK_METHODS: ReadonlySet<string> = new Set(["auto_address", "auto_parcel", "auto_soundalike", "manual"])

export interface CreditRow {
  id: string
  created_at: string
  twilio_number: string | null
  lead_type: string | null
  campaign_id: string | null
  campaign_via: string | null
  status: string | null
  is_dnc: boolean | null
}

export interface CreditRecord {
  id: string
  campaign_id: string
  piece: string | null
  arm: string | null
  is_seed: boolean | null
}

export interface CreditCampaign {
  id: string
  name: string | null
  parent_campaign_id: string | null
  piece: string | null
  drop_date: string | null
  first_drop_date: string | null
}

export type CreditSkip = "no_record" | "not_mailed" | "weak_match" | "not_started" | "nothing_to_do"

export interface CreditPlan {
  /** Campaign the rows are credited to (the A/B child when there is one). */
  targetId: string | null
  skip: CreditSkip | null
  updates: { id: string; campaign_id: string; campaign_via: CampaignVia }[]
  /** No row of this person was in the family before — first credit for this mailing. */
  newlyCredited: boolean
  /** The earliest stamped row — its door is named in the alert. */
  firstRow: CreditRow | null
  /** Row to reset to New (an old Dead / Nurture lead answering the new letter). */
  resetRowId: string | null
}

export function isInboundRow(r: Pick<CreditRow, "twilio_number" | "lead_type">): boolean {
  return !!r.twilio_number || r.lead_type === "form"
}

export function isMailedRecord(r: Pick<CreditRecord, "arm" | "is_seed">): boolean {
  return !r.is_seed && (r.arm === "A" || r.arm === "B" || r.arm === "C")
}

/** "website form" / "website number" / the email alias / null for other phone lines. */
export function doorLabel(r: Pick<CreditRow, "twilio_number" | "lead_type">): string | null {
  if (r.lead_type === "form") return "website form"
  if (r.twilio_number === WEBSITE_LINE) return "website number"
  if (r.twilio_number?.startsWith("email:")) return `email (${r.twilio_number.slice(6)})`
  return null
}

function familyOf(id: string | null, campaigns: Map<string, CreditCampaign>): string | null {
  if (!id) return null
  const c = campaigns.get(id)
  if (!c) return id
  return c.parent_campaign_id ?? c.id
}

function startOf(familyId: string | null, campaigns: Map<string, CreditCampaign>): string | null {
  if (!familyId) return null
  const c = campaigns.get(familyId)
  return c?.first_drop_date ?? c?.drop_date ?? null
}

const PARKED = new Set(["dead", "nurture"])

/** Pure: who gets credited, to which campaign, and whether the card resets to New. */
export function planMailCredit(input: {
  rows: CreditRow[]
  record: CreditRecord | null
  method: string | null
  campaigns: Map<string, CreditCampaign>
}): CreditPlan {
  const none = (skip: CreditSkip): CreditPlan => ({ targetId: null, skip, updates: [], newlyCredited: false, firstRow: null, resetRowId: null })
  const { rows, record, method, campaigns } = input
  if (!record) return none("no_record")
  if (!isMailedRecord(record)) return none("not_mailed")
  if (!method || !STRONG_LINK_METHODS.has(method)) return none("weak_match")
  const family = record.campaign_id
  const start = campaigns.get(family)?.first_drop_date ?? null
  if (!start) return none("not_started")

  const asc = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const inFamily = asc.filter(r => familyOf(r.campaign_id, campaigns) === family)
  let targetId: string = family
  if (inFamily.length) {
    targetId = inFamily[0].campaign_id as string
  } else if (record.piece) {
    for (const c of Array.from(campaigns.values())) {
      if (c.parent_campaign_id === family && c.piece === record.piece) { targetId = c.id; break }
    }
  }

  const via: CampaignVia = method === "manual" ? "manual" : "match"
  const stamp = asc.filter(r => {
    if (!isInboundRow(r)) return false
    if (pacificDate(new Date(r.created_at)) < start) return false
    if (familyOf(r.campaign_id, campaigns) === family) return false
    if (r.campaign_via === "manual") return false
    // A newer mailing's credit stays put.
    const otherStart = startOf(familyOf(r.campaign_id, campaigns), campaigns)
    if (otherStart && otherStart > start) return false
    return true
  })
  if (!stamp.length) return { ...none("nothing_to_do"), targetId }

  const newlyCredited = inFamily.length === 0
  let resetRowId: string | null = null
  const newestInbound = [...asc].reverse().find(isInboundRow) ?? null
  const hadHistory = asc.some(r => pacificDate(new Date(r.created_at)) < start)
  if (
    newlyCredited && hadHistory && newestInbound &&
    stamp.some(r => r.id === newestInbound.id) &&
    PARKED.has(newestInbound.status ?? "") &&
    !rows.some(r => r.is_dnc)
  ) resetRowId = newestInbound.id

  return {
    targetId,
    skip: null,
    updates: stamp.map(r => ({ id: r.id, campaign_id: targetId, campaign_via: via })),
    newlyCredited,
    firstRow: stamp[0],
    resetRowId,
  }
}

export interface ClusterKeys {
  id: string
  caller_phone: string | null
  email: string | null
  gmail_thread_id?: string | null
}

/** Same person keys as linkMailRecordToCluster: phone OR thread OR email. */
export function clusterOrFilter(lead: ClusterKeys): string {
  const ors = [`id.eq.${lead.id}`]
  if (lead.caller_phone && !isAnonymousCaller(lead.caller_phone)) ors.push(`caller_phone.eq.${lead.caller_phone}`)
  if (lead.gmail_thread_id) ors.push(`gmail_thread_id.eq.${lead.gmail_thread_id}`)
  if (lead.email) ors.push(`email.eq.${lead.email.toLowerCase()}`)
  return ors.join(",")
}

const ROW_COLS = "id, created_at, twilio_number, lead_type, campaign_id, campaign_via, status, is_dnc, mail_record_id, mail_match_method, name"

export interface CreditOutcome extends CreditPlan {
  campaignName: string | null
  piece: string | null
}

/**
 * Credit the person behind `leadId` to the mailing their linked record is on.
 * Best-effort callers wrap this in try/catch; it throws on a write error.
 * `alert: false` skips the Telegram line (the website-form alert already names
 * the mailing; dry runs).
 */
export async function creditMailPerson(
  sb: SupabaseClient,
  leadId: string,
  opts: { alert?: boolean; dryRun?: boolean } = {}
): Promise<CreditOutcome | null> {
  const { data: lead } = await sb.from("leads").select("id, caller_phone, email, gmail_thread_id").eq("id", leadId).maybeSingle()
  if (!lead) return null
  const { data: rowsRaw, error } = await sb.from("leads").select(ROW_COLS).or(clusterOrFilter(lead as ClusterKeys)).limit(1000)
  if (error) throw new Error(`credit: cluster read failed: ${error.message}`)
  const rows = (rowsRaw ?? []) as (CreditRow & { mail_record_id: string | null; mail_match_method: string | null; name: string | null })[]
  const linked = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at)).find(r => r.mail_record_id)
  if (!linked) return null

  const { data: rec } = await sb.from("mail_records").select("id, campaign_id, piece, arm, is_seed").eq("id", linked.mail_record_id).maybeSingle()
  const record = (rec as CreditRecord | null) ?? null
  const ids = new Set<string>(rows.map(r => r.campaign_id).filter((v): v is string => !!v))
  if (record?.campaign_id) ids.add(record.campaign_id)
  const campaigns = new Map<string, CreditCampaign>()
  if (ids.size) {
    const fam = Array.from(ids)
    const { data: cs } = await sb
      .from("campaigns")
      .select("id, name, parent_campaign_id, piece, drop_date, first_drop_date")
      .or(`id.in.(${fam.join(",")}),parent_campaign_id.in.(${fam.join(",")})`)
    for (const c of (cs ?? []) as CreditCampaign[]) campaigns.set(c.id, c)
    // Parents of the rows' child campaigns (their start dates live there).
    const parents = Array.from(campaigns.values()).map(c => c.parent_campaign_id).filter((v): v is string => !!v && !campaigns.has(v))
    if (parents.length) {
      const { data: ps } = await sb.from("campaigns").select("id, name, parent_campaign_id, piece, drop_date, first_drop_date").in("id", parents)
      for (const c of (ps ?? []) as CreditCampaign[]) campaigns.set(c.id, c)
    }
  }

  const plan = planMailCredit({ rows, record, method: linked.mail_match_method, campaigns })
  const target = plan.targetId ? campaigns.get(plan.targetId) ?? null : null
  const outcome: CreditOutcome = { ...plan, campaignName: target?.name ?? null, piece: target?.piece ?? record?.piece ?? null }
  if (opts.dryRun || !plan.updates.length) return outcome

  const byTarget = new Map<string, { via: CampaignVia; ids: string[] }>()
  for (const u of plan.updates) {
    const k = `${u.campaign_id}|${u.campaign_via}`
    if (!byTarget.has(k)) byTarget.set(k, { via: u.campaign_via, ids: [] })
    byTarget.get(k)!.ids.push(u.id)
  }
  for (const [k, g] of Array.from(byTarget.entries())) {
    const campaignId = k.split("|")[0]
    const { error: uErr } = await sb.from("leads").update({ campaign_id: campaignId, campaign_via: g.via }).in("id", g.ids)
    if (uErr) throw new Error(`credit: write failed: ${uErr.message}`)
  }
  if (plan.resetRowId) {
    const { error: rErr } = await sb.from("leads").update({ status: "new", is_junk: false }).eq("id", plan.resetRowId)
    if (rErr) console.warn("[mail-credit] reset to New failed:", rErr.message)
  }
  if (plan.newlyCredited && opts.alert !== false && plan.firstRow) {
    const name = rows.map(r => r.name).find(n => !!n && n.trim()) ?? null
    await alertNewMailerCredit({ name, campaignName: outcome.campaignName, piece: outcome.piece, door: doorLabel(plan.firstRow), reset: !!plan.resetRowId })
  }
  return outcome
}

/**
 * Clear match / manual credit for one mailing family on a person's rows —
 * Ryan unlinked a wrong match or picked another house. Line and inherited
 * credit is never touched.
 */
export async function clearMatchCredit(sb: SupabaseClient, lead: ClusterKeys, familyId: string): Promise<number> {
  const { data: fam } = await sb.from("campaigns").select("id").or(`id.eq.${familyId},parent_campaign_id.eq.${familyId}`)
  const ids = (fam ?? []).map(c => c.id as string)
  if (!ids.length) return 0
  const { data, error } = await sb
    .from("leads")
    .update({ campaign_id: null, campaign_via: null })
    .or(clusterOrFilter(lead))
    .in("campaign_id", ids)
    .in("campaign_via", ["match", "manual"])
    .select("id")
  if (error) throw new Error(`credit clear failed: ${error.message}`)
  return (data ?? []).length
}

/** "📬 Maryam is on NOO Q4 2026 (letter B) — came in on the website number." Best-effort. */
async function alertNewMailerCredit(a: { name: string | null; campaignName: string | null; piece: string | null; door: string | null; reset: boolean }): Promise<void> {
  try {
    const token = process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
    const chatId = process.env.TELEGRAM_CHAT_ID
    if (!token || !chatId) return
    const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    const mailing = (a.campaignName || "a mailing").replace(/\s+—\s+[AB]\s+\(.*\)$/, "")
    const text =
      `📬 <b>${esc(a.name || "This caller")}</b> is on ${esc(mailing)}${a.piece ? ` (letter ${esc(a.piece)})` : ""}` +
      (a.door ? ` — came in on the ${esc(a.door)}.` : ".") +
      (a.reset ? "\nThey were an old lead — back to New." : "")
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    })
    if (!res.ok) console.error(`[mail-credit] alert failed ${res.status}: ${(await res.text()).slice(0, 200)}`)
  } catch (e) {
    console.warn("[mail-credit] alert failed:", e instanceof Error ? e.message : String(e))
  }
}
