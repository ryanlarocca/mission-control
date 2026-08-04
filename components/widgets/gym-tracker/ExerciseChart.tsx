"use client"

import { useRef, useState } from "react"
import { formatLoad, formatShortDate, type SessionPoint } from "@/lib/gymTracker"

// Per-exercise progression chart: est. 1RM + top-set weight per session, one
// shared lbs axis. Hand-rolled SVG like LineChart, plus y gridlines, a PR
// ring, and a scrub tooltip (pointer works for both mouse and touch;
// touch-action pan-y keeps vertical page scroll alive over the chart).
// Series hues validated against the zinc-900 surface (lightness band, CVD
// ΔE ≥ 99, contrast ≥ 3:1) — amber-600 / sky-600, not the amber-400 UI accent.
const E1RM_COLOR = "#d97706"
const TOP_COLOR = "#0284c7"

// Round a raw tick interval up to a chart-friendly 1/2/2.5/5 × 10^k —
// 2.5 earns its slot because 25-lb ticks are plate math.
function niceStep(raw: number): number {
  const pow = 10 ** Math.floor(Math.log10(raw))
  const m = raw / pow
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * pow
}

export function ExerciseChart({ points }: { points: SessionPoint[] }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)

  const W = 360
  const H = 190
  const padL = 34
  const padR = 12
  const padT = 12
  const padB = 20
  const plotW = W - padL - padR
  const plotH = H - padT - padB
  const n = points.length

  if (n < 2) {
    return (
      <div className="text-xs text-zinc-600 py-8 text-center">
        Log a second session to see the trend.
      </div>
    )
  }

  const e1s = points.map(p => p.bestE1rm)
  const tops = points.map(p => p.topWeight)
  const all = [...e1s, ...tops]
  const rawMin = Math.min(...all)
  const rawMax = Math.max(...all)
  const span = rawMax - rawMin || 10
  const lo = rawMin - span * 0.12
  const hi = rawMax + span * 0.12

  const x = (i: number) => padL + (i / (n - 1)) * plotW
  const y = (v: number) => padT + plotH - ((v - lo) / (hi - lo)) * plotH
  const path = (vals: number[]) =>
    vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ")

  const step = niceStep((hi - lo) / 5)
  const ticks: number[] = []
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t)

  // The session holding the all-time best e1RM gets a PR ring.
  const prIdx = e1s.indexOf(Math.max(...e1s))

  const xTickIdx =
    n <= 3 ? points.map((_, i) => i) : [0, Math.floor((n - 1) / 2), n - 1]

  function onScrub(e: React.PointerEvent) {
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return
    const px = ((e.clientX - rect.left) / rect.width) * W
    const i = Math.round(((px - padL) / plotW) * (n - 1))
    setHover(Math.max(0, Math.min(n - 1, i)))
  }

  const hp = hover !== null ? points[hover] : null
  // Clamp the tooltip inside the card near the edges.
  const tipLeft = hover !== null ? Math.max(18, Math.min(82, (x(hover) / W) * 100)) : 0

  return (
    <div>
      <div className="flex items-center gap-4 mb-1.5 text-[11px] text-zinc-400">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-0.5 rounded" style={{ background: E1RM_COLOR }} />
          Est. 1RM (lb)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-0.5 rounded" style={{ background: TOP_COLOR }} />
          Top set weight (lb)
        </span>
      </div>

      <div
        ref={wrapRef}
        className="relative"
        style={{ touchAction: "pan-y" }}
        onPointerMove={onScrub}
        onPointerDown={onScrub}
        onPointerLeave={() => setHover(null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
          {ticks.map(t => (
            <g key={t}>
              <line x1={padL} y1={y(t)} x2={W - padR} y2={y(t)} stroke="#27272a" strokeWidth={1} />
              <text x={padL - 5} y={y(t) + 3} textAnchor="end" fontSize={9} fill="#71717a">
                {Math.round(t)}
              </text>
            </g>
          ))}

          {hover !== null && (
            <line
              x1={x(hover)} y1={padT} x2={x(hover)} y2={padT + plotH}
              stroke="#52525b" strokeWidth={1} strokeDasharray="3 3"
            />
          )}

          <path d={path(tops)} fill="none" stroke={TOP_COLOR} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <path d={path(e1s)} fill="none" stroke={E1RM_COLOR} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

          {points.map((_, i) => (
            <g key={i}>
              <circle cx={x(i)} cy={y(tops[i])} r={hover === i ? 4 : 2} fill={TOP_COLOR} />
              <circle cx={x(i)} cy={y(e1s[i])} r={hover === i ? 4 : 2.5} fill={E1RM_COLOR} />
            </g>
          ))}

          {/* PR ring — surface-colored gap so it reads over either line */}
          <circle cx={x(prIdx)} cy={y(e1s[prIdx])} r={6} fill="none" stroke="#18181b" strokeWidth={3.5} />
          <circle cx={x(prIdx)} cy={y(e1s[prIdx])} r={6} fill="none" stroke={E1RM_COLOR} strokeWidth={1.5} />

          {xTickIdx.map(i => (
            <text
              key={i}
              x={x(i)}
              y={H - 4}
              textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
              fontSize={9}
              fill="#71717a"
            >
              {formatShortDate(points[i].date)}
            </text>
          ))}
        </svg>

        {hp && (
          <div
            className="absolute top-0 -translate-x-1/2 pointer-events-none bg-zinc-950 border border-zinc-700 rounded-md px-2.5 py-1.5 text-[11px] leading-4 shadow-lg whitespace-nowrap"
            style={{ left: `${tipLeft}%` }}
          >
            <div className="text-zinc-400 font-medium">
              {formatShortDate(hp.date)}
              {hover === prIdx && <span className="text-amber-400"> · PR</span>}
            </div>
            <div className="flex items-center gap-1.5 text-zinc-200">
              <span className="inline-block w-2 h-0.5 rounded" style={{ background: E1RM_COLOR }} />
              e1RM {Math.round(hp.bestE1rm)} · {formatLoad(hp.topSet.weight_lbs, hp.topSet.reps)}
            </div>
            <div className="flex items-center gap-1.5 text-zinc-200">
              <span className="inline-block w-2 h-0.5 rounded" style={{ background: TOP_COLOR }} />
              top weight {Math.round(hp.topWeight)} lb
            </div>
            <div className="text-zinc-500">
              {hp.setCount} {hp.setCount === 1 ? "set" : "sets"} · {Math.round(hp.volume).toLocaleString()} lb volume
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
