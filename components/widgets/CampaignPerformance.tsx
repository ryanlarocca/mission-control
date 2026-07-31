"use client"

import { useEffect, useState } from "react"

// Performance tab for /email-campaign (Ryan 2026-07-31): campaign health,
// the send-time experiment (reply rate by PT send hour), touch funnel, and
// recent replies. Read-only; data from /api/campaign/stats.

type Stats = {
  experiment_start: string
  contacts: Record<string, number>
  totals: {
    sent: number
    replied: number
    reply_rate: number
    bounced: number
    unsubscribed: number
    sent_today: number
    queue_draft: number
    queue_approved: number
  }
  touches: Record<string, { sent: number; replied: number }>
  hours: Record<string, { sent: number; replied: number }>
  recent_replies: { name: string; when: string; snippet: string }[]
}

function hourLabel(h: number): string {
  if (h === 12) return "12p"
  return h < 12 ? `${h}a` : `${h - 12}p`
}

function pct(replied: number, sent: number): string {
  return sent ? `${((100 * replied) / sent).toFixed(1)}%` : "—"
}

export function CampaignPerformance() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    fetch("/api/campaign/stats", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`)
        setStats(await res.json())
      })
      .catch(() => setError("Couldn't load stats — refresh to retry"))
  }, [])

  if (error) return <div className="rounded-lg border border-red-900 bg-red-950/40 p-4 text-sm text-red-300">{error}</div>
  if (!stats) return <div className="p-4 text-sm text-zinc-500">Crunching campaign numbers…</div>

  const t = stats.totals
  const hourRows = Array.from({ length: 10 }, (_, i) => i + 7).map((h) => ({
    h,
    sent: stats.hours[h]?.sent ?? 0,
    replied: stats.hours[h]?.replied ?? 0,
  }))
  const maxRate = Math.max(0.001, ...hourRows.map((r) => (r.sent >= 10 ? r.replied / r.sent : 0)))
  const touchRows = Object.entries(stats.touches)
    .map(([k, v]) => ({ touch: Number(k), ...v }))
    .sort((a, b) => a.touch - b.touch)

  return (
    <div className="flex flex-col gap-5">
      {/* Health cards */}
      <div className="flex flex-wrap gap-2">
        {[
          [t.sent, "sent to date"],
          [`${t.replied} (${pct(t.replied, t.sent)})`, "replies (14d attribution)"],
          [t.bounced, "bounced"],
          [t.unsubscribed, "unsubscribed"],
          [stats.contacts["active"] ?? 0, "active contacts"],
          [`${t.sent_today} / 200`, "sent today"],
          [t.queue_approved, "queued (auto-approved)"],
          ...(t.queue_draft > 0 ? [[t.queue_draft, "awaiting your review"] as [number, string]] : []),
        ].map(([n, label]) => (
          <div key={String(label)} className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5">
            <span className="text-sm font-semibold text-zinc-100">{n}</span>{" "}
            <span className="text-[11px] text-zinc-500">{label}</span>
          </div>
        ))}
      </div>

      {/* Send-time experiment */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <div className="mb-1 text-sm font-semibold text-zinc-100">Send-time experiment</div>
        <div className="mb-3 text-[11px] text-zinc-500">
          Reply rate by the hour the email actually sent (PT) · randomized 7a–5p since {stats.experiment_start} · rates firm up as sends accumulate
        </div>
        <div className="flex flex-col gap-1">
          {hourRows.map(({ h, sent, replied }) => {
            const rate = sent ? replied / sent : 0
            const width = sent >= 10 ? Math.max(2, Math.round((rate / maxRate) * 100)) : 0
            return (
              <div key={h} className="flex items-center gap-2 text-[12px]">
                <span className="w-8 shrink-0 text-right font-mono text-zinc-500">{hourLabel(h)}</span>
                <div className="h-4 flex-1 rounded bg-zinc-800/60">
                  {sent > 0 && (
                    <div
                      className="flex h-4 items-center rounded bg-emerald-500/70 pl-1.5 text-[10px] font-semibold text-emerald-950"
                      style={{ width: `${width}%`, minWidth: sent >= 10 && replied > 0 ? "2.5rem" : undefined }}
                    />
                  )}
                </div>
                <span className="w-40 shrink-0 font-mono text-zinc-400">
                  {sent === 0 ? <span className="text-zinc-600">no sends yet</span> : `${sent} sent · ${replied} replies · ${pct(replied, sent)}`}
                </span>
              </div>
            )
          })}
        </div>
        <div className="mt-2 text-[11px] text-zinc-600">Bars scale to the best hour; hours under 10 sends show numbers only. Friday scorecard mirrors this in Telegram.</div>
      </div>

      {/* Touch funnel */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <div className="mb-2 text-sm font-semibold text-zinc-100">Touch funnel</div>
        <table className="w-full text-left text-[12px]">
          <thead>
            <tr className="text-zinc-500">
              <th className="pb-1 font-medium">Touch</th>
              <th className="pb-1 font-medium">Sent</th>
              <th className="pb-1 font-medium">Replies</th>
              <th className="pb-1 font-medium">Rate</th>
            </tr>
          </thead>
          <tbody className="text-zinc-300">
            {touchRows.map((r) => (
              <tr key={r.touch} className="border-t border-zinc-800/60">
                <td className="py-1 font-mono">T{r.touch}</td>
                <td className="py-1 font-mono">{r.sent}</td>
                <td className="py-1 font-mono">{r.replied}</td>
                <td className="py-1 font-mono">{pct(r.replied, r.sent)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Recent replies */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <div className="mb-2 text-sm font-semibold text-zinc-100">Latest replies</div>
        {stats.recent_replies.length === 0 ? (
          <div className="text-[12px] text-zinc-500">None yet</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {stats.recent_replies.map((r, i) => (
              <div key={i} className="text-[12px]">
                <span className="font-semibold text-zinc-200">{r.name}</span>{" "}
                <span className="text-zinc-600">{new Date(r.when).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>{" "}
                <span className="text-zinc-400">“{r.snippet}”</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
