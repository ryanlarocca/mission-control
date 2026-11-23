"use client"

import { useCallback, useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"

// One-off lead review (/leads/review). Ryan reads each person's whole history
// and taps what should happen to them. Taps only RECORD the pick
// (/api/lead-review → lead_review_picks); nothing moves on a lead until the
// picks are applied afterwards, on his say-so.

type Decision = "followup" | "autopilot" | "leave" | "dead"

type Person = {
  person_key: string
  phone: string | null
  email: string | null
  name: string | null
  address: string | null
  planned_date: string | null
  judge_guess: string | null
  decision: Decision | null
  decision_date: string | null
  note: string | null
  status: string | null
  source: string | null
  offer: number | null
  campaign: string | null
  current_followup: string | null
  current_reason: string | null
  from_them: number
  last_from_them: string | null
  first_at: string | null
}

type Event = { at: string; kind: string; fromThem: boolean; text: string; summary: string; notes: string; seconds: number | null }

const CHOICES: { key: Decision; label: string; tone: string }[] = [
  { key: "followup", label: "Follow Ups", tone: "bg-emerald-600 border-emerald-500" },
  { key: "autopilot", label: "Autopilot", tone: "bg-sky-600 border-sky-500" },
  { key: "leave", label: "Leave as is", tone: "bg-zinc-600 border-zinc-500" },
  { key: "dead", label: "Dead", tone: "bg-rose-700 border-rose-600" },
]

function day(s: string | null): string {
  if (!s) return "—"
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return s
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
}
function stamp(s: string | null): string {
  if (!s) return "never"
  return new Date(s).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
}
function shortDay(s: string | null): string {
  if (!s) return "never"
  return new Date(s).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric" })
}
function phoneFmt(p: string | null): string {
  if (!p) return ""
  const m = p.match(/^\+1(\d{3})(\d{3})(\d{4})$/)
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : p
}
function decisionText(p: Person): string {
  switch (p.decision) {
    case "followup": return `Follow Ups · ${day(p.decision_date || p.planned_date)}`
    case "autopilot": return p.email && !p.phone ? "Autopilot (email)" : "Autopilot"
    case "leave": return "Leave as is"
    case "dead": return "Dead"
    default: return ""
  }
}

function History({ batch, person }: { batch: string; person: Person }) {
  const [events, setEvents] = useState<Event[] | null>(null)
  const [cell, setCell] = useState<boolean | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  useEffect(() => {
    let live = true
    fetch(`/api/lead-review?batch=${encodeURIComponent(batch)}&key=${encodeURIComponent(person.person_key)}`, { cache: "no-store" })
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j })
      .then((j) => { if (live) { setEvents(j.events); setCell(j.cellTexts) } })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [batch, person.person_key])
  if (err) return <div className="text-sm text-rose-400">Couldn&apos;t load history: {err}</div>
  if (!events) return <div className="text-sm text-zinc-500">Loading history…</div>
  // Newest first; the 12 most recent unless he asks for everything.
  const list = [...events].reverse()
  const shown = showAll ? list : list.slice(0, 12)
  return (
    <div className="space-y-2">
      <div className="text-xs text-zinc-500">
        Newest first · {events.length} items · orange = from them, blue = from you or automatic
        {cell === false && " · your cell texts couldn't be loaded (the Mac mini may be offline)"}
      </div>
      {shown.map((e, i) => (
        <div key={i} className={`flex ${e.fromThem ? "justify-start" : "justify-end"}`}>
          <div className={`max-w-[92%] rounded-xl border px-3 py-2 text-sm whitespace-pre-wrap break-words ${e.fromThem ? "bg-amber-950/40 border-amber-800/60" : "bg-sky-950/40 border-sky-800/60"}`}>
            <div className="text-[11px] text-zinc-400 mb-1">{stamp(e.at)} · {e.kind}{e.seconds ? ` · ${e.seconds}s` : ""}</div>
            {e.text && <div className="text-zinc-100">{e.text}</div>}
            {e.summary && e.summary !== e.text && <div className="mt-1.5 pt-1.5 border-t border-dashed border-zinc-700 text-xs text-zinc-400">Summary: {e.summary}</div>}
            {e.notes && <div className="mt-1.5 pt-1.5 border-t border-dashed border-zinc-700 text-xs text-zinc-400">Notes: {e.notes}</div>}
          </div>
        </div>
      ))}
      {list.length > shown.length && (
        <button onClick={() => setShowAll(true)} className="w-full rounded-lg border border-zinc-700 py-2 text-sm text-zinc-300">
          Show all {list.length} (older ones too)
        </button>
      )}
    </div>
  )
}

export function LeadReviewTab() {
  const params = useSearchParams()
  const [batch, setBatch] = useState<string>(params.get("batch") || "")
  const [people, setPeople] = useState<Person[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [filter, setFilter] = useState<"all" | "open" | "done">("all")
  const [saving, setSaving] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/lead-review${batch ? `?batch=${encodeURIComponent(batch)}` : ""}`, { cache: "no-store" })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
      setBatch(j.batch)
      setPeople(j.people)
      setNotes(Object.fromEntries((j.people as Person[]).map((p) => [p.person_key, p.note || ""])))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [batch])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load() }, [])

  const save = useCallback(async (p: Person, patch: Partial<Pick<Person, "decision" | "decision_date" | "note">>) => {
    const before = people
    setPeople((prev) => prev.map((x) => (x.person_key === p.person_key ? { ...x, ...patch } : x)))
    setSaving(p.person_key)
    try {
      const res = await fetch("/api/lead-review", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch, person_key: p.person_key, ...patch }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
    } catch (e) {
      setPeople(before) // never show a pick that didn't save
      setError(`Didn't save for ${p.name || p.person_key}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(null)
    }
  }, [batch, people])

  const pick = (p: Person, d: Decision) => {
    if (p.decision === d) return save(p, { decision: null, decision_date: null }) // tap again = undo
    return save(p, { decision: d, decision_date: d === "followup" ? (p.decision_date || p.planned_date) : null })
  }

  const decided = people.filter((p) => p.decision).length
  const shown = people.filter((p) => (filter === "all" ? true : filter === "open" ? !p.decision : !!p.decision))

  return (
    <div className="max-w-3xl mx-auto text-zinc-100">
      <h1 className="text-xl font-semibold">Nurture review</h1>
      <p className="text-sm text-zinc-400 mt-1">
        Tap a person to read their history, then tap what should happen. Your picks are saved as you tap, but
        nothing changes on anyone&apos;s card until you tell Claude you&apos;re done.
      </p>
      <div className="mt-3 flex items-center gap-2 text-sm">
        <span className="font-medium">{decided} of {people.length} decided</span>
        <div className="ml-auto flex gap-1">
          {(["all", "open", "done"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={`rounded-full border px-3 py-1 ${filter === f ? "bg-zinc-100 text-zinc-900 border-zinc-100" : "border-zinc-700 text-zinc-300"}`}>
              {f === "all" ? "All" : f === "open" ? "To do" : "Done"}
            </button>
          ))}
        </div>
      </div>
      {error && <div className="mt-3 rounded-lg border border-rose-700 bg-rose-950/50 px-3 py-2 text-sm text-rose-200" onClick={() => setError(null)}>{error}</div>}
      {loading && <div className="mt-6 text-sm text-zinc-500">Loading…</div>}

      <div className="mt-4 space-y-3">
        {shown.map((p) => {
          const isOpen = open === p.person_key
          const emailOnly = !p.phone
          return (
            <div key={p.person_key} className={`rounded-xl border ${p.decision ? "border-emerald-800/70" : "border-zinc-800"} bg-zinc-900`}>
              <button className="w-full text-left px-4 py-3" onClick={() => setOpen(isOpen ? null : p.person_key)}>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{p.name || "(no name)"}</div>
                    <div className="text-xs text-zinc-400 truncate">{p.address || p.email || phoneFmt(p.phone)}</div>
                  </div>
                  {p.decision
                    ? <span className="shrink-0 rounded-full bg-emerald-900/60 border border-emerald-700 px-2 py-0.5 text-xs text-emerald-200">✓ {decisionText(p)}</span>
                    : <span className="shrink-0 text-xs text-zinc-500">{isOpen ? "▲" : "▼"}</span>}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
                  {emailOnly && <span className="rounded-full border border-sky-800 bg-sky-950/50 px-2 py-0.5 text-sky-300">email only</span>}
                  {p.offer ? <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-zinc-300">offer ${Number(p.offer).toLocaleString()}</span> : null}
                  <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-zinc-300">heard from them {p.from_them}× · last {shortDay(p.last_from_them)}</span>
                </div>
              </button>

              {isOpen && (
                <div className="border-t border-zinc-800 px-4 py-3 space-y-4">
                  <dl className="grid grid-cols-[8.5rem_1fr] gap-x-3 gap-y-1 text-sm">
                    <dt className="text-zinc-500">Phone</dt><dd>{p.phone ? <a className="text-sky-400" href={`tel:${p.phone}`}>{phoneFmt(p.phone)}</a> : "—"}</dd>
                    <dt className="text-zinc-500">Email</dt><dd className="break-all">{p.email ? <a className="text-sky-400" href={`mailto:${p.email}`}>{p.email}</a> : "—"}</dd>
                    <dt className="text-zinc-500">Source</dt><dd>{p.source || "—"} · {p.status || "—"}</dd>
                    <dt className="text-zinc-500">Follow-up now</dt><dd>{p.current_followup ? `${day(p.current_followup)}${p.current_reason ? ` — ${p.current_reason}` : ""}` : "none — on no list"}</dd>
                    <dt className="text-zinc-500">Date I planned</dt><dd>{day(p.planned_date)}</dd>
                    <dt className="text-zinc-500">Judge&apos;s guess</dt><dd className="text-zinc-400">{p.judge_guess || "—"} <span className="text-zinc-600">(test only, not saved)</span></dd>
                    <dt className="text-zinc-500">First contact</dt><dd>{shortDay(p.first_at)}</dd>
                  </dl>
                  {p.phone && (
                    <a className="inline-block text-sm text-sky-400" href={`/leads?phone=${encodeURIComponent(p.phone)}`} target="_blank" rel="noreferrer">Open their lead card ↗</a>
                  )}

                  <div>
                    <div className="text-sm font-medium mb-2">What should happen?</div>
                    <div className="grid grid-cols-2 gap-2">
                      {CHOICES.map((c) => (
                        <button
                          key={c.key}
                          disabled={saving === p.person_key}
                          onClick={() => pick(p, c.key)}
                          className={`rounded-lg border py-3 text-sm font-medium ${p.decision === c.key ? `${c.tone} text-white` : "border-zinc-700 text-zinc-200 bg-zinc-950"}`}
                        >
                          {p.decision === c.key ? "✓ " : ""}{c.key === "autopilot" && emailOnly ? "Autopilot (email)" : c.label}
                        </button>
                      ))}
                    </div>
                    {p.decision === "followup" && (
                      <label className="mt-3 flex items-center gap-2 text-sm">
                        <span className="text-zinc-400">On</span>
                        <input
                          type="date"
                          value={p.decision_date || p.planned_date || ""}
                          onChange={(e) => save(p, { decision_date: e.target.value || null })}
                          className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-zinc-100"
                        />
                      </label>
                    )}
                    <div className="mt-1 text-xs text-zinc-500">Tap a chosen button again to undo it.</div>
                  </div>

                  <div>
                    <div className="text-sm font-medium mb-1">Notes for Claude (optional)</div>
                    <textarea
                      value={notes[p.person_key] ?? ""}
                      onChange={(e) => setNotes((n) => ({ ...n, [p.person_key]: e.target.value }))}
                      onBlur={() => { if ((notes[p.person_key] ?? "") !== (p.note || "")) void save(p, { note: notes[p.person_key] ?? "" }) }}
                      rows={2}
                      placeholder="e.g. good rapport — call in January"
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
                    />
                  </div>

                  <div>
                    <div className="text-sm font-medium mb-2">History</div>
                    <History batch={batch} person={p} />
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
