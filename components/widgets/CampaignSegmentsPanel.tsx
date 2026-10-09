"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react"

// Direct-mail segment report — which slices of a mailed list actually
// produced responders. Reads GET /api/campaigns/[id]/segments lazily on
// first expand; collapsed by default so the Campaign Performance page
// doesn't fan out one request per campaign on load.

interface SegmentRow {
  segment: string
  pieces: number
  responders: number
  per_thousand: number
  cost_per_response: number | null
}

interface SegmentsPayload {
  has_mail_records: boolean
  pieces: number
  responders_matched: number
  responders_unmatched: number
  responders_in_list_not_mailed: number
  unit_cost: number | null
  dimensions: Record<string, SegmentRow[]>
}

// Pill order + labels. Dimensions the API returns that aren't listed here
// render after these, with the raw key as the label.
const DIMENSIONS: { key: string; label: string }[] = [
  { key: "arm",                   label: "Arm" },
  { key: "county",                label: "County" },
  { key: "batch",                 label: "Batch" },
  { key: "tenure_bucket",         label: "Tenure" },
  { key: "imp_tercile",           label: "Improvement" },
  { key: "year_built_bucket",     label: "Year built" },
  { key: "owner_type",            label: "Owner type" },
  { key: "estate_language",       label: "Estate" },
  { key: "family_transfer",       label: "Family transfer" },
  { key: "out_of_state",          label: "Out of state" },
  { key: "multi_parcel_personal", label: "Multi-parcel" },
  { key: "any_signal",            label: "Any signal" },
  { key: "po_box",                label: "PO box" },
  { key: "managed",               label: "Managed" },
  { key: "out_of_county",         label: "Out of county" },
]

// Dimensions whose segments have an inherent order — keep the API's order
// (A, B, C / low, mid, high / year ranges) instead of sorting by rate.
const NATURAL_ORDER = new Set(["arm", "tenure_bucket", "imp_tercile", "year_built_bucket"])

function fmtInt(n: number): string { return n.toLocaleString() }
function fmtRate(n: number): string { return n.toFixed(2) }
function fmtCost(n: number | null): string {
  if (n == null) return "—"
  return `$${Math.round(n).toLocaleString()}`
}

export function CampaignSegmentsPanel({ campaignId }: { campaignId: string }) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<SegmentsPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dim, setDim] = useState<string>("arm")

  // Fetch once — on first expand. Re-expanding reuses the cached payload.
  const requestedRef = useRef(false)
  useEffect(() => {
    if (!open || requestedRef.current) return
    requestedRef.current = true
    let cancelled = false
    setLoading(true)
    fetch(`/api/campaigns/${campaignId}/segments`, { cache: "no-store" })
      .then(async res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return await res.json() as SegmentsPayload
      })
      .then(payload => { if (!cancelled) { setData(payload); setError(null) } })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, campaignId])

  const pills = useMemo(() => {
    if (!data) return []
    const known = DIMENSIONS.filter(d => Array.isArray(data.dimensions[d.key]))
    const extra = Object.keys(data.dimensions)
      .filter(k => !DIMENSIONS.some(d => d.key === k))
      .map(k => ({ key: k, label: k }))
    return [...known, ...extra]
  }, [data])

  // Fall back to the first available dimension if the default isn't present.
  const activeDim = pills.some(p => p.key === dim) ? dim : (pills[0]?.key ?? dim)

  const rows = useMemo(() => {
    if (!data) return []
    const list = data.dimensions[activeDim] ?? []
    if (NATURAL_ORDER.has(activeDim)) return list
    return [...list].sort((a, b) => b.per_thousand - a.per_thousand)
  }, [data, activeDim])

  return (
    <div className="text-[11px]">
      <button
        onClick={() => setOpen(v => !v)}
        className="inline-flex items-center gap-1 text-zinc-400 hover:text-zinc-200 transition-colors"
        title="Which list segments produced responders"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        Segments
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          {loading && (
            <div className="inline-flex items-center gap-1.5 text-zinc-500">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading segments…
            </div>
          )}
          {error && (
            <div className="rounded border border-red-900/50 bg-red-950/30 px-2 py-1.5 text-red-200">{error}</div>
          )}
          {data && !data.has_mail_records && (
            <div className="text-zinc-500">No mailed records imported yet.</div>
          )}
          {data && data.has_mail_records && (
            <>
              <div className="text-zinc-400 tabular-nums">
                {fmtInt(data.pieces)} pieces ·{" "}
                <span className="text-emerald-300">{fmtInt(data.responders_matched)}</span> matched ·{" "}
                <span className="text-zinc-300">{fmtInt(data.responders_unmatched)}</span> unmatched ·{" "}
                <span className="text-zinc-300">{fmtInt(data.responders_in_list_not_mailed)}</span> in list, not mailed
                {data.unit_cost != null && (
                  <span className="text-zinc-500"> · ${data.unit_cost.toFixed(2)}/piece</span>
                )}
              </div>

              <div className="flex flex-wrap gap-1">
                {pills.map(p => {
                  const active = p.key === activeDim
                  return (
                    <button
                      key={p.key}
                      onClick={() => setDim(p.key)}
                      className={`px-2 py-0.5 rounded-full border transition-colors ${
                        active
                          ? "bg-zinc-100 text-zinc-900 border-zinc-100"
                          : "bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-100 hover:border-zinc-700"
                      }`}
                    >
                      {p.label}
                    </button>
                  )
                })}
              </div>

              <div className="rounded border border-zinc-800 overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead className="text-zinc-500 bg-zinc-900/50">
                    <tr>
                      <th className="text-left px-2 py-1 font-medium">Segment</th>
                      <th className="text-right px-2 py-1 font-medium">Pieces</th>
                      <th className="text-right px-2 py-1 font-medium">Responders</th>
                      <th className="text-right px-2 py-1 font-medium">per 1,000</th>
                      <th className="text-right px-2 py-1 font-medium">$/response</th>
                    </tr>
                  </thead>
                  <tbody className="text-zinc-300 tabular-nums">
                    {rows.length === 0 && (
                      <tr><td colSpan={5} className="px-2 py-1.5 text-zinc-600">No rows for this dimension.</td></tr>
                    )}
                    {rows.map(r => (
                      <tr key={r.segment} className="border-t border-zinc-900 hover:bg-zinc-900/40">
                        <td className="px-2 py-1 text-zinc-200">{r.segment}</td>
                        <td className="px-2 py-1 text-right">{fmtInt(r.pieces)}</td>
                        <td className="px-2 py-1 text-right">{fmtInt(r.responders)}</td>
                        <td className="px-2 py-1 text-right text-emerald-300">{fmtRate(r.per_thousand)}</td>
                        <td className="px-2 py-1 text-right text-zinc-400">{fmtCost(r.cost_per_response)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="text-zinc-600">Segment rates count matched responders only.</div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
