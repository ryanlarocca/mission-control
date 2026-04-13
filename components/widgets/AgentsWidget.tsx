"use client"

import { useEffect, useState } from "react"
import { mockAgents } from "@/lib/mockData"
import type { AgentStatus } from "@/types"
import { Cpu, Zap, MessageSquare, CheckCircle } from "lucide-react"

const statusConfig = {
  online: { label: "Online", dot: "bg-green-400 animate-pulse", text: "text-green-400", ring: "border-green-500/20" },
  working: { label: "Working", dot: "bg-blue-400 animate-pulse", text: "text-blue-400", ring: "border-blue-500/20" },
  idle: { label: "Idle", dot: "bg-zinc-500", text: "text-zinc-500", ring: "border-zinc-700" },
  offline: { label: "Offline", dot: "bg-red-500", text: "text-red-400", ring: "border-red-500/20" },
}

const agentAccent: Record<string, string> = {
  thadius: "from-amber-500/5 to-transparent border-amber-500/15",
  cody: "from-blue-500/5 to-transparent border-blue-500/15",
}

const agentDot: Record<string, string> = {
  thadius: "bg-amber-400",
  cody: "bg-blue-400",
}

function AgentCard({ agent }: { agent: AgentStatus }) {
  const status = statusConfig[agent.status]
  const accent = agentAccent[agent.id] || "from-zinc-800/20 to-transparent border-zinc-700"

  // Simulate task counter ticking
  const [tasks, setTasks] = useState(agent.tasksToday)
  useEffect(() => {
    if (agent.status !== "working") return
    const t = setTimeout(() => setTasks(p => p + 1), 8000 + Math.random() * 4000)
    return () => clearTimeout(t)
  }, [tasks, agent.status])

  return (
    <div className={`bg-gradient-to-b ${accent} border rounded-lg p-4`}>
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className={`w-2 h-2 rounded-full ${agentDot[agent.id] || "bg-zinc-400"}`} />
          <div>
            <p className="text-sm font-semibold text-zinc-100">{agent.name}</p>
            <p className="text-xs text-zinc-500">{agent.role}</p>
          </div>
        </div>
        <span className={`flex items-center gap-1.5 text-xs ${status.text}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
          {status.label}
        </span>
      </div>

      {/* Current task */}
      <div className="mb-3 min-h-[32px]">
        {agent.currentTask ? (
          <div className="bg-zinc-800/60 rounded px-2.5 py-1.5">
            <p className="text-xs text-zinc-400 uppercase tracking-wider mb-0.5">Current task</p>
            <p className="text-xs text-zinc-200">{agent.currentTask}</p>
          </div>
        ) : (
          <div className="bg-zinc-800/30 rounded px-2.5 py-1.5">
            <p className="text-xs text-zinc-600 italic">No active task</p>
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 pt-2 border-t border-zinc-800">
        <div className="text-center">
          <div className="flex justify-center mb-0.5">
            <CheckCircle className="w-3 h-3 text-zinc-500" />
          </div>
          <p className="text-sm font-bold text-zinc-100">{tasks}</p>
          <p className="text-xs text-zinc-600">tasks today</p>
        </div>
        <div className="text-center">
          <div className="flex justify-center mb-0.5">
            <MessageSquare className="w-3 h-3 text-zinc-500" />
          </div>
          <p className="text-sm font-bold text-zinc-100">{agent.messagesExchanged}</p>
          <p className="text-xs text-zinc-600">messages</p>
        </div>
        <div className="text-center">
          <div className="flex justify-center mb-0.5">
            <Cpu className="w-3 h-3 text-zinc-500" />
          </div>
          <p className="text-xs font-mono text-zinc-400 mt-0.5">Sonnet</p>
          <p className="text-xs text-zinc-600">model</p>
        </div>
      </div>

      {/* Last active */}
      <p className="text-xs text-zinc-600 mt-2">Last active {agent.lastActive}</p>
    </div>
  )
}

const activityLog = [
  { time: "11:48 AM", agent: "cody", msg: "Deployed sbFetch REST migration to physiq — freeze fixed" },
  { time: "11:33 AM", agent: "cody", msg: "Bumped SW cache to v5, confirmed live on GitHub Pages" },
  { time: "10:31 AM", agent: "cody", msg: "sbFetch test suite passed 9/9 — all ops verified over REST" },
  { time: "10:14 AM", agent: "cody", msg: "Assigned physiq freeze task by Ryan" },
  { time: "09:52 AM", agent: "thadius", msg: "COI outreach batch sent — 12 contacts" },
  { time: "09:30 AM", agent: "thadius", msg: "Redfin scan complete — 3 new high-score listings flagged" },
  { time: "Yesterday", agent: "cody", msg: "Fixed macro accuracy: Haiku → Sonnet on parse-meal.js" },
]

const agentLogDot: Record<string, string> = {
  thadius: "bg-amber-400",
  cody: "bg-blue-400",
}

export function AgentsWidget() {
  return (
    <div className="space-y-6">
      {/* Agent cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {mockAgents.map(agent => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>

      {/* Activity log */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <div className="flex items-center gap-2 mb-3">
          <Zap className="w-3.5 h-3.5 text-zinc-500" />
          <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Activity Log</p>
        </div>
        <div className="space-y-0">
          {activityLog.map((entry, i) => (
            <div key={i} className="flex items-start gap-3 py-2 border-b border-zinc-800 last:border-0">
              <span className="text-xs text-zinc-600 w-16 shrink-0 pt-0.5">{entry.time}</span>
              <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${agentLogDot[entry.agent] || "bg-zinc-500"}`} />
              <p className="text-xs text-zinc-300 leading-relaxed">{entry.msg}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
