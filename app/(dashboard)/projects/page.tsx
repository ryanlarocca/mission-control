"use client"

import { useCallback, useEffect, useState, type ReactNode } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { ChevronDown, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { handleSessionExpired } from "@/lib/session-expired"
import { fmtDate, fmtYmd } from "@/lib/today"
import type { ProjectRow } from "@/lib/projectMemo"
import {
  GROUP_LABEL, countsLine, groupProjects, isStaleActive, isSyncStale, newestSync, projectLine, relativeAgo,
} from "@/lib/projectsView"

// Projects (Mission Control 2.0, Part D, 2026-11-10) — read-only list of the
// project memos, fed from Supabase project_memos (the Mac mini syncs it from
// ~/Projects/PROJECTS/*/PROJECT_MEMO.md). Active / Planning / Parked, retired
// behind a toggle. Tap a row: recent ships, then "where we left off".

export default function ProjectsPage() {
  const [rows, setRows] = useState<ProjectRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [showRetired, setShowRetired] = useState(false)
  const [now, setNow] = useState<Date>(() => new Date())

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/projects", { cache: "no-store" })
      if (handleSessionExpired(res)) return
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
      setRows(body.projects as ProjectRow[])
      setError(null)
      setNow(new Date())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  // Load now and again when the tab comes back (the sync runs on the mini's
  // schedule, so no polling).
  useEffect(() => {
    void load()
    function onVisible() { if (document.visibilityState === "visible") void load() }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [load])

  // Today's card links here with ?open=<slug>: open that row (and the retired
  // group if that's where it is).
  useEffect(() => {
    if (!rows) return
    const slug = new URLSearchParams(window.location.search).get("open")
    const hit = slug ? rows.find(r => r.slug === slug) : null
    if (!hit) return
    setOpen(hit.slug)
    if (hit.archived || hit.status === "retired") setShowRetired(true)
    requestAnimationFrame(() => document.getElementById(`p-${hit.slug}`)?.scrollIntoView({ block: "center" }))
  }, [rows])

  const groups = rows ? groupProjects(rows) : null
  const synced = rows ? newestSync(rows) : null

  return (
    <div className="max-w-2xl text-signal-ink">
      <h1 className="text-[26px] md:text-2xl font-bold tracking-tight">Projects</h1>
      <p className="text-sm text-signal-muted mt-1 min-h-[1.25rem]">
        {groups ? (
          <>
            <span className="font-num">{countsLine(groups)}</span>
            {synced && <span className="whitespace-nowrap"> · synced {relativeAgo(synced, now)}</span>}
          </>
        ) : null}
      </p>
      {synced && isSyncStale(synced, now) && (
        <p className="text-sm text-signal-warn mt-1">This list hasn&apos;t refreshed since {fmtDate(synced)}.</p>
      )}

      {!groups ? (
        <p className="mt-6 text-sm text-signal-muted">{error ? error : "Loading…"}</p>
      ) : (
        <>
          {(["active", "planning", "parked"] as const).map(k => (
            <Group key={k} label={GROUP_LABEL[k]} rows={groups[k]} open={open} setOpen={setOpen} now={now} />
          ))}
          {groups.retired.length > 0 && (
            <section className="mt-6">
              <button
                type="button"
                onClick={() => setShowRetired(v => !v)}
                aria-expanded={showRetired}
                className="flex items-center gap-1.5 min-h-[44px] text-xs uppercase tracking-[0.08em] font-semibold text-signal-muted"
              >
                {showRetired ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                {showRetired ? "Hide retired" : `Show retired (${groups.retired.length})`}
              </button>
              {showRetired && <List rows={groups.retired} open={open} setOpen={setOpen} now={now} />}
            </section>
          )}
        </>
      )}
    </div>
  )
}

type ListProps = {
  rows: ProjectRow[]
  open: string | null
  setOpen: (slug: string | null) => void
  now: Date
}

function Group({ label, ...rest }: ListProps & { label: string }) {
  return (
    <section className="mt-6">
      <h2 className="text-xs uppercase tracking-[0.08em] font-semibold text-signal-muted mb-2">
        {label} <span className="font-num">· {rest.rows.length}</span>
      </h2>
      {rest.rows.length === 0 ? <p className="text-sm text-signal-muted">Nothing here.</p> : <List {...rest} />}
    </section>
  )
}

function List({ rows, open, setOpen, now }: ListProps) {
  return (
    <div className="bg-signal-card border border-signal-border rounded-md overflow-hidden">
      {rows.map(p => {
        const isOpen = open === p.slug
        const stale = isStaleActive(p, now)
        const line = projectLine(p)
        return (
          <div key={p.slug} id={`p-${p.slug}`} className="border-t border-signal-border first:border-t-0 scroll-mt-4">
            <button
              type="button"
              onClick={() => setOpen(isOpen ? null : p.slug)}
              aria-expanded={isOpen}
              className={cn(
                "w-full text-left flex items-start gap-3 px-3.5 py-3 min-h-[44px] hover:bg-signal-card2 transition-colors",
                isOpen && "bg-signal-card2",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold truncate">{p.name}</div>
                {line && <div className="text-xs text-signal-muted mt-0.5 leading-snug">{line}</div>}
              </div>
              <div
                className={cn("font-num text-xs whitespace-nowrap shrink-0 pt-px", stale ? "text-signal-warn" : "text-signal-muted")}
                title={stale ? "Not touched in 30+ days" : "Last touched"}
              >
                {p.updated_on ? fmtYmd(p.updated_on) : "—"}
              </div>
            </button>
            {isOpen && <Detail p={p} now={now} />}
          </div>
        )
      })}
    </div>
  )
}

function Detail({ p, now }: { p: ProjectRow; now: Date }) {
  const ships = Array.isArray(p.ships) ? p.ships : []
  return (
    <div className="px-3.5 pb-3.5 pt-1 bg-signal-card2">
      <H3>Recent ships</H3>
      {ships.length === 0 ? (
        <p className="text-xs text-signal-muted">None logged yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {ships.map((s, i) => (
            <li key={`${s.date}-${i}`} className="flex gap-3 text-[13px] leading-snug">
              <span className="font-num text-xs text-signal-muted whitespace-nowrap shrink-0 w-[92px] pt-px">{fmtYmd(s.date)}</span>
              <span className="min-w-0 flex-1 break-words">{s.title}</span>
            </li>
          ))}
        </ul>
      )}

      {/* The working notes are written by and for the agents (commit hashes,
          file names) — folded away so the plain list above is what Ryan reads. */}
      {p.left_off && (
        <details className="mt-4 group">
          <summary className="list-none cursor-pointer select-none text-[11px] uppercase tracking-[0.08em] font-semibold text-signal-muted min-h-[44px] flex items-center gap-1.5 [&::-webkit-details-marker]:hidden">
            <span className="transition-transform group-open:rotate-90">›</span> Working notes (technical)
          </summary>
          <div className="text-[13px] leading-relaxed text-signal-ink/90 break-words">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD}>{p.left_off}</ReactMarkdown>
          </div>
        </details>
      )}

      <p className="text-[11px] text-signal-muted mt-4">Synced {relativeAgo(p.synced_at, now)}</p>
    </div>
  )
}

function H3({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cn("text-[11px] uppercase tracking-[0.08em] font-semibold text-signal-muted mb-2 mt-2", className)}>{children}</h3>
}

// Memo markdown, read-only. Links point at other memo files on the mini, so
// they render as plain text.
const MD: Components = {
  p: ({ children }) => <p className="my-1.5">{children}</p>,
  ul: ({ children }) => <ul className="list-disc pl-5 my-1.5 space-y-1.5 marker:text-signal-muted">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 my-1.5 space-y-1.5 marker:text-signal-muted">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-signal-ink">{children}</strong>,
  a: ({ children }) => <span className="text-signal-ink">{children}</span>,
  code: ({ children }) => <code className="font-num text-[12px] bg-signal-bg/60 rounded px-1 py-px break-all">{children}</code>,
  pre: ({ children }) => <pre className="whitespace-pre-wrap my-1.5">{children}</pre>,
  h1: ({ children }) => <p className="font-semibold mt-3 mb-1">{children}</p>,
  h2: ({ children }) => <p className="font-semibold mt-3 mb-1">{children}</p>,
  h3: ({ children }) => <p className="font-semibold mt-3 mb-1">{children}</p>,
  h4: ({ children }) => <p className="font-semibold mt-3 mb-1">{children}</p>,
  table: ({ children }) => <div className="overflow-x-auto my-2"><table className="text-xs">{children}</table></div>,
  th: ({ children }) => <th className="text-left font-semibold pr-3 pb-1 border-b border-signal-border">{children}</th>,
  td: ({ children }) => <td className="pr-3 py-1 align-top border-b border-signal-border">{children}</td>,
  img: () => null,
}
