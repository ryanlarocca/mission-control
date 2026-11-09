// Contracts → the lead card (Ryan 2026-11-09, Barbara on Bieber: the
// appointment was held, she signed the purchase agreement on
// sign.lrghomes.com, and the card still said "Contacted" with tomorrow's
// "call her to see where she landed").
//
// The e-sign service on the mini calls POST /api/leads/contract:
//   sent    — a purchase agreement went out to a seller → the Offer stage,
//             with the written price (it beats any number said on a call)
//   signed  — everyone signed → Pending (under contract): pending_at = the
//             signing day, deal_details = the terms, status Active, every
//             follow-up date / drip / autopilot cleared, and one standing
//             verdict "under_contract" due on the close-by day
// Closed stays Ryan's tap on the card.
//
// Server only — lib/leadStatus and lib/appointments import lib/leads, which
// must never reach the browser.

import type { SupabaseClient } from "@supabase/supabase-js"
import { applyStatusChange, fetchClusterRows, stampBecameLead, statusAnchor, type ClusterRow } from "@/lib/leadStatus"
import { streetKey } from "@/lib/appointments"
import { pacificDate } from "@/lib/pacificDate"

export const DEAL_UNDO_PREFIX = "dealundo:"

export interface DealDetails {
  envelope_id: string
  title: string | null
  price: number | null
  earnest_money: number | null
  closing_days: number | null
  signed_at: string
  /** YYYY-MM-DD, Pacific: signing day + closing days. */
  close_by: string | null
  drive_link: string | null
  seller_name: string | null
  source: "esign"
  set_at: string
}

export interface ContractEvent {
  event: "sent" | "signed"
  envelopeId: string
  title: string | null
  propertyAddress: string | null
  /** sent: when it went out. signed: when the last signature landed. */
  at: string
  driveLink: string | null
  price: number | null
  earnestMoney: number | null
  closingDays: number | null
  sellerName: string | null
  sellers: { name: string | null; email: string | null; phone: string | null }[]
}

export type ContractResult =
  | { status: "recorded" | "already"; leadId: string; name: string | null; closeBy: string | null }
  | { status: "no_match" | "closed"; leadId?: string; name?: string | null; closeBy?: null }

/** "900,000.00" / "$900k" / 900000 → 900000. null when it isn't a price. */
export function parseMoney(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.round(v) : null
  const t = String(v ?? "").replace(/[$,\s]/g, "")
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(t)
  if (!m) return null
  const n = parseFloat(m[1]) * (m[2].toLowerCase() === "k" ? 1000 : m[2].toLowerCase() === "m" ? 1_000_000 : 1)
  return n > 0 ? Math.round(n) : null
}

/** Pure: the close-by day — signing day (Pacific) + closing days. */
export function closeByDay(signedAt: string, closingDays: number | null): string | null {
  if (closingDays == null || !Number.isFinite(closingDays) || closingDays < 0) return null
  const day = pacificDate(new Date(signedAt))
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + Math.round(closingDays))
  return d.toISOString().slice(0, 10)
}

function fmtDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
}
function money(n: number): string {
  return `$${n.toLocaleString("en-US")}`
}
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
function clusterName(rows: { name?: string | null; created_at: string }[]): string | null {
  return [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((r) => (r.name ?? "").trim()).find(Boolean) || null
}

type Seed = { id: string; caller_phone: string | null; email: string | null; gmail_thread_id: string | null }
const SEED_COLS = "id, created_at, caller_phone, email, gmail_thread_id, property_address, is_junk"

function clusterKey(r: Seed): string {
  return r.caller_phone ? `p:${r.caller_phone}` : r.gmail_thread_id ? `t:${r.gmail_thread_id}` : r.email ? `e:${r.email.toLowerCase()}` : `id:${r.id}`
}

/** Which lead is this contract's seller? Their phone, then their email,
 *  then the property address. One person or nobody — never a guess. */
export async function findLeadForContract(sb: SupabaseClient, ev: Pick<ContractEvent, "sellers" | "propertyAddress">): Promise<Seed | null> {
  const one = (rows: (Seed & { is_junk?: boolean | null })[] | null): Seed | null => {
    const byKey = new Map<string, Seed>()
    for (const r of rows ?? []) if (!r.is_junk && !byKey.has(clusterKey(r))) byKey.set(clusterKey(r), r)
    return byKey.size === 1 ? Array.from(byKey.values())[0] : null
  }
  const phones = Array.from(new Set(ev.sellers.map((s) => s.phone).filter((p): p is string => !!p && /^\+\d{8,}$/.test(p))))
  if (phones.length) {
    const { data, error } = await sb.from("leads").select(SEED_COLS).in("caller_phone", phones).order("created_at", { ascending: false }).limit(50)
    if (error) throw new Error(`lead lookup (phone): ${error.message}`)
    const hit = one(data as Seed[] | null)
    if (hit) return hit
  }
  for (const email of Array.from(new Set(ev.sellers.map((s) => (s.email ?? "").trim().toLowerCase()).filter(Boolean)))) {
    if (/@lrghomes\.com$/.test(email)) continue
    const { data, error } = await sb.from("leads").select(SEED_COLS).ilike("email", email).order("created_at", { ascending: false }).limit(50)
    if (error) throw new Error(`lead lookup (email): ${error.message}`)
    const hit = one(data as Seed[] | null)
    if (hit) return hit
  }
  const key = streetKey(ev.propertyAddress)
  if (key) {
    const { data, error } = await sb.from("leads").select(SEED_COLS).ilike("property_address", `${key.number} %${key.street}%`).order("created_at", { ascending: false }).limit(50)
    if (error) throw new Error(`lead lookup (address): ${error.message}`)
    const hit = one(data as Seed[] | null)
    if (hit) return hit
  }
  return null
}

async function update(sb: SupabaseClient, ids: string[], patch: Record<string, unknown>): Promise<void> {
  const { error } = await sb.from("leads").update(patch).in("id", ids)
  if (error) throw new Error(`lead write: ${error.message}`)
}

/** The written offer: price on every row of the person (it is the number
 *  in front of them now), Offer stage stamped if it wasn't. */
async function recordOffer(sb: SupabaseClient, rows: ClusterRow[], ev: ContractEvent): Promise<void> {
  const ids = rows.map((r) => r.id)
  if (ev.price) await update(sb, ids, { offer_amount: ev.price })
  if (!rows.some((r) => r.offer_verbalized_at)) await update(sb, ids, { offer_verbalized_at: ev.at })
  await stampBecameLead(sb, rows)
}

export async function recordContractEvent(sb: SupabaseClient, ev: ContractEvent): Promise<ContractResult> {
  const seed = await findLeadForContract(sb, ev)
  if (!seed) return { status: "no_match" }
  const rows = await fetchClusterRows(sb, seed)
  if (!rows.length) return { status: "no_match" }
  const ids = rows.map((r) => r.id)
  const name = clusterName(rows)
  const leadId = seed.id

  if (ev.event === "sent") {
    if (rows.some((r) => r.pending_at || r.deal_closed_at)) return { status: "already", leadId, name, closeBy: null }
    await recordOffer(sb, rows, ev)
    return { status: "recorded", leadId, name, closeBy: null }
  }

  // signed
  if (rows.some((r) => r.deal_closed_at)) return { status: "closed", leadId, name }
  const { data: detailRows } = await sb.from("leads").select("deal_details").in("id", ids).not("deal_details", "is", null).limit(1)
  const existing = (detailRows?.[0] as { deal_details?: DealDetails } | undefined)?.deal_details
  if (existing?.envelope_id === ev.envelopeId && rows.some((r) => r.pending_at)) {
    return { status: "already", leadId, name, closeBy: existing.close_by }
  }

  const signedDay = pacificDate(new Date(ev.at))
  const closeBy = closeByDay(ev.at, ev.closingDays)
  const details: DealDetails = {
    envelope_id: ev.envelopeId, title: ev.title, price: ev.price, earnest_money: ev.earnestMoney, closing_days: ev.closingDays,
    signed_at: ev.at, close_by: closeBy, drive_link: ev.driveLink, seller_name: ev.sellerName, source: "esign", set_at: new Date().toISOString(),
  }
  await recordOffer(sb, rows, ev)
  // Noon UTC keeps the calendar date stable in Pacific time (milestone route).
  await update(sb, ids, { pending_at: `${signedDay}T12:00:00Z`, deal_details: details })

  const anchor = statusAnchor(rows)
  if (anchor && !rows.some((r) => r.is_dnc) && anchor.status !== "active") {
    await applyStatusChange(sb, { rows, anchor, to: "active", source: "milestone", reason: `contract signed ${signedDay}` })
  }

  // Nobody chases a seller who signed: no follow-up dates, no drips, no
  // autopilot. One date stays — the close-by day, on the newest row.
  await update(sb, ids, { recommended_followup_date: null, followup_reason: null, drip_campaign_type: null })
  const { error: qErr } = await sb.from("drip_queue").update({ status: "skipped", error: "under_contract" }).in("lead_id", ids).in("status", ["pending", "approved"])
  if (qErr) console.error(`[deals] drip queue skip failed (${leadId}): ${qErr.message}`)
  const reason = underContractReason(details)
  const newest = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
  if (closeBy) await update(sb, [newest.id], { recommended_followup_date: closeBy, followup_reason: reason, followup_generated_at: new Date().toISOString() })
  if (seed.caller_phone) {
    const { error: vErr } = await sb.from("lead_verdicts").upsert({
      phone: seed.caller_phone, state: "under_contract", due_date: closeBy, reason,
      through_at: newest.created_at, judged_at: new Date().toISOString(), source: "contract", model: null, raw: { envelope_id: ev.envelopeId },
    })
    if (vErr) console.error(`[deals] verdict write failed (${leadId}): ${vErr.message}`)
  }
  return { status: "recorded", leadId, name, closeBy }
}

/** The one line the card / Follow Ups / judge show for a signed deal. */
export function underContractReason(d: Pick<DealDetails, "price" | "close_by" | "signed_at">): string {
  const parts = [`Under contract${d.price ? ` at ${money(d.price)}` : ""} (signed ${fmtDay(pacificDate(new Date(d.signed_at)))})`]
  if (d.close_by) parts.push(`closes by ${fmtDay(d.close_by)} — tap Closed once it records`)
  return parts.join(" — ")
}

/** Telegram line + Undo for a newly recorded contract. The e-sign service
 *  folds this into its own "fully signed" message, so Ryan gets one card. */
export function contractCardLine(r: ContractResult, ev: ContractEvent): string {
  if (r.status === "no_match") return `⚠️ I couldn't tell which lead this is${ev.propertyAddress ? ` (${esc(ev.propertyAddress)})` : ""}. Tap 📝 Pending on their card by hand.`
  if (r.status === "closed") return `${esc(r.name ?? "This lead")}'s card is already marked Closed, so I left it alone.`
  const terms = [ev.price ? money(ev.price) : null, r.closeBy ? `close by ${fmtDay(r.closeBy)}` : null].filter(Boolean).join(" · ")
  if (r.status === "already") return `🤝 ${esc(r.name ?? "The lead")}'s card already shows this contract${terms ? ` (${terms})` : ""}.`
  return `🤝 On ${esc(r.name ?? "the lead")}'s card: <b>Under contract</b>${terms ? ` · ${terms}` : ""}. Follow-ups and auto-texts stopped.`
}

/** ↩️ Undo on the Telegram card: take Pending + the terms off the card and
 *  drop the under-contract verdict (the judge rules on their next activity). */
export async function undoContract(sb: SupabaseClient, leadId: string): Promise<{ ok: boolean; label: string }> {
  try {
    const { data: seed, error } = await sb.from("leads").select("id, caller_phone, email, gmail_thread_id").eq("id", leadId).maybeSingle()
    if (error) return { ok: false, label: error.message }
    if (!seed) return { ok: false, label: "lead not found" }
    const rows = await fetchClusterRows(sb, seed)
    const name = clusterName(rows) ?? "the lead"
    if (!rows.some((r) => r.pending_at)) return { ok: false, label: `${name}'s card isn't marked Pending` }
    const ids = rows.map((r) => r.id)
    await update(sb, ids, { pending_at: null, deal_details: null, recommended_followup_date: null, followup_reason: null })
    if (seed.caller_phone) await sb.from("lead_verdicts").delete().eq("phone", seed.caller_phone).eq("state", "under_contract")
    return { ok: true, label: `Pending removed from ${name}'s card. Follow-ups pick up again on their next call or text` }
  } catch (e) {
    return { ok: false, label: e instanceof Error ? e.message : String(e) }
  }
}
