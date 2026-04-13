"use client"

import { useEffect, useState } from "react"
import { Monitor, Wifi, HardDrive, Cpu, MemoryStick, ExternalLink } from "lucide-react"

function StatBar({ label, value, color }: { label: string; value: number; color: string }) {
  const [displayed, setDisplayed] = useState(0)
  useEffect(() => {
    const t = setTimeout(() => setDisplayed(value), 400)
    return () => clearTimeout(t)
  }, [value])
  return (
    <div>
      <div className="flex justify-between mb-1">
        <span className="text-xs text-zinc-400">{label}</span>
        <span className="text-xs font-mono text-zinc-300">{displayed}%</span>
      </div>
      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-1000 ease-out ${color}`}
          style={{ width: `${displayed}%` }}
        />
      </div>
    </div>
  )
}

const processes = [
  { name: "openclaw", cpu: "0.4", mem: "312 MB", status: "running" },
  { name: "node (lrg-funnel)", cpu: "0.1", mem: "88 MB", status: "running" },
  { name: "ngrok", cpu: "0.0", mem: "42 MB", status: "running" },
  { name: "cron (thadius)", cpu: "0.0", mem: "24 MB", status: "sleeping" },
]

export function MacMiniWidget() {
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [uptime] = useState("6d 14h 22m")

  function handleConnect() {
    setConnecting(true)
    setTimeout(() => { setConnecting(false); setConnected(true) }, 1800)
  }

  return (
    <div className="space-y-4">
      {/* Connection card */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Monitor className="w-5 h-5 text-zinc-400" />
            <div>
              <p className="text-sm font-semibold text-zinc-100">Mac Mini</p>
              <p className="text-xs text-zinc-500">Ryans-Mac-mini.local · 192.168.1.42</p>
            </div>
          </div>
          <span className={`flex items-center gap-1.5 text-xs ${connected ? "text-green-400" : "text-zinc-500"}`}>
            <Wifi className="w-3.5 h-3.5" />
            {connected ? "Connected" : "Local network"}
          </span>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="bg-zinc-800/60 rounded px-3 py-2 text-center">
            <p className="text-lg font-bold text-zinc-100">6d</p>
            <p className="text-xs text-zinc-500">uptime</p>
          </div>
          <div className="bg-zinc-800/60 rounded px-3 py-2 text-center">
            <p className="text-lg font-bold text-zinc-100">14</p>
            <p className="text-xs text-zinc-500">processes</p>
          </div>
          <div className="bg-zinc-800/60 rounded px-3 py-2 text-center">
            <p className="text-lg font-bold text-green-400">OK</p>
            <p className="text-xs text-zinc-500">health</p>
          </div>
        </div>

        {/* Resource bars */}
        <div className="space-y-2.5 mb-4">
          <StatBar label="CPU" value={12} color="bg-blue-500" />
          <StatBar label="RAM" value={58} color="bg-amber-500" />
          <StatBar label="Disk" value={34} color="bg-green-500" />
        </div>

        {/* Connect button */}
        {!connected ? (
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="w-full py-2 rounded-md bg-zinc-800 hover:bg-zinc-700 text-sm text-zinc-200 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {connecting ? (
              <>
                <span className="w-3.5 h-3.5 border-2 border-zinc-500 border-t-zinc-200 rounded-full animate-spin" />
                Connecting...
              </>
            ) : (
              <>
                <ExternalLink className="w-3.5 h-3.5" />
                Open Remote Desktop
              </>
            )}
          </button>
        ) : (
          <div className="border border-green-500/20 bg-green-500/5 rounded-md p-3 text-center">
            <p className="text-xs text-green-400">Remote session active</p>
            <p className="text-xs text-zinc-600 mt-0.5">Use Screen Sharing app to view desktop</p>
          </div>
        )}
      </div>

      {/* Processes */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <div className="flex items-center gap-2 mb-3">
          <Cpu className="w-3.5 h-3.5 text-zinc-500" />
          <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Key Processes</p>
        </div>
        <div className="space-y-0">
          {processes.map((p, i) => (
            <div key={i} className="flex items-center gap-3 py-2 border-b border-zinc-800 last:border-0">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${p.status === "running" ? "bg-green-400" : "bg-zinc-600"}`} />
              <span className="text-sm font-mono text-zinc-200 flex-1">{p.name}</span>
              <span className="text-xs text-zinc-500 w-14 text-right">{p.cpu}% cpu</span>
              <span className="text-xs text-zinc-600 w-16 text-right">{p.mem}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
