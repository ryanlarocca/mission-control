"use client"

import { useCallback, useEffect, useState, type ReactNode } from "react"
import Link from "next/link"
import { cn } from "@/lib/utils"
import { handleSessionExpired } from "@/lib/session-expired"
import {
  apptWhen, dateLine, describeDue, fmtDate, fmtTime, fmtUsd, fmtWhen, fmtYmd, greeting, orderFollowUps,
  type FollowUpsLite,
} from "@/lib/today"
import type { TodayPayload } from "@/lib/todayData"
import { projectLine, recentlyTouched, type ProjectSummary } from "@/lib/projectsView"

// Today (Mission Control 2.0 shell, 2026-11-10) — the landing page on every
// device. Layout = the approved "Signal" mockup
// (PROJECTS/mission-control-revamp/mockups). Three sources, each loaded and
// failing on its own:
//   /api/follow-ups      Follow-ups due tile + Due today list (+ failed drips → Autopilot pill)
//   /api/crms/contacts   Touches due tile (`total`)
//   /api/today           health pills, appointments, Jackie overnight, AI spend
//   /api/projects        Projects · last touched card (desktop only; Part D)

type Source<T> = { data: T | null; error: string | null }
const empty = <T,>(): Source<T> => ({ data: null, error: null })

async function getJson<T>(url: string): Promise<T | "expired"> {
  const res = await fetch(url, { cache: "no-store" })
  if (handleSessionExpired(res)) return "expired"
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}

const DUE_PHONE = 3
const DUE_DESKTOP = 6

export default function TodayPage() {
  const [now, setNow] = useState<Date | null>(null)
  const [today, setToday] = useState<Source<TodayPayload>>(empty)
  const [fu, setFu] = useState<Source<FollowUpsLite>>(empty)
  const [crms, setCrms] = useState<Source<{ total: number }>>(empty)
  const [projects, setProjects] = useState<Source<{ projects: ProjectSummary[] }>>(empty)

  const load = useCallback(async () => {
    setNow(new Date())
    // A failed refresh keeps the last good copy; the error line only shows
    // when there is nothing to show.
    const run = async <T,>(url: string, set: (fn: (s: Source<T>) => Source<T>) => void) => {
      try {
        const v = await getJson<T>(url)
        if (v === "expired") return
        set(() => ({ data: v, error: null }))
      } catch (e) {
        set(s => ({ data: s.data, error: e instanceof Error ? e.message : String(e) }))
      }
    }
    await Promise.all([
      run<TodayPayload>("/api/today", setToday),
      run<FollowUpsLite>("/api/follow-ups", setFu),
      run<{ total: number }>("/api/crms/contacts", setCrms),
      run<{ projects: ProjectSummary[] }>("/api/projects?view=summary", setProjects),
    ])
  }, [])

  // Load now, again when the tab comes back, and every 60 s while visible.
  useEffect(() => {
    void load()
    const id = setInterval(() => { if (document.visibilityState === "visible") void load() }, 60_000)
    function onVisible() { if (document.visibilityState === "visible") void load() }
    document.addEventListener("visibilitychange", onVisible)
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible) }
  }, [load])

  const t = today.data
  const sectionErr = (key: string) => (t ? t.errors?.[key] : null) || (!t && today.error) || null
  const rows = fu.data ? orderFollowUps(fu.data.rows, now ?? new Date()) : null
  const due = rows?.map(r => describeDue(r, now ?? new Date())) ?? null
  const overdueCount = due?.filter(d => d.tone === "overdue").length ?? 0
  const appts = t?.appointments ?? null
  const jackie = t?.jackie ?? null
  const spend = t?.spend ?? null
  const recent = projects.data ? recentlyTouched(projects.data.projects ?? []) : null

  return (
    <div className="max-w-[1180px] text-signal-ink">
      {/* Header: date + greeting, health pills (right on desktop). */}
      <div className="md:flex md:items-end md:justify-between md:gap-4">
        <div className="min-w-0">
          <div className="font-num text-xs uppercase tracking-[0.08em] text-signal-muted min-h-[1rem]">
            {now ? dateLine(now) : ""}
          </div>
          <h1 className="text-[26px] md:text-2xl font-bold tracking-tight mt-1.5 md:mt-1 mb-3 md:mb-0 min-h-[2rem]">
            {now ? greeting(now) : ""}
          </h1>
        </div>
        <HealthPills today={today} fu={fu} />
      </div>

      {/* Four tiles. */}
      <div className="grid grid-cols-2 md:grid-cols-4 [&>*]:min-w-0 gap-2.5 md:gap-3.5 my-4 md:mt-[18px] md:mb-[18px]">
        <Tile
          href="/leads?view=followups" label="Follow-ups due"
          value={rows ? String(rows.length) : null} failed={!rows && !!fu.error}
          sub={<span className="text-signal-muted">{overdueCount > 0 ? `${overdueCount} overdue` : "Follow Ups"}</span>}
        />
        <Tile
          href="/relationships" label="Touches due"
          value={crms.data ? String(crms.data.total ?? 0) : null} failed={!crms.data && !!crms.error}
          sub={<span className="text-signal-muted">Relationships</span>}
        />
        <Tile
          href="#appointments" label="Appointments"
          value={appts ? String(appts.length) : null} failed={!appts && !!sectionErr("appointments")}
          sub={<span className="text-signal-muted">{appts?.length ? `next ${apptWhen(appts[0], now ?? new Date())}` : "none in the next 7 days"}</span>}
        />
        <Tile
          href="#jackie" label="Jackie overnight"
          value={jackie ? String(jackie.count) : null} failed={!jackie && !!sectionErr("jackie")}
          sub={jackie ? <Delta n={jackie.count - jackie.prevCount} /> : null}
        />
      </div>

      <div className="md:grid md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] md:gap-[18px] md:items-start">
        {/* Due today */}
        <section className="mt-[22px] md:mt-0 min-w-0">
          <H2>Due today</H2>
          <Card>
            {!due ? (
              <StateLine error={fu.error} />
            ) : due.length === 0 ? (
              <Row><div className="text-sm text-signal-muted">Nothing due — all caught up.</div></Row>
            ) : (
              due.slice(0, DUE_DESKTOP).map((d, i) => (
                <RowLink key={d.key} href={d.href} className={i >= DUE_PHONE ? "hidden md:flex" : undefined}>
                  <span
                    className={cn(
                      "w-2 h-2 rounded-full shrink-0 mt-[5px]",
                      d.tone === "overdue" ? "bg-[#ec835a]" : d.tone === "replied" ? "bg-signal-accent" : d.tone === "today" ? "bg-signal-warn" : "bg-signal-muted",
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold truncate">{d.name}</div>
                    <div className="text-xs text-signal-muted mt-0.5 truncate">{d.why}</div>
                  </div>
                  <div className="font-num text-xs text-signal-muted whitespace-nowrap shrink-0">{d.when}</div>
                </RowLink>
              ))
            )}
            {due && (
              <Link href="/leads?view=followups" className="flex items-center px-3.5 py-3 min-h-[44px] border-t border-signal-border text-xs font-semibold text-signal-accent">
                <span className="md:hidden">{due.length > DUE_PHONE ? `${due.length - DUE_PHONE} more in Follow Ups →` : "Open Follow Ups →"}</span>
                <span className="hidden md:inline">{due.length > DUE_DESKTOP ? `${due.length - DUE_DESKTOP} more in Follow Ups →` : "Open Follow Ups →"}</span>
              </Link>
            )}
          </Card>
        </section>

        {/* Appointments + Jackie */}
        <div className="md:flex md:flex-col md:gap-[18px] min-w-0">
          <section id="appointments" className="mt-[22px] md:mt-0 scroll-mt-4">
            <H2>Appointments</H2>
            <Card>
              {!appts ? (
                <StateLine error={sectionErr("appointments")} />
              ) : appts.length === 0 ? (
                <Row><div className="text-sm text-signal-muted">No appointments today or in the next 7 days.</div></Row>
              ) : (
                appts.map(a => (
                  <RowLink key={a.key} href={a.linkKey ? `/leads?phone=${encodeURIComponent(a.linkKey)}` : null}>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold truncate">{a.title}</div>
                      {a.sub && <div className="text-xs text-signal-muted mt-0.5 truncate">{a.sub}</div>}
                    </div>
                    <div className="font-num text-xs text-signal-muted whitespace-nowrap shrink-0">{apptWhen(a, now ?? new Date())}</div>
                  </RowLink>
                ))
              )}
            </Card>
          </section>

          <section id="jackie" className="mt-[22px] md:mt-0 scroll-mt-4">
            <H2>Jackie overnight</H2>
            <Card>
              {!jackie ? (
                <StateLine error={sectionErr("jackie")} />
              ) : jackie.items.length === 0 ? (
                <Row><div className="text-sm text-signal-muted">No calls for Jackie since 5:00 PM yesterday.</div></Row>
              ) : (
                jackie.items.map(j => (
                  <RowLink key={j.id} href={j.linkKey ? `/leads?phone=${encodeURIComponent(j.linkKey)}` : null}>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold truncate">{j.title}</div>
                      <div className="text-xs text-signal-muted mt-0.5 truncate">{j.sub}</div>
                    </div>
                    <div className="font-num text-xs text-signal-muted whitespace-nowrap shrink-0">{fmtWhen(j.at, now ?? new Date())}</div>
                  </RowLink>
                ))
              )}
            </Card>
          </section>
        </div>

        {/* AI spend + Projects (desktop) */}
        <div className="md:flex md:flex-col md:gap-[18px] min-w-0">
        <section className="mt-[22px] md:mt-0 min-w-0">
          <H2>AI spend</H2>
          <Card>
            {!spend ? (
              <StateLine error={sectionErr("spend")} />
            ) : (
              <div className="px-3.5 py-3">
                <div className="flex items-center justify-between gap-2 text-[13px]">
                  <span className="min-w-0 truncate">Yesterday <b className="font-num tabular-nums">{fmtUsd(spend.yesterdayUsd)}</b></span>
                  <span className="text-signal-muted shrink-0">
                    {spend.monthLabel} · <span className="font-num tabular-nums">{fmtUsd(spend.monthUsd)}</span> of ${spend.targetUsd}
                  </span>
                </div>
                <div className="h-1.5 mt-2 bg-signal-card2 overflow-hidden">
                  <i
                    className={cn("block h-full", spend.monthUsd > spend.targetUsd ? "bg-signal-bad" : "bg-signal-accent")}
                    style={{ width: `${spend.monthPct}%` }}
                  />
                </div>
                <div className="flex gap-[3px] items-end h-7 mt-2.5" aria-label="Last 7 days">
                  {spend.days.map((d, i) => (
                    <b
                      key={d.ymd}
                      title={`${fmtDate(`${d.ymd}T12:00:00Z`)}: ${fmtUsd(d.usd)}`}
                      className={cn("flex-1 rounded-t-sm min-h-[2px]", i === spend.days.length - 1 ? "bg-signal-accent" : "bg-signal-card2")}
                      style={{ height: `${spend.bars[i]}%` }}
                    />
                  ))}
                </div>
                <div className="flex justify-between text-[11px] tracking-[0.02em] text-signal-muted mt-1">
                  <span>{spend.firstLabel}</span>
                  <span>{spend.lastLabel}</span>
                </div>
              </div>
            )}
          </Card>
        </section>

        {/* Projects · last touched — desktop only (phone Today is unchanged). */}
        <section className="hidden md:block min-w-0">
          <H2>Projects · last touched</H2>
          <Card>
            {!recent ? (
              <StateLine error={projects.error} />
            ) : recent.length === 0 ? (
              <Row><div className="text-sm text-signal-muted">No projects synced yet.</div></Row>
            ) : (
              recent.map(p => (
                <RowLink key={p.slug} href={`/projects?open=${encodeURIComponent(p.slug)}`}>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold truncate">{p.name}</div>
                    <div className="text-xs text-signal-muted mt-0.5 truncate">{projectLine(p)}</div>
                  </div>
                  <div className="font-num text-xs text-signal-muted whitespace-nowrap shrink-0">{p.updated_on ? fmtYmd(p.updated_on) : "—"}</div>
                </RowLink>
              ))
            )}
            {recent && (
              <Link href="/projects" className="flex items-center px-3.5 py-3 min-h-[44px] border-t border-signal-border text-xs font-semibold text-signal-accent">
                All projects →
              </Link>
            )}
          </Card>
        </section>
        </div>
      </div>
    </div>
  )
}

// ── pieces ──────────────────────────────────────────────────────────────────

function HealthPills({ today, fu }: { today: Source<TodayPayload>; fu: Source<FollowUpsLite> }) {
  const h = today.data?.health
  const nowMs = Date.now()
  const ago = (iso: string | null) => (iso ? `${Math.max(1, Math.round((nowMs - Date.parse(iso)) / 60_000))} min` : "no check-in")
  const pills: { key: string; state: "ok" | "warn" | "unknown"; text: string }[] = []

  if (!h) {
    const text = today.error ? "couldn't load" : "…"
    for (const k of ["Mini", "Bridge", "Judge"]) pills.push({ key: k, state: "unknown", text: `${k} · ${text}` })
  } else {
    const m = h.mini
    if (!m) pills.push({ key: "Mini", state: "unknown", text: "Mini · couldn't load" })
    else if (!m.ok) pills.push({ key: "Mini", state: "warn", text: `Mini · quiet ${ago(m.beatAt)}` })
    else if (m.lowSpace) pills.push({ key: "Mini", state: "warn", text: `Mini · ${m.freeGb ?? "?"} GB free` })
    else pills.push({ key: "Mini", state: "ok", text: "Mini" })

    const b = h.bridge
    if (!b) pills.push({ key: "Bridge", state: "unknown", text: "Bridge · couldn't load" })
    else pills.push(b.ok ? { key: "Bridge", state: "ok", text: "Bridge" } : { key: "Bridge", state: "warn", text: `Bridge · quiet ${ago(b.at)}` })

    const j = h.judge
    if (!j) pills.push({ key: "Judge", state: "unknown", text: "Judge · couldn't load" })
    else if (j.ok && j.at) pills.push({ key: "Judge", state: "ok", text: `Judge ${fmtTime(j.at)}` })
    else pills.push({ key: "Judge", state: "warn", text: j.at ? `Judge · last ran ${fmtDate(j.at)}` : "Judge · hasn't run" })
  }

  const failed = fu.data?.failed?.length ?? 0
  const active = h?.autopilot?.active
  if (failed > 0) pills.push({ key: "Autopilot", state: "warn", text: `Autopilot · ${failed} failed` })
  else if (active != null) pills.push({ key: "Autopilot", state: "ok", text: `Autopilot · ${active} on` })
  else pills.push({ key: "Autopilot", state: "unknown", text: h || today.error ? "Autopilot · couldn't load" : "Autopilot · …" })

  return (
    <div className="flex flex-wrap gap-1.5 md:justify-end md:shrink-0">
      {pills.map(p => (
        <Link
          key={p.key}
          href="/health"
          className={cn(
            "inline-flex items-center gap-[5px] font-num text-[11px] font-semibold px-2 py-[3px] rounded border bg-signal-card2 whitespace-nowrap hover:bg-signal-card transition-colors",
            p.state === "ok" && "text-signal-accent border-signal-accent/35",
            p.state === "warn" && "text-signal-warn border-[#5a4210]",
            p.state === "unknown" && "text-signal-muted border-signal-border",
          )}
        >
          {p.state === "ok" ? "✓" : p.state === "warn" ? "!" : "?"} {p.text}
        </Link>
      ))}
    </div>
  )
}

function Tile({ href, label, value, sub, failed }: { href: string; label: string; value: string | null; sub: ReactNode; failed: boolean }) {
  return (
    <Link
      href={href}
      className="relative block bg-signal-card border border-signal-border rounded-md p-3.5 min-h-[44px] hover:border-signal-accent/40 transition-colors"
    >
      <span className="absolute left-0 top-2.5 bottom-2.5 w-0.5 rounded-sm bg-signal-accent" />
      <div className="text-[11px] uppercase tracking-[0.08em] text-signal-muted truncate">{label}</div>
      <div className="font-num tabular-nums text-[30px] font-bold leading-none mt-2 mb-1">
        {value ?? <span className="text-signal-muted">—</span>}
      </div>
      <div className="text-[11px] tracking-[0.02em] truncate">
        {failed ? <span className="text-signal-muted">couldn&apos;t load</span> : sub}
      </div>
    </Link>
  )
}

// A change number: above zero green, below zero red, zero neutral.
function Delta({ n }: { n: number }) {
  if (n === 0) return <span className="text-signal-muted">same as yesterday</span>
  return (
    <>
      <span className={n > 0 ? "text-[#22c55e]" : "text-signal-bad"}>{n > 0 ? "▲" : "▼"} {Math.abs(n)}</span>{" "}
      <span className="text-signal-muted">vs yesterday</span>
    </>
  )
}

function H2({ children }: { children: ReactNode }) {
  return <h2 className="text-xs uppercase tracking-[0.08em] font-semibold text-signal-muted mb-2">{children}</h2>
}

function Card({ children }: { children: ReactNode }) {
  return <div className="bg-signal-card border border-signal-border rounded-md overflow-hidden">{children}</div>
}

function Row({ children }: { children: ReactNode }) {
  return <div className="px-3.5 py-3 flex gap-3 items-start border-t border-signal-border first:border-t-0">{children}</div>
}

function RowLink({ href, children, className }: { href: string | null; children: ReactNode; className?: string }) {
  const cls = cn("px-3.5 py-3 min-h-[44px] gap-3 items-start border-t border-signal-border first:border-t-0", className ?? "flex")
  if (!href) return <div className={cls}>{children}</div>
  return <Link href={href} className={cn(cls, "hover:bg-signal-card2 transition-colors")}>{children}</Link>
}

function StateLine({ error }: { error: string | null }) {
  return (
    <div className="px-3.5 py-3 text-xs text-signal-muted">
      {error ? <>Couldn&apos;t load this right now.</> : "Loading…"}
    </div>
  )
}
