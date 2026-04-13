"use client"

import { useSocial } from "@/hooks/useSocial"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { RefreshCw, Video, TrendingUp, Activity } from "lucide-react"
import type { VideoQueueItem, SocialMetric } from "@/types"

const queueStatusColors: Record<string, string> = {
  pending: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  approved: "bg-green-500/20 text-green-400 border-green-500/30",
  rejected: "bg-red-500/20 text-red-400 border-red-500/30",
  posted: "bg-blue-500/20 text-blue-400 border-blue-500/30",
}

const platformIcons: Record<string, string> = {
  instagram: "IG",
  tiktok: "TK",
  youtube: "YT",
  facebook: "FB",
}

function VideoRow({ item }: { item: VideoQueueItem }) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-zinc-800 last:border-0">
      <span className="text-xs font-mono bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded shrink-0">
        {platformIcons[item.platform] || item.platform.slice(0, 2).toUpperCase()}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-zinc-100 truncate">{item.title}</p>
        {item.duration && (
          <p className="text-xs text-zinc-500">{Math.floor(item.duration / 60)}m {item.duration % 60}s</p>
        )}
      </div>
      <span className={`text-xs px-1.5 py-0.5 rounded border shrink-0 ${queueStatusColors[item.status]}`}>
        {item.status}
      </span>
    </div>
  )
}

function MetricRow({ metric }: { metric: SocialMetric }) {
  const isUp = metric.followersChange >= 0
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="text-xs text-zinc-400 w-20 shrink-0">{metric.platform}</span>
      <span className="text-sm font-mono text-zinc-100">{metric.followers.toLocaleString()}</span>
      <span className={`text-xs ${isUp ? "text-green-400" : "text-red-400"}`}>
        {isUp ? "+" : ""}{metric.followersChange}
      </span>
      <span className="text-xs text-zinc-500 ml-auto">{metric.engagement}% eng</span>
    </div>
  )
}

export function SocialWidget() {
  const { queue, metrics, backend, lastUpdated, loading, error, refresh } = useSocial()

  const pendingCount = queue.filter(v => v.status === "pending").length

  return (
    <Card className="bg-zinc-900 border-zinc-800 h-full flex flex-col">
      <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
          <Activity className="w-4 h-4 text-zinc-400" />
          Physiq Social Engine
        </CardTitle>
        <div className="flex items-center gap-2">
          {pendingCount > 0 && (
            <span className="text-xs bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 px-1.5 py-0.5 rounded">
              {pendingCount} pending
            </span>
          )}
          {lastUpdated && (
            <span className="text-xs text-zinc-600">
              {lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
          <button onClick={refresh} className="text-zinc-600 hover:text-zinc-400 transition-colors">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden flex flex-col gap-4 pt-0">
        {error && <p className="text-xs text-red-400">Error: {error}</p>}

        {/* Video Queue */}
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <Video className="w-3 h-3 text-zinc-500" />
            <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Video Queue</span>
          </div>
          <ScrollArea className="h-auto max-h-[400px]">
            {queue.map(v => <VideoRow key={v.id} item={v} />)}
          </ScrollArea>
        </div>

        {/* Social Metrics */}
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <TrendingUp className="w-3 h-3 text-zinc-500" />
            <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Metrics</span>
          </div>
          {metrics.map(m => <MetricRow key={m.platform} metric={m} />)}
        </div>

        {/* Backend Activity */}
        {backend && (
          <div className="mt-auto pt-2 border-t border-zinc-800">
            <div className="grid grid-cols-3 gap-2">
              <div className="text-center">
                <p className="text-lg font-bold text-zinc-100">{backend.logins}</p>
                <p className="text-xs text-zinc-500">logins</p>
              </div>
              <div className="text-center">
                <p className="text-lg font-bold text-zinc-100">{backend.activeSessions}</p>
                <p className="text-xs text-zinc-500">active</p>
              </div>
              <div className="text-center">
                <p className={`text-lg font-bold ${backend.errors24h > 0 ? "text-red-400" : "text-green-400"}`}>
                  {backend.errors24h}
                </p>
                <p className="text-xs text-zinc-500">errors</p>
              </div>
            </div>
            <p className="text-xs text-zinc-600 text-center mt-1">{backend.avgLatencyMs}ms avg latency</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
