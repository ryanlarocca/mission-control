"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2, Search, X } from "lucide-react"

// Direct-mail tracking — one mailed piece per `mail_records` row. The lead
// card links a responder to the record they answered; this picker is the
// manual path (auto-match handles the clean cases at intake).
//
// Shape mirrors GET /api/mail-records/search. Declared here (not imported
// from app/api) so the widget stays decoupled from the route module.
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

export async function fetchMailRecordsByIds(ids: string[]): Promise<MailRecordLite[]> {
  if (ids.length === 0) return []
  const res = await fetch(`/api/mail-records/search?ids=${encodeURIComponent(ids.join(","))}`, { cache: "no-store" })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json() as { records?: MailRecordLite[] }
  return data.records ?? []
}

/** "owner · site, city · arm X · batch N" — the one-line label used on the lead card. */
export function describeMailRecord(r: MailRecordLite): string {
  const parts: string[] = []
  if (r.owner_name) parts.push(r.owner_name)
  const site = [r.site_address, r.site_city].filter(Boolean).join(", ")
  if (site) parts.push(site)
  parts.push(`arm ${r.arm}`)
  if (r.batch != null) parts.push(`batch ${r.batch}`)
  return parts.join(" · ")
}

export function MailRecordPicker(props: {
  open: boolean
  onClose: () => void
  campaignId: string | null
  candidateIds: string[]
  initialQuery: string
  onPick: (record: MailRecordLite) => void
}) {
  const { open, onClose, campaignId, candidateIds, initialQuery, onPick } = props
  const [query, setQuery] = useState(initialQuery)
  const [results, setResults] = useState<MailRecordLite[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<MailRecordLite[]>([])
  const [candidatesLoading, setCandidatesLoading] = useState(false)
  const latestSearchRef = useRef(0)

  // Reset the box to the lead-derived prefill every time the modal opens.
  useEffect(() => {
    if (open) setQuery(initialQuery)
  }, [open, initialQuery])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, onClose])

  // Suggested = the auto-matcher's near-misses (several hits, none attached).
  const candidateKey = candidateIds.join(",")
  useEffect(() => {
    if (!open || !candidateKey) { setCandidates([]); return }
    let cancelled = false
    setCandidatesLoading(true)
    fetchMailRecordsByIds(candidateKey.split(","))
      .then(recs => { if (!cancelled) setCandidates(recs) })
      .catch(() => { if (!cancelled) setCandidates([]) })
      .finally(() => { if (!cancelled) setCandidatesLoading(false) })
    return () => { cancelled = true }
  }, [open, candidateKey])

  // Debounced search (300ms, ≥2 chars). Out-of-order responses are dropped
  // via the sequence ref so a slow early query can't overwrite a later one.
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (q.length < 2) { setResults([]); setSearching(false); setSearchError(null); return }
    const seq = ++latestSearchRef.current
    const t = window.setTimeout(async () => {
      setSearching(true)
      try {
        const params = new URLSearchParams({ q })
        if (campaignId) params.set("campaign", campaignId)
        const res = await fetch(`/api/mail-records/search?${params.toString()}`, { cache: "no-store" })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json() as { records?: MailRecordLite[] }
        if (seq !== latestSearchRef.current) return
        setResults(data.records ?? [])
        setSearchError(null)
      } catch (e) {
        if (seq !== latestSearchRef.current) return
        setResults([])
        setSearchError(e instanceof Error ? e.message : String(e))
      } finally {
        if (seq === latestSearchRef.current) setSearching(false)
      }
    }, 300)
    return () => window.clearTimeout(t)
  }, [open, query, campaignId])

  if (!open) return null

  const candidateIdSet = new Set(candidates.map(c => c.id))
  const searchRows = results.filter(r => !candidateIdSet.has(r.id))

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl rounded-lg border border-zinc-800 bg-zinc-950 shadow-xl overflow-hidden flex flex-col max-h-[90vh]"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
          <span className="text-zinc-100 font-medium">📬 Link mailed record</span>
          <span className="text-[11px] text-zinc-500">
            {campaignId ? "this campaign" : "all campaigns"}
          </span>
          <button
            onClick={onClose}
            className="ml-auto p-1 rounded hover:bg-zinc-900 text-zinc-400 hover:text-zinc-200"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-3 border-b border-zinc-800">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              autoFocus
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Street or last name…"
              className="w-full bg-zinc-900 border border-zinc-800 rounded pl-8 pr-8 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-700"
              style={{ fontSize: 16 }}
            />
            {searching && (
              <Loader2 className="w-3.5 h-3.5 text-zinc-500 animate-spin absolute right-2.5 top-1/2 -translate-y-1/2" />
            )}
          </div>
        </div>

        <div className="overflow-y-auto">
          {(candidateIds.length > 0) && (
            <div>
              <div className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-wider text-amber-300/80">
                Suggested
                {candidatesLoading && <Loader2 className="inline w-3 h-3 animate-spin ml-1.5 align-middle" />}
              </div>
              {candidates.length === 0 && !candidatesLoading && (
                <div className="px-4 pb-2 text-xs text-zinc-600">Candidates no longer available.</div>
              )}
              {candidates.map(r => <RecordRow key={r.id} r={r} onPick={onPick} suggested />)}
            </div>
          )}

          <div className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-wider text-zinc-500">Search</div>
          {searchError && (
            <div className="px-4 pb-2 text-xs text-red-300">{searchError}</div>
          )}
          {query.trim().length < 2 && (
            <div className="px-4 pb-3 text-xs text-zinc-600">Type at least 2 characters.</div>
          )}
          {query.trim().length >= 2 && !searching && !searchError && searchRows.length === 0 && (
            <div className="px-4 pb-3 text-xs text-zinc-600">No mailed records match.</div>
          )}
          {searchRows.map(r => <RecordRow key={r.id} r={r} onPick={onPick} />)}
          <div className="h-2" />
        </div>
      </div>
    </div>
  )
}

const ARM_CHIP: Record<MailRecordLite["arm"], string> = {
  A:    "bg-sky-900/60 text-sky-200",
  B:    "bg-purple-900/60 text-purple-200",
  C:    "bg-teal-900/60 text-teal-200",
  none: "bg-zinc-800 text-zinc-400",
  seed: "bg-amber-900/60 text-amber-200",
}

function RecordRow({ r, onPick, suggested }: { r: MailRecordLite; onPick: (r: MailRecordLite) => void; suggested?: boolean }) {
  const site = [r.site_address, r.site_city, r.site_zip].filter(Boolean).join(", ")
  const mail = [r.mail_address, r.mail_city].filter(Boolean).join(", ")
  return (
    <button
      onClick={() => onPick(r)}
      className={`w-full text-left px-4 py-2 border-t border-zinc-900 hover:bg-zinc-900/60 transition-colors flex items-start gap-3 ${
        suggested ? "bg-amber-950/10" : ""
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm text-zinc-100 truncate">
          {r.owner_name || <span className="text-zinc-500 italic">(no owner name)</span>}
        </div>
        <div className="text-xs text-zinc-400 truncate">🏠 {site || "—"}</div>
        {mail && mail !== site && (
          <div className="text-xs text-zinc-500 truncate">✉️ {mail}</div>
        )}
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        <span className={`px-1.5 py-0.5 text-[9px] font-semibold rounded uppercase tracking-wider ${ARM_CHIP[r.arm] ?? ARM_CHIP.none}`}>
          {r.arm === "none" ? "not mailed" : `arm ${r.arm}`}{r.batch != null ? ` · b${r.batch}` : ""}
        </span>
        {r.county && <span className="text-[10px] text-zinc-500">{r.county}</span>}
      </div>
    </button>
  )
}
