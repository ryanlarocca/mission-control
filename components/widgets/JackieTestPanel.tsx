"use client"

import { useEffect, useState } from "react"
import type { JackieScoreboard, ArmScore } from "@/lib/jackieScoreboard"

// Jackie scoreboard (lib/jackieScoreboard.ts) — top of the Campaign
// Performance "Current" view: the tally of calls she took, then Real by arm
// (the voicemail arm is the 10-27 → 11-03 coin-flip history). Hidden until
// she has a call or has been switched on.

const ARM_LABEL: Record<ArmScore["arm"], string> = {
  jackie: "Jackie · new callers",
  voicemail: "Your voicemail (coin flip)",
  answered: "You answered",
  returning: "Returning callers",
}

function pct(n: number | null): string {
  return n === null ? "—" : `${Math.round(n * 100)}%`
}

function clock(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return "—"
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`
}

export function JackieTestPanel() {
  const [data, setData] = useState<JackieScoreboard | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch("/api/campaigns/jackie-test", { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json()
        if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
        if (!cancelled) setData(j as JackieScoreboard)
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [])

  if (error) return <div className="rounded border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-200">Jackie scoreboard: {error}</div>
  if (!data) return null
  const total = data.arms.reduce((n, a) => n + a.callers, 0)
  if (!data.flip_on && total === 0) return null
  const t = data.tally

  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-zinc-100 truncate">Jackie · mailer lines</h2>
          <p className="text-[11px] text-zinc-500">Real = you made contact within 7 days, not DNC or junk.</p>
        </div>
        <span className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-medium ${data.flip_on ? "bg-violet-600/20 text-violet-300" : "bg-zinc-800 text-zinc-400"}`}>
          {data.flip_on ? "ON" : "OFF"}
        </span>
      </div>
      {t.calls > 0 && (
        <p className="text-xs text-zinc-300">
          {t.calls} call{t.calls === 1 ? "" : "s"} taken ({t.first_time} new, {t.returning} returning) · got the address {t.address} of {t.calls} · average {clock(t.avg_sec)}
          <span className="text-zinc-500"> · {t.hangups_under_15s} hung up in under 15 s · {t.failed} didn&apos;t connect</span>
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-zinc-500">
            <tr>
              <th className="text-left font-normal py-1 pr-2">Arm</th>
              <th className="text-right font-normal px-2">Callers</th>
              <th className="text-right font-normal px-2">Real</th>
              <th className="text-right font-normal px-2">Rate</th>
              <th className="text-right font-normal px-2">Pending</th>
              <th className="text-right font-normal px-2">DNC</th>
              <th className="text-right font-normal pl-2">Junk</th>
            </tr>
          </thead>
          <tbody className="text-zinc-300">
            {data.arms.map((a) => (
              <tr key={a.arm} className={`border-t border-zinc-900 ${a.arm === "returning" ? "text-zinc-500" : ""}`}>
                <td className="py-1 pr-2 whitespace-nowrap">{ARM_LABEL[a.arm]}</td>
                <td className="text-right px-2">{a.callers}</td>
                <td className="text-right px-2">{a.real}</td>
                <td className={`text-right px-2 ${a.arm === "jackie" ? "text-violet-300" : a.arm === "voicemail" ? "text-amber-300" : ""}`}>{pct(a.real_rate)}</td>
                <td className="text-right px-2">{a.pending}</td>
                <td className="text-right px-2">{a.dnc}</td>
                <td className="text-right pl-2">{a.junk}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
