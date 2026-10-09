"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "next/navigation"
import type { CampaignZip, CampaignListParams } from "@/app/api/campaigns/[id]/zips/route"

// Direct-mail list-build picker, two modes:
//  • Zip cut — one row per site zip, grouped by county, biggest first. Tapping
//    a row flips `exclude` (list-wide removal, Step 6). Running totals show what
//    the list looks like after the cut.
//  • Arm A — size Arm A on the no-signal pool: set a tenure floor, see the
//    running Arm A count by zip, tap a zip to trim it from Arm A ONLY (those
//    rows stay in the file as arm = none; not an exclusion). Step 9 reads the
//    floor + trims back.

type Campaign = { id: string; name: string }
type Mode = "cut" | "armA"

/** Pool rows in a zip with tenure ≥ floor (hist keys are half-year floors). */
function poolAtFloor(hist: Record<string, number> | null, floor: number): number {
  if (!hist) return 0
  let n = 0
  for (const [k, v] of Object.entries(hist)) if (Number(k) >= floor) n += v
  return n
}
function poolTotal(hist: Record<string, number> | null): number {
  return hist ? Object.values(hist).reduce((a, b) => a + b, 0) : 0
}

export function ZipCutTab() {
  const params = useSearchParams()
  const campaignParam = params.get("campaign")
  const [mode, setMode] = useState<Mode>(params.get("mode") === "armA" ? "armA" : "cut")
  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [zips, setZips] = useState<CampaignZip[]>([])
  const [listParams, setListParams] = useState<CampaignListParams>({ arm_a_tenure_floor: null, arm_a_target: null, arm_b_count: null })
  const [floor, setFloor] = useState<number>(25)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<Set<string>>(new Set())
  const [floorSaving, setFloorSaving] = useState(false)
  const [countyFilter, setCountyFilter] = useState<string>("all")
  const floorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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
      const lp: CampaignListParams = j.list_params ?? { arm_a_tenure_floor: null, arm_a_target: null, arm_b_count: null }
      setListParams(lp)
      if (lp.arm_a_tenure_floor != null) setFloor(lp.arm_a_tenure_floor)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [campaignParam])

  useEffect(() => {
    void load()
  }, [load])

  // Flip one boolean on one row; optimistic, rolled back on failure so the
  // screen never lies about what's saved.
  const flip = useCallback(
    async (z: CampaignZip, field: "exclude" | "arm_a_trim") => {
      if (!campaign) return
      const next = !z[field]
      setZips(prev => prev.map(r => (r.id === z.id ? { ...r, [field]: next } : r)))
      setSaving(prev => new Set(prev).add(z.id))
      try {
        const res = await fetch(`/api/campaigns/${campaign.id}/zips`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: z.id, [field]: next }),
        })
        if (!res.ok) {
          const j = await res.json().catch(() => ({}))
          throw new Error(j.error || `HTTP ${res.status}`)
        }
      } catch (e) {
        setZips(prev => prev.map(r => (r.id === z.id ? { ...r, [field]: !next } : r)))
        setError(`Save failed for ${z.zip}: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setSaving(prev => {
          const s = new Set(prev)
          s.delete(z.id)
          return s
        })
      }
    },
    [campaign]
  )

  // Floor: update the count instantly, save 400 ms after the last change.
  const changeFloor = useCallback(
    (next: number) => {
      const f = Math.max(11, Math.min(60, Math.round(next * 2) / 2))
      setFloor(f)
      if (!campaign) return
      if (floorTimer.current) clearTimeout(floorTimer.current)
      floorTimer.current = setTimeout(async () => {
        setFloorSaving(true)
        try {
          const res = await fetch(`/api/campaigns/${campaign.id}/zips`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ arm_a_tenure_floor: f }),
          })
          if (!res.ok) {
            const j = await res.json().catch(() => ({}))
            throw new Error(j.error || `HTTP ${res.status}`)
          }
          setListParams(p => ({ ...p, arm_a_tenure_floor: f }))
        } catch (e) {
          setError(`Floor save failed: ${e instanceof Error ? e.message : String(e)}`)
        } finally {
          setFloorSaving(false)
        }
      }, 400)
    },
    [campaign]
  )

  const counties = useMemo(() => Array.from(new Set(zips.map(z => z.county ?? "—"))), [zips])

  // Zip-cut totals (rows in the cleaned list, before dedupe).
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

  // Arm A totals at the current floor (pool = deduped no-signal rows in kept zips).
  const armA = useMemo(() => {
    const per: Record<string, { pool: number; atFloor: number; kept: number; trimmed: number }> = {}
    for (const z of zips) {
      if (z.exclude || !z.arm_a_hist) continue
      const c = z.county ?? "—"
      per[c] ??= { pool: 0, atFloor: 0, kept: 0, trimmed: 0 }
      const n = poolAtFloor(z.arm_a_hist, floor)
      per[c].pool += poolTotal(z.arm_a_hist)
      per[c].atFloor += n
      if (z.arm_a_trim) per[c].trimmed += 1
      else per[c].kept += n
    }
    const all = Object.values(per).reduce(
      (a, v) => ({ pool: a.pool + v.pool, atFloor: a.atFloor + v.atFloor, kept: a.kept + v.kept, trimmed: a.trimmed + v.trimmed }),
      { pool: 0, atFloor: 0, kept: 0, trimmed: 0 }
    )
    return { per, all }
  }, [zips, floor])

  const visible = useMemo(() => {
    let v = countyFilter === "all" ? zips : zips.filter(z => (z.county ?? "—") === countyFilter)
    if (mode === "armA") {
      // Only zips with pool rows; stable order by pool size so rows don't jump as the floor moves.
      v = v.filter(z => !z.exclude && z.arm_a_hist).slice().sort((a, b) => {
        const c = (a.county ?? "").localeCompare(b.county ?? "")
        return c !== 0 ? c : poolTotal(b.arm_a_hist) - poolTotal(a.arm_a_hist)
      })
    }
    return v
  }, [zips, countyFilter, mode])

  if (loading) return <div className="p-4 text-sm text-zinc-500">Loading zips…</div>

  const target = listParams.arm_a_target
  const armB = listParams.arm_b_count
  const diff = target != null ? armA.all.kept - target : null
  const gridCols = mode === "armA" ? "grid-cols-[28px_60px_1fr_60px_56px_48px]" : "grid-cols-[28px_60px_1fr_56px_52px_52px]"

  return (
    <div className="p-3 sm:p-4 max-w-3xl mx-auto space-y-3">
      <div className="sticky top-0 z-10 bg-zinc-950/95 backdrop-blur border-b border-zinc-800 pb-2 -mx-3 px-3 sm:-mx-4 sm:px-4">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-base font-semibold text-zinc-100">
            {mode === "cut" ? "Zip cut" : "Arm A sizing"} — {campaign?.name ?? ""}
          </h1>
          <div className="flex rounded-full border border-zinc-700 overflow-hidden text-[11px]">
            {(["cut", "armA"] as Mode[]).map(m => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-2.5 py-1 ${mode === m ? "bg-zinc-100 text-zinc-900" : "text-zinc-300"}`}
              >
                {m === "cut" ? "Zip cut" : "Arm A"}
              </button>
            ))}
          </div>
        </div>

        {mode === "cut" ? (
          <>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              Tap a row to drop that zip from the whole list. Saves instantly. Counts are rows in the cleaned list (before dedupe).
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
          </>
        ) : (
          <>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              Set the tenure floor, then tap zips to trim them from Arm A only (they stay in the file as arm = none). Counts are deduped no-signal rows.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
              <div className="flex items-center rounded border border-zinc-700 overflow-hidden">
                <button onClick={() => changeFloor(floor - 0.5)} className="px-3 py-1.5 text-zinc-200 hover:bg-zinc-800 text-base leading-none" aria-label="Lower floor">−</button>
                <span className="px-2 py-1 text-zinc-100 tabular-nums">
                  ≥ <b className="text-[13px]">{floor.toFixed(1)}</b> yrs{floorSaving && <span className="text-zinc-500"> · saving</span>}
                </span>
                <button onClick={() => changeFloor(floor + 0.5)} className="px-3 py-1.5 text-zinc-200 hover:bg-zinc-800 text-base leading-none" aria-label="Raise floor">+</button>
              </div>
              <span className="px-2 py-1 rounded bg-zinc-800 text-zinc-200">
                Arm A <b className={diff != null && Math.abs(diff) <= 150 ? "text-emerald-300" : "text-amber-300"}>{armA.all.kept.toLocaleString()}</b>
                {target != null && (
                  <>
                    {" "}/ {target.toLocaleString()}{" "}
                    <span className="text-zinc-400">({diff! >= 0 ? "+" : ""}{diff!.toLocaleString()})</span>
                  </>
                )}
              </span>
              {armB != null && (
                <span className="px-2 py-1 rounded bg-zinc-900 text-zinc-400">
                  + Arm B {armB.toLocaleString()} = <b className="text-zinc-200">{(armA.all.kept + armB).toLocaleString()}</b> mailed
                </span>
              )}
              <span className="px-2 py-1 rounded bg-zinc-900 text-zinc-500">
                {armA.all.atFloor.toLocaleString()} at floor · {armA.all.trimmed} zips trimmed · pool {armA.all.pool.toLocaleString()}
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
              {counties.filter(c => armA.per[c]).map(c => (
                <span key={c} className="px-2 py-1 rounded bg-zinc-900 text-zinc-400">
                  {c}: <b className="text-zinc-200">{armA.per[c].kept.toLocaleString()}</b> / {armA.per[c].pool.toLocaleString()}
                </span>
              ))}
            </div>
          </>
        )}

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
        <div className={`grid ${gridCols} gap-2 px-3 py-1.5 text-[10px] uppercase tracking-wider text-zinc-500 bg-zinc-900/60`}>
          <span />
          <span>Zip</span>
          <span>City</span>
          {mode === "cut" ? (
            <>
              <span className="text-right">Rows</span>
              <span className="text-right">Built</span>
              <span className="text-right">Yrs</span>
            </>
          ) : (
            <>
              <span className="text-right">≥ {floor.toFixed(1)}</span>
              <span className="text-right">Pool</span>
              <span className="text-right">Yrs</span>
            </>
          )}
        </div>
        {visible.map((z, i) => {
          const prevCounty = i > 0 ? visible[i - 1].county : null
          const showCounty = countyFilter === "all" && z.county !== prevCounty
          const off = mode === "cut" ? z.exclude : z.arm_a_trim
          const offCls = mode === "cut" ? "bg-red-950/40 text-zinc-500 line-through decoration-red-700" : "bg-amber-950/40 text-zinc-500 line-through decoration-amber-700"
          const boxCls = mode === "cut" ? "bg-red-700 border-red-600 text-white" : "bg-amber-600 border-amber-500 text-white"
          const atFloor = mode === "armA" ? poolAtFloor(z.arm_a_hist, floor) : 0
          return (
            <div key={z.id}>
              {showCounty && (
                <div className="px-3 py-1 text-[11px] font-semibold text-zinc-300 bg-zinc-900 border-y border-zinc-800">
                  {z.county}
                </div>
              )}
              <button
                onClick={() => flip(z, mode === "cut" ? "exclude" : "arm_a_trim")}
                disabled={saving.has(z.id)}
                className={`w-full grid ${gridCols} gap-2 items-center px-3 py-2.5 text-left text-sm border-b border-zinc-900 transition-colors ${
                  off ? offCls : "hover:bg-zinc-900/60 text-zinc-100"
                }`}
              >
                <span className={`w-5 h-5 rounded border flex items-center justify-center text-[11px] ${off ? boxCls : "border-zinc-600"}`}>
                  {off ? "✕" : ""}
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
                {mode === "cut" ? (
                  <>
                    <span className="text-right tabular-nums">{z.rows.toLocaleString()}</span>
                    <span className="text-right tabular-nums text-zinc-400">{z.median_year_built ?? "—"}</span>
                    <span className="text-right tabular-nums text-zinc-400">{z.median_tenure_years ?? "—"}</span>
                  </>
                ) : (
                  <>
                    <span className={`text-right tabular-nums ${atFloor === 0 ? "text-zinc-600" : ""}`}>{atFloor.toLocaleString()}</span>
                    <span className="text-right tabular-nums text-zinc-400">{poolTotal(z.arm_a_hist).toLocaleString()}</span>
                    <span className="text-right tabular-nums text-zinc-400">{z.median_tenure_years ?? "—"}</span>
                  </>
                )}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
