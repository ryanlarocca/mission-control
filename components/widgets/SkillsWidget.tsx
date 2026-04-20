"use client"

import { useEffect, useState } from "react"
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react"

interface Skill {
  id: string
  name: string
  label: string
  schedule: string
  program: string
  loaded: boolean
  running: boolean
  pid: number | null
  lastExitStatus: number | null
  plistPath: string
  plistModified: string
  lastLog: string | null
  logPath: string | null
}

function timeAgo(iso: string | null) {
  if (!iso) return "—"
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function statusMeta(s: Skill) {
  if (s.running) return { dot: "bg-emerald-400", badge: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30", label: "Running" }
  if (s.loaded) return { dot: "bg-amber-400", badge: "bg-amber-500/20 text-amber-400 border-amber-500/30", label: "Scheduled" }
  return { dot: "bg-zinc-500", badge: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30", label: "Unloaded" }
}

function SkillRow({ skill }: { skill: Skill }) {
  const [open, setOpen] = useState(false)
  const s = statusMeta(skill)

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden hover:border-zinc-700 transition-colors">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left"
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.dot}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-zinc-100">{skill.name}</p>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${s.badge}`}>{s.label}</span>
            <span className="text-[10px] text-zinc-500 font-mono">{skill.schedule}</span>
          </div>
          <p className="text-xs text-zinc-500 truncate mt-0.5">{skill.label}</p>
        </div>
        <span className="text-zinc-600 shrink-0">
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </span>
      </button>

      {open && (
        <div className="border-t border-zinc-800 bg-zinc-950/40 px-4 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <p className="text-zinc-600 mb-0.5">Status</p>
              <p className="text-zinc-300">
                {skill.running ? `Running (PID ${skill.pid})` : skill.loaded ? "Loaded, idle" : "Unloaded"}
              </p>
            </div>
            <div>
              <p className="text-zinc-600 mb-0.5">Last exit</p>
              <p className="text-zinc-300">
                {skill.lastExitStatus === null ? "—" : skill.lastExitStatus === 0 ? "OK (0)" : `Error (${skill.lastExitStatus})`}
              </p>
            </div>
            <div>
              <p className="text-zinc-600 mb-0.5">Schedule</p>
              <p className="text-zinc-300">{skill.schedule}</p>
            </div>
            <div>
              <p className="text-zinc-600 mb-0.5">Last log write</p>
              <p className="text-zinc-300">{timeAgo(skill.lastLog)}</p>
            </div>
          </div>

          <div>
            <p className="text-xs text-zinc-600 mb-1">Program</p>
            <code className="text-xs font-mono text-zinc-400 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 block break-all">
              {skill.program || "—"}
            </code>
          </div>

          {skill.logPath && (
            <div>
              <p className="text-xs text-zinc-600 mb-1">Log</p>
              <code className="text-xs font-mono text-zinc-400 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 block break-all">
                {skill.logPath}
              </code>
            </div>
          )}

          <div>
            <p className="text-xs text-zinc-600 mb-1">Plist</p>
            <code className="text-xs font-mono text-zinc-400 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 block break-all">
              {skill.plistPath}
            </code>
          </div>
        </div>
      )}
    </div>
  )
}

export function SkillsWidget() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  const load = () => {
    setLoading(true)
    setError("")
    fetch("/api/skills", { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        if (d.error) setError(d.error)
        setSkills(d.skills ?? [])
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const active = skills.filter(s => s.loaded).length

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="bg-emerald-500/10 border border-emerald-500/20 rounded px-3 py-1.5">
            <p className="text-xs text-emerald-400 font-medium">{active} loaded</p>
          </div>
          <p className="text-xs text-zinc-600">{skills.length} total · launchd</p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-2.5 py-1.5 rounded hover:bg-zinc-800"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {loading && skills.length === 0 && (
        <div className="py-20 text-center text-zinc-600 text-sm">Loading skills...</div>
      )}
      {error && skills.length === 0 && (
        <div className="py-20 text-center text-zinc-600 text-sm">
          Could not load skills. {error}
        </div>
      )}

      <div className="space-y-2">
        {skills.map(skill => <SkillRow key={skill.id} skill={skill} />)}
      </div>
    </div>
  )
}
