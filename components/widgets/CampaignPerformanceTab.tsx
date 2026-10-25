"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Loader2, RefreshCw, Plus, X } from "lucide-react"
import { formatPhone } from "@/lib/utils"
import { CampaignSegmentsPanel } from "./CampaignSegmentsPanel"

// Campaign Performance tab — funnel + ROI for every marketing campaign.
// Reads `/api/campaigns/performance` once on mount and on user refresh.
// Funnel = Sent → Responded → Offer → Closed; cost-per-stage when costs
// are known. Parents render a rollup card with their A/B children
// side-by-side underneath; standalone campaigns (no children, no parent)
// render as a single-card row in the same layout. Below all parent
// rollups is a flat comparison table sorted by drop_date DESC.

interface CampaignPerf {
  id: string
  name: string
  channel: "direct_mail" | "google_ads"
  drop_date: string | null
  pieces_sent: number | null
  total_cost: number | null
  variant: string | null
  parent_campaign_id: string | null
  notes: string | null
  total_responses: number
  total_response_rate: number | null
  removals: number
  junk: number
  responses: number              // real responses
  response_rate: number | null
  leads: number
  lead_rate: number | null
  appointments: number
  offers: number
  offer_rate: number | null
  pending: number
  closed: number
  deal_value_total: number
  cost_per_response: number | null
  cost_per_offer: number | null
  cost_per_lead: number | null
  cost_per_closed: number | null
  roi: number | null
  legacy?: boolean
  order_number?: string | null
  closed_deals?: { name: string | null; address: string | null; closed_at: string; deal_value: number | null }[]
}

interface OfferEntry {
  lead_id: string
  name: string | null
  caller_phone: string | null
  email: string | null
  offer_amount: number | null
  offer_verbalized_at: string | null
  campaign_id: string | null
  campaign_name: string | null
}

// ── formatters ─────────────────────────────────────────────────────────────
function fmtMoney(n: number | null): string {
  if (n == null) return "—"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${Math.round(n).toLocaleString()}`
  return `$${n.toFixed(2)}`
}
function fmtInt(n: number | null): string {
  if (n == null) return "—"
  return n.toLocaleString()
}
function fmtPct(n: number | null): string {
  if (n == null) return "—"
  return `${(n * 100).toFixed(2)}%`
}
function fmtCost(n: number | null): string {
  if (n == null) return "—"
  return `$${Math.round(n).toLocaleString()}`
}
function fmtRoi(n: number | null): string {
  if (n == null) return "—"
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(0)}%`
}
function fmtDate(iso: string | null): string {
  if (!iso) return "—"
  return new Date(iso + "T00:00:00").toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })
}
// formatPhone moved to lib/utils.ts.

export function CampaignPerformanceTab() {
  const [campaigns, setCampaigns] = useState<CampaignPerf[] | null>(null)
  const [offers, setOffers] = useState<OfferEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showNewModal, setShowNewModal] = useState(false)
  // Legacy tab (2026-10-24): mailings from before campaigns were tracked.
  const [legacy, setLegacy] = useState<CampaignPerf[]>([])
  const [tab, setTab] = useState<"current" | "legacy">("current")

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/campaigns/performance", { cache: "no-store" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const payload = await res.json() as { campaigns: CampaignPerf[]; offers?: OfferEntry[] }
      setCampaigns(payload.campaigns.filter(c => !c.legacy))
      setLegacy(payload.campaigns.filter(c => c.legacy))
      setOffers(payload.offers ?? [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void fetchData() }, [fetchData])

  // Bucket: parents (no parent_campaign_id), with their children attached.
  // Also collect standalone campaigns — no parent and no children pointing
  // to them — which render as single-card rows in the same layout.
  type ParentGroup = { parent: CampaignPerf; children: CampaignPerf[] }
  const groups: ParentGroup[] = useMemo(() => {
    if (!campaigns) return []
    const byParent = new Map<string, CampaignPerf[]>()
    for (const c of campaigns) {
      if (c.parent_campaign_id) {
        if (!byParent.has(c.parent_campaign_id)) byParent.set(c.parent_campaign_id, [])
        byParent.get(c.parent_campaign_id)!.push(c)
      }
    }
    const groups: ParentGroup[] = []
    for (const c of campaigns) {
      if (c.parent_campaign_id) continue // child — rendered under parent
      const kids = byParent.get(c.id) ?? []
      groups.push({ parent: c, children: kids })
    }
    // Sort by parent's drop_date DESC (most recent campaigns on top).
    groups.sort((a, b) => (b.parent.drop_date ?? "").localeCompare(a.parent.drop_date ?? ""))
    return groups
  }, [campaigns])

  // Aggregate a parent's children — when the parent itself has no metrics
  // recorded (the typical case for an A/B parent), we sum the children to
  // get the rollup numbers.
  function aggregateForDisplay(group: ParentGroup): CampaignPerf {
    if (group.children.length === 0) return group.parent
    const sum = (key: keyof CampaignPerf) => group.children.reduce((acc, c) => acc + ((c[key] as number) ?? 0), 0)
    const pieces = sum("pieces_sent")
    const cost = sum("total_cost")
    const responses = sum("responses")
    const total = sum("total_responses")
    const leads = sum("leads")
    const offers = sum("offers")
    const closed = sum("closed")
    const dealValue = sum("deal_value_total")
    const piecesAll = pieces > 0 ? pieces : group.parent.pieces_sent
    const costAll = cost > 0 ? cost : group.parent.total_cost
    return {
      ...group.parent,
      pieces_sent: piecesAll,
      total_cost: costAll,
      total_responses: total,
      total_response_rate: piecesAll ? total / piecesAll : null,
      removals: sum("removals"),
      junk: sum("junk"),
      responses,
      response_rate: piecesAll ? responses / piecesAll : null,
      leads,
      lead_rate: responses > 0 ? leads / responses : null,
      appointments: sum("appointments"),
      offers,
      offer_rate: responses > 0 ? offers / responses : null,
      pending: sum("pending"),
      closed,
      deal_value_total: dealValue,
      cost_per_response: costAll && responses > 0 ? costAll / responses : null,
      cost_per_offer: costAll && offers > 0 ? costAll / offers : null,
      cost_per_lead: costAll && leads > 0 ? costAll / leads : null,
      cost_per_closed: costAll && closed > 0 ? costAll / closed : null,
      roi: costAll && dealValue > 0 ? (dealValue - costAll) / costAll : null,
    }
  }

  // "Pink outperformed White by X%" — only when there are exactly 2
  // children with non-null response_rate. Computes the lift of the higher
  // over the lower, e.g. 1.13% vs 0.86% → 31% lift.
  function abComparisonLine(group: ParentGroup): string | null {
    if (group.children.length !== 2) return null
    const [a, b] = group.children
    if (a.response_rate == null || b.response_rate == null) return null
    const higher = a.response_rate > b.response_rate ? a : b
    const lower = a.response_rate > b.response_rate ? b : a
    if (lower.response_rate === 0) return null
    const lift = (higher.response_rate! - lower.response_rate!) / lower.response_rate!
    if (lift < 0.01) return null
    const higherLabel = higher.variant || higher.name
    const lowerLabel = lower.variant || lower.name
    return `${higherLabel} outperformed ${lowerLabel} by ${(lift * 100).toFixed(0)}% on response rate.`
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Campaign Performance</h1>
          <p className="text-xs text-zinc-500">Total → Real responses → Leads → Appointment → Offer → Pending → Closed for every campaign, with per-stage cost and ROI.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void fetchData()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 min-h-[34px] rounded text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 transition-colors disabled:opacity-60"
            title="Refresh"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={() => setShowNewModal(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[34px] rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            New Campaign
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-200">{error}</div>
      )}

      {!campaigns && loading && (
        <div className="text-xs text-zinc-500 pl-3">Loading campaigns…</div>
      )}

      {campaigns && campaigns.length === 0 && (
        <div className="rounded border border-zinc-800 bg-zinc-950 p-4 text-center">
          <p className="text-sm text-zinc-400">No campaigns yet.</p>
          <p className="text-xs text-zinc-600 mt-1">Click <span className="text-emerald-400">New Campaign</span> to add one.</p>
        </div>
      )}

      <div className="flex gap-1 text-xs">
        {(["current", "legacy"] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 min-h-[34px] rounded ${tab === t ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900"}`}
          >
            {t === "current" ? "Current" : `Legacy${legacy.length ? ` · ${legacy.length}` : ""}`}
          </button>
        ))}
      </div>

      {tab === "legacy" ? <LegacyView rows={legacy} /> : (
      <>
      {/* Per-parent rollup cards */}
      <div className="space-y-4">
        {groups.map(group => {
          const agg = aggregateForDisplay(group)
          const ab = abComparisonLine(group)
          return (
            <div key={group.parent.id} className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
              <div className="px-3 py-2 border-b border-zinc-800 flex items-center gap-2 text-xs">
                <span className="text-zinc-200 font-medium">{group.parent.name}</span>
                <span className="text-zinc-600">·</span>
                <span className="text-zinc-400">{group.parent.channel === "direct_mail" ? "Direct Mail" : "Google Ads"}</span>
                {group.parent.drop_date && (
                  <>
                    <span className="text-zinc-600">·</span>
                    <span className="text-zinc-500">{fmtDate(group.parent.drop_date)}</span>
                  </>
                )}
              </div>
              <div className="px-3 py-2 space-y-2">
                <div className="text-xs text-zinc-400">
                  {fmtInt(agg.pieces_sent)} pieces · {fmtMoney(agg.total_cost)} ·{" "}
                  <span className="text-zinc-200">{agg.total_responses}</span> responses ({fmtPct(agg.total_response_rate)}) ·{" "}
                  <span className="text-zinc-200">{agg.responses}</span> real · <span className="text-zinc-200">{agg.leads}</span> leads
                </div>
                {ab && <div className="text-xs text-emerald-300">{ab}</div>}
                {group.children.length > 0 && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                    {group.children.map(child => <ChildCard key={child.id} c={child} />)}
                  </div>
                )}
                {group.children.length === 0 && (
                  <FunnelInline c={agg} />
                )}
                {group.parent.channel === "direct_mail" && (
                  <CampaignSegmentsPanel campaignId={group.parent.id} />
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Offers — every verbalized offer across all clusters, newest first. */}
      {offers.length > 0 && (
        <div className="rounded-lg border border-amber-900/40 bg-amber-950/10 overflow-x-auto">
          <div className="px-3 py-2 border-b border-amber-900/40 text-xs text-amber-100 font-medium inline-flex items-center gap-2">
            💰 Offers <span className="text-amber-300/70">· {offers.length}</span>
          </div>
          <table className="w-full text-xs">
            <thead className="text-zinc-500 bg-zinc-900/40">
              <tr>
                <th className="text-left px-3 py-1.5">Lead</th>
                <th className="text-left px-3 py-1.5">Contact</th>
                <th className="text-right px-3 py-1.5">Amount</th>
                <th className="text-left px-3 py-1.5">Verbalized</th>
                <th className="text-left px-3 py-1.5">Campaign</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              {offers.map(o => (
                <tr key={o.lead_id} className="border-t border-zinc-900/60 hover:bg-zinc-900/30">
                  <td className="px-3 py-1.5">{o.name || <span className="text-zinc-600 italic">(no name)</span>}</td>
                  <td className="px-3 py-1.5 text-zinc-500 font-mono text-[11px]">
                    {o.caller_phone ? formatPhone(o.caller_phone) : o.email || "—"}
                  </td>
                  <td className="px-3 py-1.5 text-right font-medium text-amber-200">{fmtMoney(o.offer_amount)}</td>
                  <td className="px-3 py-1.5 text-zinc-500">{o.offer_verbalized_at ? new Date(o.offer_verbalized_at).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : "—"}</td>
                  <td className="px-3 py-1.5 text-zinc-400">{o.campaign_name || <span className="text-zinc-600">unattributed</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Flat comparison table */}
      {campaigns && campaigns.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-x-auto">
          <div className="px-3 py-2 border-b border-zinc-800 text-xs text-zinc-200 font-medium">
            Comparison
          </div>
          <table className="w-full text-xs">
            <thead className="text-zinc-500 bg-zinc-900/50">
              <tr>
                <th className="text-left px-3 py-1.5">Name</th>
                <th className="text-left px-3 py-1.5">Channel</th>
                <th className="text-right px-3 py-1.5">Pieces</th>
                <th className="text-right px-3 py-1.5">Spend</th>
                <th className="text-right px-3 py-1.5">Total</th>
                <th className="text-right px-3 py-1.5">Real</th>
                <th className="text-right px-3 py-1.5">%</th>
                <th className="text-right px-3 py-1.5">Leads</th>
                <th className="text-right px-3 py-1.5">Off</th>
                <th className="text-right px-3 py-1.5">%</th>
                <th className="text-right px-3 py-1.5">Closed</th>
                <th className="text-right px-3 py-1.5">ROI</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              {[...campaigns].sort((a, b) => (b.drop_date ?? "").localeCompare(a.drop_date ?? "")).map(c => (
                <tr key={c.id} className="border-t border-zinc-900 hover:bg-zinc-900/40">
                  <td className="px-3 py-1.5">
                    {c.parent_campaign_id && <span className="text-zinc-600 mr-1">↳</span>}
                    {c.name}
                  </td>
                  <td className="px-3 py-1.5 text-zinc-500">{c.channel === "direct_mail" ? "DM" : "GA"}</td>
                  <td className="px-3 py-1.5 text-right">{fmtInt(c.pieces_sent)}</td>
                  <td className="px-3 py-1.5 text-right">{fmtMoney(c.total_cost)}</td>
                  <td className="px-3 py-1.5 text-right">{c.total_responses}</td>
                  <td className="px-3 py-1.5 text-right">{c.responses}</td>
                  <td className="px-3 py-1.5 text-right text-zinc-500">{fmtPct(c.response_rate)}</td>
                  <td className="px-3 py-1.5 text-right">{c.leads}</td>
                  <td className="px-3 py-1.5 text-right">{c.offers}</td>
                  <td className="px-3 py-1.5 text-right text-zinc-500">{fmtPct(c.offer_rate)}</td>
                  <td className="px-3 py-1.5 text-right">{c.closed || "—"}</td>
                  <td className="px-3 py-1.5 text-right text-emerald-400">{fmtRoi(c.roi)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      </>
      )}

      {showNewModal && (
        <NewCampaignModal
          campaigns={campaigns ?? []}
          onClose={() => setShowNewModal(false)}
          onCreated={() => { setShowNewModal(false); void fetchData() }}
        />
      )}
    </div>
  )
}

// ── Legacy tab ─────────────────────────────────────────────────────────────
// Every mailing from before the system tracked campaigns (Nov 2021 → Feb
// 2026), entered from the ITI invoices: pieces, cost, and the closed deals
// that came from each. Responses weren't tracked back then, so this tab is
// about cost per deal, not response rate.
function LegacyView({ rows }: { rows: CampaignPerf[] }) {
  const sorted = [...rows].sort((a, b) => (b.drop_date ?? "").localeCompare(a.drop_date ?? ""))
  const pieces = rows.reduce((a, c) => a + (c.pieces_sent ?? 0), 0)
  const cost = rows.reduce((a, c) => a + (c.total_cost ?? 0), 0)
  const deals = rows.flatMap(c => c.closed_deals ?? [])
  const volume = deals.reduce((a, d) => a + (d.deal_value ?? 0), 0)
  if (rows.length === 0) {
    return <div className="rounded border border-zinc-800 bg-zinc-950 p-4 text-xs text-zinc-500">No legacy mailings recorded.</div>
  }
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-400">
        {rows.length} mailings since {fmtDate(sorted[sorted.length - 1]?.drop_date ?? null)} ·{" "}
        <span className="text-zinc-200">{fmtInt(pieces)}</span> pieces · <span className="text-zinc-200">{fmtMoney(cost)}</span> spent ·{" "}
        <span className="text-zinc-200">{deals.length}</span> closed deal{deals.length === 1 ? "" : "s"} ({fmtMoney(volume)} bought) ·{" "}
        <span className="text-emerald-300">{deals.length ? `${fmtMoney(cost / deals.length)} per deal` : "—"}</span>
        <div className="text-zinc-600 mt-1">From the mail-house invoices. Response counts weren't tracked before May 2026, so only closes are shown.</div>
      </div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-zinc-500 bg-zinc-900/50">
            <tr>
              <th className="text-left px-3 py-1.5">Mailed</th>
              <th className="text-left px-3 py-1.5">Mailing</th>
              <th className="text-right px-3 py-1.5">Pieces</th>
              <th className="text-right px-3 py-1.5">Cost</th>
              <th className="text-right px-3 py-1.5">$/pc</th>
              <th className="text-left px-3 py-1.5">Closed deals</th>
            </tr>
          </thead>
          <tbody className="text-zinc-300">
            {sorted.map(c => (
              <tr key={c.id} className="border-t border-zinc-900 align-top hover:bg-zinc-900/40">
                <td className="px-3 py-1.5 text-zinc-500 whitespace-nowrap">{fmtDate(c.drop_date)}</td>
                <td className="px-3 py-1.5">
                  <div>{c.name}</div>
                  {(c.notes || c.order_number) && (
                    <div className="text-[11px] text-zinc-600">{c.order_number ? `#${c.order_number} · ` : ""}{c.notes}</div>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right">{fmtInt(c.pieces_sent)}</td>
                <td className="px-3 py-1.5 text-right">{fmtMoney(c.total_cost)}</td>
                <td className="px-3 py-1.5 text-right text-zinc-500">{c.total_cost != null && c.pieces_sent ? `$${(c.total_cost / c.pieces_sent).toFixed(2)}` : "—"}</td>
                <td className="px-3 py-1.5">
                  {(c.closed_deals ?? []).length === 0 ? <span className="text-zinc-600">—</span> : (c.closed_deals ?? []).map((d, i) => (
                    <div key={i} className="text-emerald-300">
                      🏁 {d.address || d.name || "deal"} · {fmtMoney(d.deal_value)} · {fmtDate(d.closed_at ? d.closed_at.slice(0, 10) : null)}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ChildCard({ c }: { c: CampaignPerf }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-2 space-y-1.5">
      <div className="text-xs">
        <span className="text-zinc-200 font-medium">{c.name}</span>
        {c.variant && <span className="text-zinc-500"> · {c.variant}</span>}
      </div>
      <div className="text-[11px] text-zinc-400">
        {fmtInt(c.pieces_sent)} pieces · {fmtMoney(c.total_cost)}
      </div>
      <FunnelInline c={c} />
      {c.channel === "direct_mail" && <CampaignSegmentsPanel campaignId={c.id} />}
    </div>
  )
}

// The funnel Ryan agreed 2026-10-24. Total and Real are rated against
// pieces mailed; every stage below is rated against real responses. Removals
// and junk are shown so the overall number is always visible and the
// backing-out is explicit.
function FunnelInline({ c }: { c: CampaignPerf }) {
  const per = (n: number) => (c.total_cost != null && n > 0 ? c.total_cost / n : null)
  const ofReal = (n: number) => (c.responses > 0 ? n / c.responses : null)
  const rows: { label: string; n: number; rate: number | null; cost: number | null; sub?: boolean }[] = [
    { label: "Total responses", n: c.total_responses, rate: c.total_response_rate, cost: per(c.total_responses) },
    { label: "− Removals", n: c.removals, rate: null, cost: null, sub: true },
    { label: "− Junk / wrong person", n: c.junk, rate: null, cost: null, sub: true },
    { label: "Real responses", n: c.responses, rate: c.response_rate, cost: c.cost_per_response },
    { label: "Leads", n: c.leads, rate: c.lead_rate, cost: c.cost_per_lead },
    { label: "Appointment", n: c.appointments, rate: ofReal(c.appointments), cost: per(c.appointments) },
    { label: "Offer", n: c.offers, rate: c.offer_rate, cost: c.cost_per_offer },
    { label: "Pending", n: c.pending, rate: ofReal(c.pending), cost: per(c.pending) },
    { label: "Closed", n: c.closed, rate: ofReal(c.closed), cost: c.cost_per_closed },
  ]
  return (
    <div className="text-[11px] space-y-1">
      <table className="w-full font-mono">
        <tbody>
          {rows.map(r => (
            <tr key={r.label} className={r.sub ? "text-zinc-500" : "text-zinc-300"}>
              <td className={`py-0.5 ${r.sub ? "pl-3" : ""}`}>{r.label}</td>
              <td className="py-0.5 text-right">{r.n}</td>
              <td className="py-0.5 text-right text-zinc-500 w-16">{r.rate == null ? "" : fmtPct(r.rate)}</td>
              <td className="py-0.5 text-right text-zinc-500 w-20">{r.cost == null ? "" : `${fmtCost(r.cost)} ea`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="text-zinc-500">
        {c.deal_value_total > 0 && <>Closed value {fmtMoney(c.deal_value_total)} · </>}ROI: <span className={c.roi == null ? "text-zinc-500" : c.roi >= 0 ? "text-emerald-400" : "text-red-400"}>{fmtRoi(c.roi)}</span>
      </div>
    </div>
  )
}

function NewCampaignModal({
  campaigns, onClose, onCreated,
}: {
  campaigns: CampaignPerf[]
  onClose: () => void
  onCreated: () => void
}) {
  const [name, setName] = useState("")
  const [channel, setChannel] = useState<"direct_mail" | "google_ads">("direct_mail")
  const [dropDate, setDropDate] = useState("")
  const [piecesSent, setPiecesSent] = useState("")
  const [totalCost, setTotalCost] = useState("")
  const [variant, setVariant] = useState("")
  const [parentId, setParentId] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const parentChoices = campaigns.filter(c => !c.parent_campaign_id && c.channel === channel)

  async function submit() {
    if (!name.trim()) { setErr("Name is required."); return }
    setSubmitting(true)
    setErr(null)
    try {
      const body: Record<string, unknown> = { name: name.trim(), channel }
      if (dropDate) body.drop_date = dropDate
      if (piecesSent) {
        const n = parseInt(piecesSent, 10)
        if (Number.isFinite(n) && n >= 0) body.pieces_sent = n
      }
      if (totalCost) {
        const n = parseFloat(totalCost)
        if (Number.isFinite(n) && n >= 0) body.total_cost = n
      }
      if (variant.trim()) body.variant = variant.trim()
      if (parentId) body.parent_campaign_id = parentId
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
      onCreated()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-lg border border-zinc-800 bg-zinc-950 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
          <span className="text-sm font-medium text-zinc-100">New Campaign</span>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-900 text-zinc-400 hover:text-zinc-200">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-4 py-3 space-y-3 text-xs">
          <Field label="Name *">
            <input
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="MFM-A June 2026"
              className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 focus:outline-none focus:border-zinc-700"
              style={{ fontSize: 16 }}
            />
          </Field>
          <Field label="Channel *">
            <select
              value={channel}
              onChange={e => { setChannel(e.target.value as "direct_mail" | "google_ads"); setParentId("") }}
              className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 focus:outline-none focus:border-zinc-700"
            >
              <option value="direct_mail">Direct Mail</option>
              <option value="google_ads">Google Ads</option>
            </select>
          </Field>
          <Field label="Drop Date">
            <input
              type="date"
              value={dropDate}
              onChange={e => setDropDate(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 focus:outline-none focus:border-zinc-700"
            />
          </Field>
          {channel === "direct_mail" && (
            <Field label="Pieces Sent">
              <input
                type="number"
                value={piecesSent}
                onChange={e => setPiecesSent(e.target.value)}
                placeholder="6837"
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 focus:outline-none focus:border-zinc-700"
                style={{ fontSize: 16 }}
              />
            </Field>
          )}
          <Field label="Total Cost">
            <input
              type="number"
              step="0.01"
              value={totalCost}
              onChange={e => setTotalCost(e.target.value)}
              placeholder="4800.99"
              className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 focus:outline-none focus:border-zinc-700"
              style={{ fontSize: 16 }}
            />
          </Field>
          <Field label="Variant (e.g. pink-envelope, yellow-postcard)">
            <input
              value={variant}
              onChange={e => setVariant(e.target.value)}
              placeholder="pink-envelope"
              className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 focus:outline-none focus:border-zinc-700"
              style={{ fontSize: 16 }}
            />
          </Field>
          <Field label="Parent Campaign (for A/B variants)">
            <select
              value={parentId}
              onChange={e => setParentId(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-100 focus:outline-none focus:border-zinc-700"
            >
              <option value="">(none — standalone campaign)</option>
              {parentChoices.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </Field>
        </div>
        {err && (
          <div className="mx-4 mb-3 rounded border border-red-900/50 bg-red-950/30 px-2 py-1.5 text-[11px] text-red-200">{err}</div>
        )}
        <div className="px-4 py-3 border-t border-zinc-800 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 min-h-[34px] rounded text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={submitting}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[34px] rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-xs font-medium transition-colors"
          >
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            Create
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-zinc-500 text-[11px] uppercase tracking-wide">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  )
}
