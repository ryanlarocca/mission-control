"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useSearchParams } from "next/navigation"
import type { CampaignZip } from "@/app/api/campaigns/[id]/zips/route"

// Zip-cut picker for a direct-mail list build. One row per site zip, grouped
// by county, biggest first. Tapping a row flips `exclude` and saves at once.
// Running totals show what the list looks like after the cut. The list-build
// script reads exclude = true back as the Step 6 zip cut.

type Campaign = { id: string; name: string }

export function ZipCutTab() {
  const params = useSearchParams()
  const campaignParam = params.get("campaign")
  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [zips, setZips] = useState<CampaignZip[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<Set<string>>(new Set())
  const [countyFilter, setCountyFilter] = useState<string>("all")

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      let id = campaignParam
      if (!id) {
        // Newest campaign — the picker is only ever loaded for the campaign
        // currently being built, so "latest" is the right default.
        const res = await fetch("/api/campaigns", { cache: "no-store" })
        const j = await res.json()
        const list: { id: string; created_at: string }[] = j.campaigns ?? []
        list.sort((a, b) => b.created_at.localeCompare(a.created_at))
        id = list[0]?.id ?? null
      }
      if (!id) throw new Error("No campaign found")
      const res = await fetch(`/api/campaigns/${id}/zips`, { cache: "no-store" })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
      setCampaign(j.campaign)
      setZips(j.zips)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [campaignParam])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = useCallback(
    async (z: CampaignZip) => {
      if (!campaign) return
      const next = !z.exclude
      setZips(prev => prev.map(r => (r.zip === z.zip ? { ...r, exclude: next } : r)))
      setSaving(prev => new Set(prev).add(z.zip))
      try {
        const res = await fetch(`/api/campaigns/${campaign.id}/zips`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ zip: z.zip, exclude: next }),
        })
        if (!res.ok) {
          const j = await res.json().catch(() => ({}))
          throw new Error(j.error || `HTTP ${res.status}`)
        }
      } catch (e) {
        // Roll back the optimistic flip so the screen never lies about what's saved.
        setZips(prev => prev.map(r => (r.zip === z.zip ? { ...r, exclude: !next } : r)))
        setError(`Save failed for ${z.zip}: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setSaving(prev => {
          const s = new Set(prev)
          s.delete(z.zip)
          return s
        })
      }
    },
    [campaign]
  )

  const counties = useMemo(() => Array.from(new Set(zips.map(z => z.county ?? "—"))), [zips])
  const totals = useMemo(() => {
    const per: Record<string, { rows: number; kept: number; zips: number; excluded: number }> = {}
    for (const z of zips) {
      const c = z.county ?? "—"
      per[c] ??= { rows: 0, kept: 0, zips: 0, excluded: 0 }
      per[c].rows += z.rows
      per[c].zips += 1
      if (z.exclude) per[c].excluded += 1
      else per[c].kept += z.rows
    }
    const all = Object.values(per).reduce(
      (a, v) => ({ rows: a.rows + v.rows, kept: a.kept + v.kept, zips: a.zips + v.zips, excluded: a.excluded + v.excluded }),
      { rows: 0, kept: 0, zips: 0, excluded: 0 }
    )
    return { per, all }
  }, [zips])

  const visible = countyFilter === "all" ? zips : zips.filter(z => (z.county ?? "—") === countyFilter)

  if (loading) return <div className="p-4 text-sm text-zinc-500">Loading zips…</div>

  return (
    <div className="p-3 sm:p-4 max-w-3xl mx-auto space-y-3">
      <div className="sticky top-0 z-10 bg-zinc-950/95 backdrop-blur border-b border-zinc-800 pb-2 -mx-3 px-3 sm:-mx-4 sm:px-4">
        <h1 className="text-base font-semibold text-zinc-100">Zip cut — {campaign?.name ?? ""}</h1>
        <p className="text-[11px] text-zinc-500 mt-0.5">
          Tap a row to drop that zip. Saves instantly. Counts are rows in the cleaned list (before dedupe).
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
          <span className="px-2 py-1 rounded bg-zinc-800 text-zinc-200">
            Keeping <b className="text-emerald-300">{totals.all.kept.toLocaleString()}</b> of {totals.all.rows.toLocaleString()} ·{" "}
            {totals.all.excluded} of {totals.all.zips} zips dropped
          </span>
          {counties.map(c => (
            <span key={c} className="px-2 py-1 rounded bg-zinc-900 text-zinc-400">
              {c}: <b className="text-zinc-200">{totals.per[c].kept.toLocaleString()}</b> / {totals.per[c].rows.toLocaleString()}
            </span>
          ))}
        </div>
        <div className="mt-2 flex gap-1.5 text-[11px]">
          {["all", ...counties].map(c => (
            <button
              key={c}
              onClick={() => setCountyFilter(c)}
              className={`px-2.5 py-1 rounded-full border ${
                countyFilter === c ? "bg-zinc-100 text-zinc-900 border-zinc-100" : "border-zinc-700 text-zinc-300"
              }`}
            >
              {c === "all" ? "All counties" : c}
            </button>
          ))}
        </div>
        {error && <div className="mt-2 text-[11px] text-red-300">{error}</div>}
      </div>

      <div className="rounded-md border border-zinc-800 overflow-hidden">
        <div className="grid grid-cols-[28px_60px_1fr_56px_52px_52px] gap-2 px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500 bg-zinc-900/60">
          <span />
          <span>Zip</span>
          <span>City</span>
          <span className="text-right">Rows</span>
          <span className="text-right">Built</span>
          <span className="text-right">Yrs</span>
        </div>
        {visible.map((z, i) => {
          const prevCounty = i > 0 ? visible[i - 1].county : null
          const showCounty = countyFilter === "all" && z.county !== prevCounty
          return (
            <div key={z.zip}>
              {showCounty && (
                <div className="px-3 py-1 text-[11px] font-semibold text-zinc-300 bg-zinc-900 border-y border-zinc-800">
                  {z.county}
                </div>
              )}
              <button
                onClick={() => toggle(z)}
                disabled={saving.has(z.zip)}
                className={`w-full grid grid-cols-[28px_60px_1fr_56px_52px_52px] gap-2 items-center px-3 py-2.5 text-left text-sm border-b border-zinc-900 transition-colors ${
                  z.exclude ? "bg-red-950/40 text-zinc-500 line-through decoration-red-700" : "hover:bg-zinc-900/60 text-zinc-100"
                }`}
              >
                <span
                  className={`w-5 h-5 rounded border flex items-center justify-center text-[11px] ${
                    z.exclude ? "bg-red-700 border-red-600 text-white" : "border-zinc-600"
                  }`}
                >
                  {z.exclude ? "✕" : ""}
                </span>
                <span className="font-mono text-[13px]">{z.zip}</span>
                <span className="truncate">
                  {z.city}
                  <a
                    href={`https://www.google.com/maps/search/${z.zip}+${encodeURIComponent(z.county ?? "")}+County+CA`}
                    target="_blank"
                    rel="noreferrer"
                    onClick={e => e.stopPropagation()}
                    className="ml-2 text-[10px] text-sky-400 no-underline"
                  >
                    map
                  </a>
                </span>
                <span className="text-right tabular-nums">{z.rows.toLocaleString()}</span>
                <span className="text-right tabular-nums text-zinc-400">{z.median_year_built ?? "—"}</span>
                <span className="text-right tabular-nums text-zinc-400">{z.median_tenure_years ?? "—"}</span>
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
