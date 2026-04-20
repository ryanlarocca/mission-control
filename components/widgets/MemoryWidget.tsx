"use client"

import { useEffect, useState } from "react"
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

interface MemoryEntry {
  file: string
  name: string
  description: string
  type: string
  body: string
  modified: string
}

interface MemoryResponse {
  index: string
  entries: MemoryEntry[]
}

const typeColors: Record<string, string> = {
  user: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  feedback: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  project: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  reference: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  unknown: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const h = Math.floor(diff / 3600000)
  if (h < 1) return "just now"
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" })
}

function MemoryCard({ entry }: { entry: MemoryEntry }) {
  const [open, setOpen] = useState(false)
  const color = typeColors[entry.type] ?? typeColors.unknown

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden hover:border-zinc-700 transition-colors">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-start gap-3 px-4 py-3 text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className={`text-[10px] px-1.5 py-0.5 rounded border uppercase tracking-wider ${color}`}>
              {entry.type}
            </span>
            <p className="text-sm font-semibold text-zinc-100 truncate">{entry.name}</p>
          </div>
          <p className="text-xs text-zinc-400 leading-relaxed line-clamp-2">{entry.description}</p>
          <p className="text-[10px] text-zinc-600 mt-1 font-mono">{timeAgo(entry.modified)}</p>
        </div>
        <span className="text-zinc-600 shrink-0 pt-0.5">
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </span>
      </button>

      {open && (
        <div className="border-t border-zinc-800 bg-zinc-950/40 px-4 py-4 prose prose-invert prose-sm max-w-none
          prose-headings:text-zinc-100 prose-p:text-zinc-300 prose-p:leading-relaxed
          prose-code:text-emerald-400 prose-code:bg-zinc-800 prose-code:px-1 prose-code:rounded prose-code:text-xs
          prose-li:text-zinc-300 prose-strong:text-zinc-100
        ">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.body}</ReactMarkdown>
          <p className="text-[10px] text-zinc-600 font-mono mt-3 not-prose">{entry.file}</p>
        </div>
      )}
    </div>
  )
}

export default function MemoryWidget() {
  const [data, setData] = useState<MemoryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [filter, setFilter] = useState<string>("all")

  const load = () => {
    setLoading(true)
    setError("")
    fetch("/api/memory", { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        if (d.error) setError(d.error)
        setData({ index: d.index ?? "", entries: d.entries ?? [] })
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const entries = data?.entries ?? []
  const types = Array.from(new Set(entries.map(e => e.type)))
  const visible = filter === "all" ? entries : entries.filter(e => e.type === filter)

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Memory</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            {entries.length} entries · auto-memory (live filesystem)
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-2.5 py-1.5 rounded hover:bg-zinc-800"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {types.length > 1 && (
        <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-lg p-1 w-fit mb-5">
          <button
            onClick={() => setFilter("all")}
            className={`px-3 py-1.5 rounded text-xs transition-colors ${
              filter === "all" ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            All ({entries.length})
          </button>
          {types.map(t => {
            const count = entries.filter(e => e.type === t).length
            return (
              <button
                key={t}
                onClick={() => setFilter(t)}
                className={`px-3 py-1.5 rounded text-xs transition-colors capitalize ${
                  filter === t ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {t} ({count})
              </button>
            )
          })}
        </div>
      )}

      {loading && entries.length === 0 && (
        <div className="py-20 text-center text-zinc-600 text-sm">Loading memory...</div>
      )}
      {error && entries.length === 0 && (
        <div className="py-20 text-center text-zinc-600 text-sm">
          Could not load memory. {error}
        </div>
      )}

      <div className="space-y-2">
        {visible.map(entry => <MemoryCard key={entry.file} entry={entry} />)}
      </div>
    </div>
  )
}
