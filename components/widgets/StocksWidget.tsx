"use client"

import { useEffect, useState } from "react"
import { TrendingUp, TrendingDown } from "lucide-react"

const initialTickers = [
  { symbol: "SPY", name: "S&P 500 ETF", price: 562.14, change: 1.84, changePct: 0.33, shares: 10 },
  { symbol: "QQQ", name: "Nasdaq 100 ETF", price: 484.22, change: 2.11, changePct: 0.44, shares: 5 },
  { symbol: "NVDA", name: "NVIDIA Corp", price: 875.40, change: -8.32, changePct: -0.94, shares: 8 },
  { symbol: "AAPL", name: "Apple Inc", price: 213.18, change: 0.92, changePct: 0.43, shares: 15 },
  { symbol: "TSLA", name: "Tesla Inc", price: 172.63, change: -3.41, changePct: -1.94, shares: 12 },
  { symbol: "META", name: "Meta Platforms", price: 524.90, change: 4.22, changePct: 0.81, shares: 4 },
  { symbol: "BTC", name: "Bitcoin", price: 83420, change: -1240, changePct: -1.46, shares: 0.05 },
]

// Mini sparkline using divs
function Sparkline({ positive }: { positive: boolean }) {
  const points = [40, 55, 45, 60, 52, 65, 58, 70, 62, 75].map((v, i, a) => {
    if (!positive) return 100 - v + (Math.random() * 10 - 5)
    return v + (Math.random() * 8 - 4)
  })
  const min = Math.min(...points)
  const max = Math.max(...points)
  const norm = points.map(p => ((p - min) / (max - min)) * 28)
  const color = positive ? "#4ade80" : "#f87171"

  return (
    <svg width="60" height="28" className="shrink-0">
      <polyline
        points={norm.map((y, x) => `${(x / (norm.length - 1)) * 60},${28 - y}`).join(" ")}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.7"
      />
    </svg>
  )
}

export function StocksWidget() {
  const [tickers, setTickers] = useState(initialTickers)

  // Simulate price drift
  useEffect(() => {
    const interval = setInterval(() => {
      setTickers(prev => prev.map(t => {
        const drift = (Math.random() - 0.49) * t.price * 0.001
        const newPrice = +(t.price + drift).toFixed(t.price > 1000 ? 0 : 2)
        const newChange = +(t.change + drift).toFixed(2)
        const newPct = +((newChange / (newPrice - newChange)) * 100).toFixed(2)
        return { ...t, price: newPrice, change: newChange, changePct: newPct }
      }))
    }, 3000)
    return () => clearInterval(interval)
  }, [])

  const portfolioValue = tickers.reduce((sum, t) => sum + t.price * t.shares, 0)
  const portfolioChange = tickers.reduce((sum, t) => sum + t.change * t.shares, 0)

  return (
    <div className="space-y-4">
      {/* Portfolio summary */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 flex items-center justify-between">
        <div>
          <p className="text-xs text-zinc-500 mb-0.5">Portfolio Value</p>
          <p className="text-2xl font-bold text-zinc-100">
            ${portfolioValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
        </div>
        <div className={`text-right ${portfolioChange >= 0 ? "text-green-400" : "text-red-400"}`}>
          <div className="flex items-center gap-1 justify-end mb-0.5">
            {portfolioChange >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
            <span className="text-lg font-bold">
              {portfolioChange >= 0 ? "+" : ""}${Math.abs(portfolioChange).toFixed(2)}
            </span>
          </div>
          <p className="text-xs opacity-70">today</p>
        </div>
      </div>

      {/* Ticker list */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        {tickers.map((t, i) => {
          const up = t.changePct >= 0
          return (
            <div key={t.symbol} className={`flex items-center gap-3 px-4 py-3 ${i < tickers.length - 1 ? "border-b border-zinc-800" : ""}`}>
              <div className="w-12 shrink-0">
                <p className="text-sm font-bold text-zinc-100">{t.symbol}</p>
                <p className="text-xs text-zinc-600 truncate">{t.name.split(" ").slice(0, 2).join(" ")}</p>
              </div>
              <div className="flex-1">
                <Sparkline positive={up} />
              </div>
              <div className="text-right shrink-0">
                <p className="text-sm font-mono font-semibold text-zinc-100">
                  ${t.price.toLocaleString("en-US", { minimumFractionDigits: t.price > 1000 ? 0 : 2, maximumFractionDigits: t.price > 1000 ? 0 : 2 })}
                </p>
                <p className={`text-xs font-mono ${up ? "text-green-400" : "text-red-400"}`}>
                  {up ? "+" : ""}{t.changePct.toFixed(2)}%
                </p>
              </div>
            </div>
          )
        })}
      </div>

      <p className="text-xs text-zinc-700 text-center">Mock data — prices simulate live movement</p>
    </div>
  )
}
