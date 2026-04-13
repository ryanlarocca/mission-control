"use client"

import { useEffect, useState } from "react"
import { ChevronDown, ChevronRight, Clock } from "lucide-react"

interface Skill {
  id: string
  name: string
  description: string
  status: "active" | "inactive" | "scheduled"
  triggerType: "cron" | "event" | "manual" | "chat"
  triggerDetail: string
  lastRun: string
  scriptPath: string
}

const statusConfig: Record<string, { badge: string; dot: string; label: string }> = {
  active:    { badge: "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30", dot: "bg-emerald-400", label: "Active" },
  inactive:  { badge: "bg-zinc-500/20 text-zinc-400 border border-zinc-500/30", dot: "bg-zinc-500", label: "Inactive" },
  scheduled: { badge: "bg-amber-500/20 text-amber-400 border border-amber-500/30", dot: "bg-amber-400", label: "Scheduled" },
}

const triggerIcon: Record<string, string> = {
  cron:   "⏰",
  chat:   "💬",
  event:  "🔔",
  manual: "🖐️",
}

function formatLastRun(isoStr: string): string {
  try {
    const date = new Date(isoStr)
    const now = new Date("2026-03-31T12:00:00")
    const diffMs = now.getTime() - date.getTime()
    const diffH = Math.floor(diffMs / (1000 * 60 * 60))
    const diffD = Math.floor(diffH / 24)
    if (diffH < 1) return "Just now"
    if (diffH < 24) return `${diffH}h ago`
    if (diffD === 1) return "Yesterday"
    return `${diffD}d ago`
  } catch {
    return isoStr
  }
}

function SkillRow({ skill }: { skill: Skill }) {
  const [expanded, setExpanded] = useState(false)
  const s = statusConfig[skill.status] ?? statusConfig.inactive

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden hover:border-zinc-700 transition-colors">
      {/* Summary row */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left"
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.dot}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-zinc-100">{skill.name}</p>
            <span className={`text-xs px-1.5 py-0.5 rounded ${s.badge}`}>{s.label}</span>
            <span className="text-xs text-zinc-600">
              {triggerIcon[skill.triggerType]} {skill.triggerType}
            </span>
          </div>
          <p className="text-xs text-zinc-500 truncate mt-0.5">{skill.description}</p>
        </div>
        <span className="text-zinc-600 shrink-0">
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </span>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-zinc-800 bg-zinc-950/40 px-4 py-4 space-y-3">
          <p className="text-xs text-zinc-300 leading-relaxed">{skill.description}</p>

          <div className="flex items-start gap-6 flex-wrap">
            <div>
              <p className="text-xs text-zinc-600 mb-0.5">Trigger</p>
              <p className="text-xs text-zinc-400">{skill.triggerDetail}</p>
            </div>
            <div>
              <p className="text-xs text-zinc-600 mb-0.5">Last run</p>
              <p className="text-xs text-zinc-400 flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {formatLastRun(skill.lastRun)}
              </p>
            </div>
          </div>

          <div>
            <p className="text-xs text-zinc-600 mb-1">Script path</p>
            <code className="text-xs font-mono text-zinc-400 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 block break-all">
              {skill.scriptPath}
            </code>
          </div>
        </div>
      )}
    </div>
  )
}

export function SkillsWidget() {
  const [skills, setSkills] = useState<Skill[]>([])

  useEffect(() => {
    fetch("/data/skills.json")
      .then(r => r.json())
      .then((d: { skills: Skill[] }) => setSkills(d.skills))
      .catch(console.error)
  }, [])

  const activeCount = skills.filter(s => s.status === "active").length

  if (skills.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-sm text-zinc-600">Loading skills...</p>
      </div>
    )
  }

  return (
    <div>
      {/* Header summary */}
      <div className="flex items-center gap-3 mb-4">
        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded px-3 py-1.5">
          <p className="text-xs text-emerald-400 font-medium">{activeCount} skills active</p>
        </div>
        <p className="text-xs text-zinc-600">{skills.length} total</p>
      </div>

      {/* Skill accordion */}
      <div className="space-y-2">
        {skills.map(skill => (
          <SkillRow key={skill.id} skill={skill} />
        ))}
      </div>
    </div>
  )
}
