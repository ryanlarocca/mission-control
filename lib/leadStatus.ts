import type { SupabaseClient } from "@supabase/supabase-js"
import {
  fetchClusterHistory,
  getLeadsClient,
  haltOutreachForCluster,
  isOutbound,
  type LeadStatus,
} from "@/lib/leads"
import { isAnonymousCaller } from "@/lib/anonymous"
import { completeText, extractJsonObject, hasLlmKey, OPUS } from "@/lib/llm"

// Automatic lead status (Ryan 2026-10-24). Ryan stopped keeping New / Active
// / Nurture current by hand — "busy work". The rules, agreed in chat:
//
//   → Active   the person is a LEAD: owns a property, wants to sell soon
//              enough to work now (~12 months), open to Ryan's kind of offer.
//              Also any milestone (appointment / offer / pending).
//   → Nurture  "not now" / "maybe next year" / retail-only and won't budge /
//              a polite no; OR quiet: Ryan reached out and got no reply for
//              30 days (quiet only ever moves Active → Nurture, never Dead).
//   → Dead     sold the property / doesn't own it, or wrong person. Removal
//              requests already go Dead through the DNC path (unchanged).
//
// Guardrails: a status Ryan set by hand wins until something new happens on
// the cluster; DNC clusters and Pending / Closed deals are never touched;
// every move is logged in lead_status_events and summarised once a day on
// Telegram with an undo button (lib/leadStatusDigest).
//
// Status lives where the card reads it: the cluster's most recent INBOUND
// row (LeadsTab groupLeads → statusSource). Status does NOT touch drips:
// Ryan retired "Active pauses the drip" the same night (only Dead stops one,
// DRIP_STOP_STATUSES).
//
// LEAD_AUTO_STATUS=on applies moves. Anything else runs in shadow: the move
// is logged with applied=false and nothing changes — that is how the first
// cleanup list for Ryan was built before he switched it on.

export const QUIET_DAYS = 30

export type LeadStage = "lead" | "not_now" | "sold" | "wrong_person" | "unclear"
export type AutoRule = "lead" | "not_now" | "sold" | "wrong_person" | "quiet_30d"

export function autoStatusEnabled(): boolean {
  return (process.env.LEAD_AUTO_STATUS || "").trim().toLowerCase() === "on"
}

export interface ClusterRow {
  id: string
  created_at: string
  twilio_number: string | null
  caller_phone: string | null
  email: string | null
  gmail_thread_id?: string | null
  name?: string | null
  status: LeadStatus
  is_dnc?: boolean | null
  is_junk?: boolean | null
  status_set_by?: string | null
  status_set_at?: string | null
  became_lead_at?: string | null
  appointment_at?: string | null
  pending_at?: string | null
  deal_closed_at?: string | null
  offer_verbalized_at?: string | null
}

const CLUSTER_COLS =
  "id, created_at, twilio_number, caller_phone, email, gmail_thread_id, name, status, is_dnc, is_junk, status_set_by, status_set_at, became_lead_at, appointment_at, pending_at, deal_closed_at, offer_verbalized_at"

/** Every row of the person `row` belongs to — same keying as the card. */
export async function fetchClusterRows(sb: SupabaseClient, row: { id: string; caller_phone: string | null; email: string | null; gmail_thread_id?: string | null }): Promise<ClusterRow[]> {
  let q = sb.from("leads").select(CLUSTER_COLS)
  if (row.caller_phone && !isAnonymousCaller(row.caller_phone)) q = q.eq("caller_phone", row.caller_phone)
  else if (row.gmail_thread_id) q = q.eq("gmail_thread_id", row.gmail_thread_id)
  else if (row.email) q = q.ilike("email", row.email)
  else q = q.eq("id", row.id)
  const { data, error } = await q.order("created_at", { ascending: true }).limit(500)
  if (error) throw new Error(`cluster read failed: ${error.message}`)
  return (data ?? []) as ClusterRow[]
}

/** The row the card's status chip reads and the dropdown writes. */
export function statusAnchor(rows: ClusterRow[]): ClusterRow | null {
  if (rows.length === 0) return null
  const newestFirst = [...rows].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  return newestFirst.find((r) => !isOutbound(r)) ?? newestFirst[0]
}

export interface ClusterFacts {
  current: LeadStatus
  isDnc: boolean
  dealLocked: boolean          // pending or closed — Ryan's call only
  hasMilestone: boolean        // appointment / offer / pending
  ryanSetAt: number | null     // when Ryan last set the status by hand
  latestEventAt: number        // newest row of any direction
}

export function clusterFacts(rows: ClusterRow[], anchor: ClusterRow): ClusterFacts {
  return {
    current: anchor.status,
    isDnc: rows.some((r) => !!r.is_dnc),
    dealLocked: rows.some((r) => !!r.pending_at || !!r.deal_closed_at),
    hasMilestone: rows.some((r) => !!r.appointment_at || !!r.offer_verbalized_at || !!r.pending_at),
    ryanSetAt: anchor.status_set_by === "ryan" && anchor.status_set_at ? new Date(anchor.status_set_at).getTime() : null,
    latestEventAt: Math.max(...rows.map((r) => new Date(r.created_at).getTime())),
  }
}

/** Pure: given the AI's read of the person, where should the status go?
 *  null = leave it alone. */
export function decideStageMove(facts: ClusterFacts, stage: LeadStage): { to: LeadStatus; rule: AutoRule } | null {
  if (facts.isDnc || facts.dealLocked) return null
  // Ryan's hand-set status holds until something new happened after it.
  if (facts.ryanSetAt != null && facts.latestEventAt <= facts.ryanSetAt) return null
  const cur = facts.current
  const effective: LeadStage = facts.hasMilestone && stage !== "sold" && stage !== "wrong_person" ? "lead" : stage
  switch (effective) {
    case "lead":
      return cur === "active" ? null : { to: "active", rule: "lead" }
    case "not_now":
      return cur === "new" || cur === "contacted" || cur === "active" ? { to: "nurture", rule: "not_now" } : null
    case "sold":
    case "wrong_person":
      return cur === "dead" ? null : { to: "dead", rule: effective }
    default:
      return null
  }
}

/** Pure: the 30-day quiet rule for an Active person. Clock starts at Ryan's
 *  first outreach after their last message (or at his hand-set, if later). */
// `personal` = Ryan's personal-cell texts with this person from The Pile
// (chat.db on the mini). Those never reach `leads`, so without them a seller
// Ryan texts from his own phone looked "quiet for 159 days" (Candace,
// 2026-10-24 — they had texted four days earlier).
export interface PersonalTexts { inbound: number[]; outbound: number[] }

export function decideQuietMove(rows: ClusterRow[], facts: ClusterFacts, now: number, personal?: PersonalTexts | null): { to: LeadStatus; rule: AutoRule; since: number } | null {
  if (facts.current !== "active" || facts.isDnc || facts.dealLocked) return null
  const inbound = [...rows.filter((r) => !isOutbound(r)).map((r) => new Date(r.created_at).getTime()), ...(personal?.inbound ?? [])]
  const lastInbound = inbound.length ? Math.max(...inbound) : 0
  const outbound = [...rows.filter((r) => isOutbound(r)).map((r) => new Date(r.created_at).getTime()), ...(personal?.outbound ?? [])]
  const chases = outbound.filter((t) => t > lastInbound)
  if (chases.length === 0) return null // Ryan never reached out — Follow Ups owns it
  let since = Math.min(...chases)
  if (facts.ryanSetAt != null && facts.ryanSetAt > since) since = facts.ryanSetAt
  return now - since >= QUIET_DAYS * 86_400_000 ? { to: "nurture", rule: "quiet_30d", since } : null
}

const STAGE_PROMPT = (history: string, today: string) => `You are reading the full history between Ryan (LRG Homes, a cash home buyer who mails letters to homeowners) and one person who responded. Messages marked (ryan) are Ryan's side; (lead) are theirs. Calls are transcripts; texts and emails are as written.

TODAY IS ${today}.

Decide where this person stands RIGHT NOW, judged mostly by the latest exchanges:

- "lead": they own a property (the mailed one or another) and want to sell soon enough to work on now — roughly within 12 months — and they are open to Ryan's kind of offer (as-is cash, or willing to hear a number / talk numbers). Asking for an offer, inviting a call to discuss selling, or actively negotiating all count. A first message like "I own 123 Main and I'm interested in selling, call me" is a lead.
- "not_now": a real owner who isn't a seller for Ryan right now — "maybe in a few years", "not interested right now", "just curious what it's worth", wants full retail and won't budge, someone else decides, or they went cold after earlier interest and said so. A polite or rude "no" without asking to be removed is also not_now.
- "sold": they no longer own the property (sold it, lost it, transferred it) and mention nothing else they own.
- "wrong_person": not the owner and not connected to the property — a tenant, wrong number, someone who got the letter by mistake. An agent or relative ACTING FOR the owner is not wrong_person; judge the owner's intent instead.
- "unclear": not enough to tell (a hang-up, a one-word message, only Ryan's side, a voicemail greeting).

Be conservative with "sold" and "wrong_person" — when in doubt use "unclear" or "not_now".

Respond with ONLY a JSON object: {"stage": "lead" | "not_now" | "sold" | "wrong_person" | "unclear", "reason": "one short sentence quoting or paraphrasing what they said"}

HISTORY (oldest → newest):
"""
${history}
"""`

/** Opus reads the whole cluster and returns the person's stage. */
export async function judgeLeadStage(history: string): Promise<{ stage: LeadStage; reason: string } | null> {
  if (!hasLlmKey() || !history.trim()) return null
  const today = new Date().toISOString().slice(0, 10)
  const out = await completeText({ model: OPUS, effort: "medium", prompt: STAGE_PROMPT(history, today), maxTokens: 8192, tag: "[lead-stage]" })
  if (!out.text || out.truncated) return null
  const parsed = JSON.parse(extractJsonObject(out.text)) as { stage?: unknown; reason?: unknown }
  const stages: LeadStage[] = ["lead", "not_now", "sold", "wrong_person", "unclear"]
  const stage = stages.includes(parsed.stage as LeadStage) ? (parsed.stage as LeadStage) : "unclear"
  const reason = typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 300) : ""
  return { stage, reason }
}

/** Write a status change the way the card does + log it. `applied=false`
 *  logs a shadow move without touching the lead. */
export async function applyStatusChange(
  sb: SupabaseClient,
  args: {
    rows: ClusterRow[]
    anchor: ClusterRow
    to: LeadStatus
    source: "ryan" | "auto" | "milestone" | "undo"
    rule?: AutoRule | null
    reason?: string | null
    applied?: boolean
  },
): Promise<string | null> {
  const applied = args.applied ?? true
  const from = args.anchor.status
  if (applied) {
    const now = new Date().toISOString()
    const { error } = await sb
      .from("leads")
      .update({ status: args.to, status_set_by: args.source === "undo" ? "ryan" : args.source, status_set_at: now })
      .eq("id", args.anchor.id)
    if (error) throw new Error(`status write failed: ${error.message}`)
    if (args.to === "active") await stampBecameLead(sb, args.rows)
    if (args.to === "dead") {
      await haltOutreachForCluster(sb, { id: args.anchor.id, caller_phone: args.anchor.caller_phone, email: args.anchor.email, status: "dead" })
    }
  }
  const { data, error: evErr } = await sb
    .from("lead_status_events")
    .insert({ lead_id: args.anchor.id, from_status: from, to_status: args.to, source: args.source, rule: args.rule ?? null, reason: args.reason ?? null, applied })
    .select("id")
    .single()
  if (evErr) console.error("[lead-status] event log failed:", evErr.message)
  return (data?.id as string | undefined) ?? null
}

/** became_lead_at is "ever a lead": set once, cluster-wide, never cleared. */
export async function stampBecameLead(sb: SupabaseClient, rows: ClusterRow[]): Promise<void> {
  if (rows.some((r) => r.became_lead_at)) {
    const first = rows.map((r) => r.became_lead_at).filter((v): v is string => !!v).sort()[0]
    const missing = rows.filter((r) => !r.became_lead_at).map((r) => r.id)
    if (missing.length) await sb.from("leads").update({ became_lead_at: first }).in("id", missing)
    return
  }
  const { error } = await sb.from("leads").update({ became_lead_at: new Date().toISOString() }).in("id", rows.map((r) => r.id))
  if (error) console.error("[lead-status] became_lead_at write failed:", error.message)
}

/** Ryan changed the dropdown (PATCH /api/leads): log it and make it stick. */
export async function recordManualStatus(sb: SupabaseClient, leadId: string, from: LeadStatus | null, to: LeadStatus): Promise<void> {
  const now = new Date().toISOString()
  await sb.from("leads").update({ status_set_by: "ryan", status_set_at: now }).eq("id", leadId)
  await sb.from("lead_status_events").insert({ lead_id: leadId, from_status: from, to_status: to, source: "ryan" })
  if (to === "active") {
    const { data: row } = await sb.from("leads").select("id, caller_phone, email, gmail_thread_id").eq("id", leadId).maybeSingle()
    if (row) await stampBecameLead(sb, await fetchClusterRows(sb, row))
  }
}

/** After any new call / text / email on a person: read the history and move
 *  the status if the rules say so. Best-effort — never throws. */
export async function runAutoStatusForLead(leadId: string): Promise<{ moved: boolean; to?: LeadStatus; rule?: AutoRule; reason?: string; applied?: boolean } | null> {
  try {
    const sb = getLeadsClient()
    const { data: row } = await sb.from("leads").select("id, caller_phone, email, gmail_thread_id").eq("id", leadId).maybeSingle()
    if (!row) return null
    const rows = await fetchClusterRows(sb, row)
    const anchor = statusAnchor(rows)
    if (!anchor) return null
    if (rows.every((r) => r.is_junk)) return null
    const facts = clusterFacts(rows, anchor)
    if (facts.isDnc || facts.dealLocked) return { moved: false }
    if (facts.ryanSetAt != null && facts.latestEventAt <= facts.ryanSetAt) return { moved: false }

    const history = await fetchClusterHistory(sb, { callerPhone: row.caller_phone && !isAnonymousCaller(row.caller_phone) ? row.caller_phone : null, email: row.email })
    // Anonymous / thread-only clusters: fall back to the row's own text.
    const text = history ?? (await sb.from("leads").select("message").eq("id", leadId).maybeSingle()).data?.message ?? ""
    const judged = await judgeLeadStage(String(text))
    if (!judged) return { moved: false }
    const move = decideStageMove(facts, judged.stage)
    if (!move) return { moved: false }
    const applied = autoStatusEnabled()
    await applyStatusChange(sb, { rows, anchor, to: move.to, source: "auto", rule: move.rule, reason: judged.reason, applied })
    console.log(`[lead-status] ${anchor.id} ${anchor.status} → ${move.to} (${move.rule}${applied ? "" : ", shadow"}): ${judged.reason}`)
    return { moved: applied, to: move.to, rule: move.rule, reason: judged.reason, applied }
  } catch (e) {
    console.error(`[lead-status] auto status failed for ${leadId}:`, e instanceof Error ? e.message : String(e))
    return null
  }
}

/** Daily: every Active person who went quiet for 30 days after Ryan reached
 *  out → Nurture. No AI. Returns the moves (applied or shadow). */
export async function runQuietSweep(
  sb: SupabaseClient,
  // personalByPhone: last-10-digit phone → that person's personal-cell texts
  // (from The Pile, sent by the mini's daily script). Missing = unknown.
  opts: { now?: number; apply?: boolean; personalByPhone?: Record<string, PersonalTexts> } = {},
): Promise<{ leadId: string; name: string | null; days: number }[]> {
  const now = opts.now ?? Date.now()
  const apply = opts.apply ?? autoStatusEnabled()
  const actives: { id: string; caller_phone: string | null; email: string | null; gmail_thread_id: string | null }[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("leads")
      .select("id, caller_phone, email, gmail_thread_id")
      .eq("status", "active")
      .order("id", { ascending: true })
      .range(from, from + 999)
    if (error) throw new Error(error.message)
    actives.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  const seen = new Set<string>()
  const moves: { leadId: string; name: string | null; days: number }[] = []
  for (const a of actives) {
    const rows = await fetchClusterRows(sb, a)
    const anchor = statusAnchor(rows)
    if (!anchor || seen.has(anchor.id)) continue
    seen.add(anchor.id)
    if (anchor.status !== "active") continue
    const facts = clusterFacts(rows, anchor)
    const p10 = (anchor.caller_phone || "").replace(/\D/g, "").slice(-10)
    const quiet = decideQuietMove(rows, facts, now, p10 ? opts.personalByPhone?.[p10] : null)
    if (!quiet) continue
    const days = Math.floor((now - quiet.since) / 86_400_000)
    const name = rows.map((r) => r.name).reverse().find((n) => n && n.trim()) ?? null
    await applyStatusChange(sb, { rows, anchor, to: "nurture", source: "auto", rule: "quiet_30d", reason: `No reply for ${days} days after Ryan reached out`, applied: apply })
    moves.push({ leadId: anchor.id, name, days })
  }
  return moves
}

/** Undo button on the daily summary: put the status back and make it stick. */
export async function undoStatusEvent(sb: SupabaseClient, eventId: string): Promise<{ ok: boolean; label?: string; error?: string }> {
  const { data: ev } = await sb.from("lead_status_events").select("id, lead_id, from_status, to_status, applied, undone_at").eq("id", eventId).maybeSingle()
  if (!ev) return { ok: false, error: "move not found" }
  if (ev.undone_at) return { ok: false, error: "already undone" }
  if (!ev.applied || !ev.from_status) return { ok: false, error: "nothing to undo" }
  const { data: row } = await sb.from("leads").select("id, caller_phone, email, gmail_thread_id, status, name").eq("id", ev.lead_id).maybeSingle()
  if (!row) return { ok: false, error: "lead not found" }
  const rows = await fetchClusterRows(sb, row)
  const anchor = rows.find((r) => r.id === ev.lead_id) ?? statusAnchor(rows)
  if (!anchor) return { ok: false, error: "lead not found" }
  await applyStatusChange(sb, { rows, anchor, to: ev.from_status as LeadStatus, source: "undo", reason: `undo of ${ev.to_status}` })
  await sb.from("lead_status_events").update({ undone_at: new Date().toISOString() }).eq("id", eventId)
  const name = rows.map((r) => r.name).reverse().find((n) => n && n.trim()) ?? row.caller_phone ?? row.email ?? "lead"
  return { ok: true, label: `${name} back to ${ev.from_status}` }
}
