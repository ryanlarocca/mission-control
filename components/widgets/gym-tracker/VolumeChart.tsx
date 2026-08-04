"use client"

import { useRef, useState } from "react"
import { formatLoad, formatShortDate, type SessionPoint } from "@/lib/gymTracker"

// Per-session volume (Σ weight × reps) as bars — magnitude, so the baseline
// is zero and bar length is the encoding. Violet-600: validated alongside the
// amber/sky line hues on the zinc-900 surface. Same scrub interaction as
// ExerciseChart.
const VOL_COLOR = "#7c3aed"

export function VolumeChart({ points }: { points: SessionPoint[] }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)

  const W = 360
  const H = 120
  const padL = 34
  const padR = 12
  const padT = 8
  const padB = 20
  const plotW = W - padL - padR
  const plotH = H - padT - padB
  const n = points.length

  if (n < 2) {
    return (
      <div className="text-xs text-zinc-600 py-6 text-center">
        Log a second session to see volume.
      </div>
    )
  }

  const vols = points.map(p => p.volume)
  const hi = Math.max(...vols) * 1.1

  const xc = (i: number) => padL + ((i + 0.5) / n) * plotW
  const y = (v: number) => padT + plotH - (v / hi) * plotH
  const barW = Math.max(2, Math.min(14, (plotW / n) * 0.6))

  const fmtVol = (v: number) => (v >= 10000 ? `${Math.round(v / 1000)}k` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)))

  // Two round gridlines are plenty at this height. Round to a step that fits
  // the magnitude, and never draw above the scale top.
  const roundTo = hi > 4000 ? 1000 : hi > 1000 ? 500 : 100
  const ticks = [hi / 2.2, hi / 1.1]
    .map(t => Math.floor(t / roundTo) * roundTo)
    .filter((t, i, a) => t > 0 && t <= hi && a.indexOf(t) === i)

  const xTickIdx = n <= 3 ? points.map((_, i) => i) : [0, Math.floor((n - 1) / 2), n - 1]

  function onScrub(e: React.PointerEvent) {
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return
    const px = ((e.clientX - rect.left) / rect.width) * W
    const i = Math.floor(((px - padL) / plotW) * n)
    setHover(Math.max(0, Math.min(n - 1, i)))
  }

  const hp = hover !== null ? points[hover] : null
  const tipLeft = hover !== null ? Math.max(18, Math.min(82, (xc(hover) / W) * 100)) : 0

  return (
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
              {fmtVol(t)}
            </text>
          </g>
        ))}
        <line x1={padL} y1={padT + plotH} x2={W - padR} y2={padT + plotH} stroke="#3f3f46" strokeWidth={1} />

        {points.map((p, i) => (
          <rect
            key={p.date}
            x={xc(i) - barW / 2}
            y={y(p.volume)}
            width={barW}
            height={Math.max(1, padT + plotH - y(p.volume))}
            rx={1.5}
            fill={VOL_COLOR}
            opacity={hover === null || hover === i ? 1 : 0.45}
          />
        ))}

        {xTickIdx.map(i => (
          <text
            key={i}
            x={xc(i)}
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
          <div className="text-zinc-400 font-medium">{formatShortDate(hp.date)}</div>
          <div className="text-zinc-200">{Math.round(hp.volume).toLocaleString()} lb volume</div>
          <div className="text-zinc-500">
            {hp.setCount} {hp.setCount === 1 ? "set" : "sets"} · top {formatLoad(hp.topSet.weight_lbs, hp.topSet.reps)}
          </div>
        </div>
      )}
    </div>
  )
}
