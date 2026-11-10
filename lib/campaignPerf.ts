// Campaign Performance counting (2026-11-09, mailer credit). Pure — the
// route (app/api/campaigns/performance) loads rows and calls this.
//
// People, not rows: rows are joined into one person through any shared phone
// (blocked caller IDs never join), Gmail thread or email — so a seller who
// called and later emailed from an address with no phone on it is one
// person, not two.
//
// Ryan's rule (D2): a person counts as a RESPONSE under every campaign they
// were credited to. Each funnel event — became a lead, appointment, offer,
// pending, close (+ deal value), removal — counts ONCE, under the campaign of
// their newest credited row on or before the event ("the sale credit goes to
// the most recent mailing"); an event older than every credited row falls
// back to the earliest credited campaign (hand-attached legacy closes such
// as 674 Kirkland). So an old campaign keeps what happened before the new
// letter, and the new one gets what happens after.
import { isAnonymousCaller } from "./anonymous"
import { WEBSITE_LINE } from "./mailCredit"

export interface PerfRow {
  id: string
  created_at: string
  name: string | null
  property_address: string | null
  campaign_id: string | null
  campaign_via: string | null
  caller_phone: string | null
  email: string | null
  gmail_thread_id: string | null
  twilio_number: string | null
  lead_type: string | null
  is_junk: boolean | null
  is_dnc: boolean | null
  offer_verbalized_at: string | null
  offer_amount: number | null
  deal_closed_at: string | null
  deal_value: number | null
  became_lead_at: string | null
  appointment_at: string | null
  pending_at: string | null
}

export type Door = "letter" | "website_form" | "website_number" | "other"

export interface CampaignCounts {
  total_responses: number
  removals: number
  junk: number
  responses: number
  leads: number
  appointments: number
  offers: number
  pending: number
  closed: number
  deal_value_total: number
  closed_deals: { name: string | null; address: string | null; closed_at: string; deal_value: number | null }[]
  /** Real responses by how they first reached out for this campaign. */
  by_door: Record<Door, number>
}

export interface PerfOffer {
  lead_id: string
  name: string | null
  caller_phone: string | null
  email: string | null
  offer_amount: number | null
  offer_verbalized_at: string | null
  campaign_id: string | null
}

const emptyCounts = (): CampaignCounts => ({
  total_responses: 0, removals: 0, junk: 0, responses: 0, leads: 0, appointments: 0, offers: 0,
  pending: 0, closed: 0, deal_value_total: 0, closed_deals: [],
  by_door: { letter: 0, website_form: 0, website_number: 0, other: 0 },
})

/** Group rows into people: union of shared phone / thread / email. Returns row id → person key. */
export function groupPeople(rows: Pick<PerfRow, "id" | "caller_phone" | "email" | "gmail_thread_id">[]): Map<string, string> {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    let c = x
    while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n }
    return r
  }
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra) }
  const owner = new Map<string, string>() // identity key → first row id
  for (const r of rows) {
    parent.set(r.id, r.id)
    const keys: string[] = []
    if (r.caller_phone && !isAnonymousCaller(r.caller_phone)) keys.push(`p:${r.caller_phone}`)
    if (r.gmail_thread_id) keys.push(`t:${r.gmail_thread_id}`)
    if (r.email) keys.push(`e:${r.email.toLowerCase()}`)
    for (const k of keys) {
      const o = owner.get(k)
      if (o) union(o, r.id); else owner.set(k, r.id)
    }
  }
  const out = new Map<string, string>()
  for (const r of rows) out.set(r.id, find(r.id))
  return out
}

function doorOf(r: PerfRow): Door {
  if (r.lead_type === "form") return "website_form"
  if (r.twilio_number === WEBSITE_LINE) return "website_number"
  if (r.campaign_via === "line") return "letter"
  return "other"
}

const isInbound = (r: PerfRow) => !!r.twilio_number || r.lead_type === "form"

/** Earliest non-null value of a timestamp column across rows. */
function earliest(rows: PerfRow[], col: keyof PerfRow): string | null {
  let best: string | null = null
  for (const r of rows) {
    const v = r[col] as string | null
    if (v && (!best || v < best)) best = v
  }
  return best
}

/**
 * Count every campaign. `familyOf` maps a campaign id to its family root (the
 * A/B parent, else itself); `families` also get a person-de-duped rollup so a
 * parent card never counts one person twice across its letters.
 */
export function computeCampaignCounts(
  rows: PerfRow[],
  familyOf: (campaignId: string) => string
): { byCampaign: Map<string, CampaignCounts>; byFamily: Map<string, CampaignCounts>; offers: PerfOffer[] } {
  const personOf = groupPeople(rows)
  const people = new Map<string, PerfRow[]>()
  for (const r of rows) {
    const p = personOf.get(r.id)!
    if (!people.has(p)) people.set(p, [])
    people.get(p)!.push(r)
  }

  const byCampaign = new Map<string, CampaignCounts>()
  const byFamily = new Map<string, CampaignCounts>()
  const offers: PerfOffer[] = []
  const bucket = (m: Map<string, CampaignCounts>, id: string) => {
    if (!m.has(id)) m.set(id, emptyCounts())
    return m.get(id)!
  }

  for (const prow of Array.from(people.values())) {
    const credited = prow.filter(r => r.campaign_id).sort((a, b) => a.created_at.localeCompare(b.created_at))
    if (!credited.length) continue
    const campaignAt = (at: string | null): string => {
      if (!at) return credited[0].campaign_id as string
      let pick: string | null = null
      for (const r of credited) if (r.created_at <= at) pick = r.campaign_id
      return pick ?? (credited[0].campaign_id as string)
    }
    const name = prow.map(r => r.name).find(n => !!n) ?? null
    const address = prow.map(r => r.property_address).find(a => !!a) ?? null

    // Events, each attributed to one campaign.
    const dncRow = prow.filter(r => r.is_dnc).sort((a, b) => a.created_at.localeCompare(b.created_at))[0]
    const removalIn = dncRow ? campaignAt(dncRow.created_at) : null
    const leadAt = earliest(prow, "became_lead_at")
    const apptAt = earliest(prow, "appointment_at")
    const offerAt = earliest(prow, "offer_verbalized_at")
    const pendingAt = earliest(prow, "pending_at")
    const closeAt = earliest(prow, "deal_closed_at")
    const dealValue = Math.max(0, ...prow.map(r => r.deal_value ?? 0)) // written on every row: max, never sum
    const ev = {
      lead: leadAt ? campaignAt(leadAt) : null,
      appt: apptAt ? campaignAt(apptAt) : null,
      offer: offerAt ? campaignAt(offerAt) : null,
      pending: pendingAt ? campaignAt(pendingAt) : null,
      close: closeAt ? campaignAt(closeAt) : null,
    }

    const count = (c: CampaignCounts, inCampaign: (id: string | null) => boolean, cRows: PerfRow[]) => {
      c.total_responses++
      const removal = inCampaign(removalIn)
      const junk = !removal && cRows.every(r => !!r.is_junk)
      if (removal) { c.removals++; return }
      if (junk) { c.junk++; return }
      c.responses++
      if (inCampaign(ev.lead)) c.leads++
      if (inCampaign(ev.appt)) c.appointments++
      if (inCampaign(ev.offer)) c.offers++
      if (inCampaign(ev.pending)) c.pending++
      if (inCampaign(ev.close)) {
        c.closed++
        c.deal_value_total += dealValue
        c.closed_deals.push({ name, address, closed_at: closeAt as string, deal_value: dealValue || null })
      }
      const firstIn = cRows.filter(isInbound)[0] ?? cRows[0]
      c.by_door[doorOf(firstIn)]++
    }

    const campaignIds = Array.from(new Set(credited.map(r => r.campaign_id as string)))
    for (const id of campaignIds) {
      count(bucket(byCampaign, id), x => x === id, credited.filter(r => r.campaign_id === id))
    }
    const familyIds = Array.from(new Set(campaignIds.map(familyOf)))
    for (const f of familyIds) {
      count(bucket(byFamily, f), x => !!x && familyOf(x) === f, credited.filter(r => familyOf(r.campaign_id as string) === f))
    }

    if (offerAt) {
      const offerRow = prow.find(r => r.offer_verbalized_at === offerAt) ?? prow[0]
      offers.push({
        lead_id: offerRow.id,
        name,
        caller_phone: offerRow.caller_phone,
        email: offerRow.email,
        offer_amount: prow.map(r => r.offer_amount).find(v => typeof v === "number") ?? null,
        offer_verbalized_at: offerAt,
        campaign_id: ev.offer,
      })
    }
  }
  offers.sort((a, b) => (b.offer_verbalized_at ?? "").localeCompare(a.offer_verbalized_at ?? ""))
  return { byCampaign, byFamily, offers }
}
