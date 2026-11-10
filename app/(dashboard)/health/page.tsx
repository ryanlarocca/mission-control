"use client"

import { useCallback, useEffect, useState, type ReactNode } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { handleSessionExpired } from "@/lib/session-expired"
import { fmtUsd } from "@/lib/today"
import { buildHealthView, type CardView, type HealthPayload, type HealthView, type Mark } from "@/lib/health"

// Health (Mission Control 2.0, Part E — v1, 2026-11-10): "is everything
// running?" in plain words, readable in ten seconds on a phone. One source,
// GET /api/health (the mini's check-in + its 5-minute status report from
// Supabase, the judge, Jackie, AI spend). Read-only: no restart or control
// buttons in v1.

export default function HealthPage() {
  const [data, setData] = useState<HealthPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState<Date | null>(null)
  const [jobsOpen, setJobsOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" })
      if (handleSessionExpired(res)) return
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData((await res.json()) as HealthPayload)
      setError(null)
    } catch (e) {
      // Keep the last good copy; the error line only shows when there is none.
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setNow(new Date())
    }
  }, [])

  // Load now, again when the tab comes back, and every 60 s while visible.
  useEffect(() => {
    void load()
    const id = setInterval(() => { if (document.visibilityState === "visible") void load() }, 60_000)
    function onVisible() { if (document.visibilityState === "visible") void load() }
    document.addEventListener("visibilitychange", onVisible)
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible) }
  }, [load])

  const view: HealthView | null = data && now ? buildHealthView(data, now) : null

  return (
    <div className="max-w-[1180px] text-signal-ink">
      <h1 className="text-[26px] md:text-2xl font-bold tracking-tight">Health</h1>

      {!view ? (
        <p className="mt-3 text-sm text-signal-muted">{error ? "Couldn't load this right now." : "Loading…"}</p>
      ) : (
        <>
          <div className="mt-2">
            <p className={cn("text-lg font-semibold", view.problems === 0 ? "text-signal-accent" : "text-signal-warn")}>
              {view.verdict}
            </p>
            <p className={cn("text-sm mt-0.5", view.checked.warn ? "text-signal-warn" : "text-signal-muted")}>{view.checked.text}</p>
          </div>

          <div className="grid md:grid-cols-2 gap-3 md:gap-[18px] mt-5 md:items-start [&>*]:min-w-0">
            {view.cards.map(c => <StatusCard key={c.key} card={c} />)}
            <SpendCard spend={view.spend} />
            <JobsCard jobs={view.jobs} open={jobsOpen} setOpen={setJobsOpen} />
          </div>
        </>
      )}
    </div>
  )
}

// ── pieces ──────────────────────────────────────────────────────────────────

function MarkBadge({ mark }: { mark: Mark }) {
  return (
    <span
      aria-label={mark === "ok" ? "OK" : mark === "warn" ? "Needs a look" : "Not known yet"}
      className={cn(
        "inline-flex items-center justify-center w-5 h-5 rounded font-num text-[12px] font-bold border shrink-0",
        mark === "ok" && "text-signal-accent border-signal-accent/35 bg-signal-card2",
        mark === "warn" && "text-signal-warn border-[#5a4210] bg-signal-card2",
        mark === "unknown" && "text-signal-muted border-signal-border bg-signal-card2",
      )}
    >
      {mark === "ok" ? "✓" : mark === "warn" ? "!" : "?"}
    </span>
  )
}

function Card({ title, mark, children, className }: { title: string; mark: Mark; children: ReactNode; className?: string }) {
  return (
    <section className={cn("relative bg-signal-card border border-signal-border rounded-md px-3.5 py-3", className)}>
      <span className={cn("absolute left-0 top-2.5 bottom-2.5 w-0.5 rounded-sm", mark === "warn" ? "bg-signal-warn" : mark === "ok" ? "bg-signal-accent" : "bg-signal-border")} />
      <div className="flex items-center gap-2 min-w-0">
        <MarkBadge mark={mark} />
        <h2 className="text-xs uppercase tracking-[0.08em] font-semibold text-signal-muted min-w-0 truncate">{title}</h2>
      </div>
      <div className="mt-2">{children}</div>
    </section>
  )
}

function StatusCard({ card }: { card: CardView }) {
  return (
    <Card title={card.title} mark={card.mark}>
      <ul className="flex flex-col gap-1">
        {card.lines.map((l, i) => (
          <li key={i} className={cn("text-[14px] leading-snug", l.warn ? "text-signal-warn" : "text-signal-ink")}>{l.text}</li>
        ))}
      </ul>
    </Card>
  )
}

function SpendCard({ spend }: { spend: HealthView["spend"] }) {
  const s = spend.data
  return (
    <Card title="AI spend" mark={spend.mark}>
      {!s ? (
        <p className="text-[14px] text-signal-warn">Couldn&apos;t load this right now.</p>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-2 text-[14px]">
            <span className="min-w-0 truncate">
              {s.monthLabel} so far <b className="font-num tabular-nums">{fmtUsd(s.monthUsd)}</b>
            </span>
            <span className="text-signal-muted shrink-0 font-num text-xs">of ${s.targetUsd}</span>
          </div>
          <div className="h-1.5 mt-2 bg-signal-card2 overflow-hidden rounded-sm">
            <i className={cn("block h-full", s.monthUsd > s.targetUsd ? "bg-signal-bad" : "bg-signal-accent")} style={{ width: `${s.monthPct}%` }} />
          </div>
          <p className="text-[13px] mt-2">
            Yesterday <b className="font-num tabular-nums">{fmtUsd(s.yesterdayUsd)}</b>
          </p>

          <h3 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-signal-muted mt-3 mb-1">By key</h3>
          <ul className="flex flex-col gap-1">
            {s.lanes.map(l => (
              <li key={l.key} className="flex items-baseline justify-between gap-3 text-[13px]">
                <span className="min-w-0 truncate">{l.label}</span>
                <span className="font-num tabular-nums text-xs shrink-0 whitespace-nowrap">
                  {fmtUsd(l.monthUsd)} <span className="text-signal-muted">· yesterday {fmtUsd(l.yesterdayUsd)}</span>
                </span>
              </li>
            ))}
          </ul>

          <h3 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-signal-muted mt-3 mb-1">Biggest this month</h3>
          {s.top.length === 0 ? (
            <p className="text-[13px] text-signal-muted">Nothing spent yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {s.top.map(f => (
                <li key={f.name} className="flex items-baseline justify-between gap-3 text-[13px]">
                  <span className="min-w-0 truncate">{f.name}</span>
                  <span className="font-num tabular-nums text-xs shrink-0">{fmtUsd(f.usd)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  )
}

function JobsCard({ jobs, open, setOpen }: { jobs: HealthView["jobs"]; open: boolean; setOpen: (v: boolean) => void }) {
  if (!jobs) {
    return (
      <Card title="Scheduled jobs" mark="unknown" className="md:col-span-2">
        <p className="text-[14px] text-signal-muted">Waiting for the mini&apos;s first report.</p>
      </Card>
    )
  }
  return (
    <Card title="Scheduled jobs" mark={jobs.mark} className="md:col-span-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full flex items-center gap-1.5 min-h-[44px] -my-2 text-left"
      >
        {open ? <ChevronDown className="w-4 h-4 shrink-0 text-signal-muted" /> : <ChevronRight className="w-4 h-4 shrink-0 text-signal-muted" />}
        <span className={cn("text-[14px] min-w-0 truncate", jobs.mark === "warn" ? "text-signal-warn" : "text-signal-ink")}>{jobs.summary}</span>
      </button>
      {open && (
        <ul className="mt-2 border-t border-signal-border md:columns-2 md:gap-6">
          {jobs.items.map(j => (
            <li key={j.label} title={j.lastExit != null && j.lastExit !== 0 ? `${j.label} · last exit ${j.lastExit}` : j.label} className="flex items-baseline gap-3 py-2 border-b border-signal-border break-inside-avoid">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold truncate">{j.name}</div>
                <div className="text-xs text-signal-muted truncate">{j.schedule}</div>
              </div>
              <span className={cn("text-xs shrink-0 whitespace-nowrap", j.ok ? "text-signal-muted" : "text-signal-warn font-semibold")}>{j.state}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
