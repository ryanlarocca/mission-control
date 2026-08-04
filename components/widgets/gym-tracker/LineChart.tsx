"use client"

// Hand-rolled SVG line chart — single or dual series, each on its own scale
// (so a ~190 lb bodyweight line and a ~320 DOTS line can share an x-axis).
// No chart lib; matches the zinc/amber palette. Responsive via viewBox.

export interface ChartSeries {
  values: number[]
  color: string
  label: string
  format?: (n: number) => string
}

export function LineChart({
  labels,
  left,
  right,
  height = 180,
}: {
  labels: string[]
  left: ChartSeries
  right?: ChartSeries
  height?: number
}) {
  const W = 320
  const H = height
  const padL = 8
  const padR = 8
  const padT = 14
  const padB = 18
  const plotW = W - padL - padR
  const plotH = H - padT - padB

  const n = left.values.length
  if (n < 2) {
    return <div className="text-xs text-zinc-600 py-8 text-center">Not enough data yet to chart.</div>
  }

  const x = (i: number) => padL + (i / (n - 1)) * plotW

  function pathFor(s: ChartSeries) {
    const min = Math.min(...s.values)
    const max = Math.max(...s.values)
    const span = max - min || 1
    // Add a little headroom so the line isn't flush to the edges.
    const lo = min - span * 0.1
    const hi = max + span * 0.1
    const y = (v: number) => padT + plotH - ((v - lo) / (hi - lo)) * plotH
    const d = s.values
      .map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`)
      .join(" ")
    return { d, y, min, max, lastX: x(n - 1), lastY: y(s.values[n - 1]) }
  }

  const L = pathFor(left)
  const R = right ? pathFor(right) : null

  const fmtL = left.format ?? ((v: number) => String(Math.round(v)))
  const fmtR = right?.format ?? ((v: number) => String(Math.round(v)))

  // A few x-axis date labels (first, middle, last).
  const xTickIdx = [0, Math.floor((n - 1) / 2), n - 1]

  return (
    <div>
      <div className="flex items-center gap-4 mb-1 text-[11px]">
        <span className="flex items-center gap-1.5" style={{ color: left.color }}>
          <span className="inline-block w-2.5 h-0.5 rounded" style={{ background: left.color }} />
          {left.label}
        </span>
        {right && (
          <span className="flex items-center gap-1.5" style={{ color: right.color }}>
            <span className="inline-block w-2.5 h-0.5 rounded" style={{ background: right.color }} />
            {right.label}
          </span>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: "auto" }} preserveAspectRatio="none">
        {/* baseline */}
        <line x1={padL} y1={padT + plotH} x2={W - padR} y2={padT + plotH} stroke="#27272a" strokeWidth={1} />
        <path d={L.d} fill="none" stroke={left.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={L.lastX} cy={L.lastY} r={2.5} fill={left.color} />
        {R && (
          <>
            <path d={R.d} fill="none" stroke={right!.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            <circle cx={R.lastX} cy={R.lastY} r={2.5} fill={right!.color} />
          </>
        )}
      </svg>
      {/* min/max + x labels */}
      <div className="flex justify-between text-[10px] text-zinc-600 mt-0.5">
        {xTickIdx.map((i, k) => (
          <span key={k}>{labels[i]}</span>
        ))}
      </div>
      <div className="flex justify-between text-[10px] mt-0.5">
        <span style={{ color: left.color }}>
          {fmtL(L.min)} – {fmtL(L.max)}
        </span>
        {R && (
          <span style={{ color: right!.color }}>
            {fmtR(R.min)} – {fmtR(R.max)}
          </span>
        )}
      </div>
    </div>
  )
}
