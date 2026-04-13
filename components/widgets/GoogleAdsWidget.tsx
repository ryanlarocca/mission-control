"use client"

import { useState } from "react"
import { TrendingUp, TrendingDown, Phone, MousePointer, Eye, DollarSign, Pause, Play } from "lucide-react"

const initialCampaigns = [
  {
    id: "1",
    name: "LRG Homes — Search",
    status: "active" as "active" | "paused",
    budget: 50,
    spent: 38.42,
    impressions: 1840,
    clicks: 62,
    conversions: 3,
    ctr: 3.37,
    cpc: 0.62,
    convType: "Lead form",
    trend: "up",
  },
  {
    id: "2",
    name: "LRG Homes — Call Ads",
    status: "active" as "active" | "paused",
    budget: 30,
    spent: 22.10,
    impressions: 920,
    clicks: 18,
    conversions: 2,
    ctr: 1.96,
    cpc: 1.23,
    convType: "Phone call",
    trend: "up",
  },
  {
    id: "3",
    name: "LRG Homes — Retargeting",
    status: "paused" as "active" | "paused",
    budget: 20,
    spent: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    ctr: 0,
    cpc: 0,
    convType: "Lead form",
    trend: "flat",
  },
]

const statusConfig = {
  active: { dot: "bg-green-400", text: "text-green-400", label: "Active" },
  paused: { dot: "bg-zinc-500", text: "text-zinc-500", label: "Paused" },
}

function SpendBar({ spent, budget }: { spent: number; budget: number }) {
  const pct = budget > 0 ? Math.min((spent / budget) * 100, 100) : 0
  const color = pct > 90 ? "bg-red-500" : pct > 70 ? "bg-amber-500" : "bg-green-500"
  return (
    <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

export function GoogleAdsWidget() {
  const [period, setPeriod] = useState<"today" | "7d" | "30d">("today")
  const [campaigns, setCampaigns] = useState(initialCampaigns)

  function toggleCampaign(id: string) {
    setCampaigns(prev =>
      prev.map(c =>
        c.id === id ? { ...c, status: c.status === "active" ? "paused" : "active" } : c
      )
    )
  }

  const totalSpend = campaigns.reduce((s, c) => s + c.spent, 0)
  const totalConversions = campaigns.reduce((s, c) => s + c.conversions, 0)
  const totalClicks = campaigns.reduce((s, c) => s + c.clicks, 0)
  const totalImpressions = campaigns.reduce((s, c) => s + c.impressions, 0)

  return (
    <div className="space-y-4">
      {/* Today's Summary header card */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-3">Today's Summary</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Spend", value: `$${totalSpend.toFixed(2)}`, icon: DollarSign, color: "text-zinc-100" },
            { label: "Impressions", value: totalImpressions.toLocaleString(), icon: Eye, color: "text-zinc-100" },
            { label: "Clicks", value: String(totalClicks), icon: MousePointer, color: "text-zinc-100" },
            { label: "Conversions", value: String(totalConversions), icon: Phone, color: "text-green-400" },
          ].map(stat => (
            <div key={stat.label}>
              <div className="flex items-center gap-1.5 mb-1">
                <stat.icon className="w-3 h-3 text-zinc-500" />
                <p className="text-xs text-zinc-500">{stat.label}</p>
              </div>
              <p className={`text-xl font-bold ${stat.color}`}>{stat.value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Period toggle */}
      <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-lg p-1 w-fit">
        {(["today", "7d", "30d"] as const).map(p => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`px-3 py-1 rounded text-xs transition-colors ${period === p ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
          >
            {p === "today" ? "Today" : p === "7d" ? "7 days" : "30 days"}
          </button>
        ))}
      </div>

      {/* Campaigns */}
      <div className="space-y-3">
        {campaigns.map(campaign => {
          const s = statusConfig[campaign.status]
          return (
            <div key={campaign.id} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
                  <p className="text-sm font-medium text-zinc-100">{campaign.name}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs ${s.text}`}>{s.label}</span>
                  <button
                    onClick={() => toggleCampaign(campaign.id)}
                    title={campaign.status === "active" ? "Pause campaign" : "Resume campaign"}
                    className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 px-2 py-1 rounded transition-colors"
                  >
                    {campaign.status === "active"
                      ? <><Pause className="w-3 h-3" /> Pause</>
                      : <><Play className="w-3 h-3" /> Resume</>
                    }
                  </button>
                </div>
              </div>

              {/* Spend progress */}
              <div className="mb-3">
                <div className="flex justify-between mb-1">
                  <span className="text-xs text-zinc-500">Daily spend</span>
                  <span className="text-xs text-zinc-300 font-mono">
                    ${campaign.spent.toFixed(2)} / ${campaign.budget}
                  </span>
                </div>
                <SpendBar spent={campaign.spent} budget={campaign.budget} />
              </div>

              {/* Metrics */}
              <div className="grid grid-cols-4 gap-2">
                {[
                  { label: "Impr.", value: campaign.impressions.toLocaleString() },
                  { label: "Clicks", value: String(campaign.clicks) },
                  { label: "CTR", value: `${campaign.ctr}%` },
                  { label: "Conv.", value: String(campaign.conversions) },
                ].map(m => (
                  <div key={m.label} className="text-center">
                    <p className="text-sm font-bold text-zinc-100">{m.value}</p>
                    <p className="text-xs text-zinc-600">{m.label}</p>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
