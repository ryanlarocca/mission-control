// Tiny inline e1RM sparkline — no axes, just the curve. Amber stroke to match
// the PR accent. Flat dotted placeholder when there's <2 points.
export function Sparkline({
  data,
  width = 120,
  height = 28,
}: {
  data: number[]
  width?: number
  height?: number
}) {
  const pad = 2
  const w = width - pad * 2
  const h = height - pad * 2

  if (data.length < 2) {
    return (
      <svg width={width} height={height} className="overflow-visible" aria-hidden>
        <line
          x1={pad}
          y1={height / 2}
          x2={width - pad}
          y2={height / 2}
          stroke="#3f3f46"
          strokeWidth={1.5}
          strokeDasharray="3 3"
        />
      </svg>
    )
  }

  const min = Math.min(...data)
  const max = Math.max(...data)
  const span = max - min || 1

  const points = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * w
    // invert y: higher e1RM = higher on screen
    const y = pad + h - ((v - min) / span) * h
    return [x, y] as const
  })

  const d = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ")
  const [lastX, lastY] = points[points.length - 1]

  return (
    <svg width={width} height={height} className="overflow-visible" aria-hidden>
      <path d={d} fill="none" stroke="#f59e0b" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastX} cy={lastY} r={2} fill="#f59e0b" />
    </svg>
  )
}
