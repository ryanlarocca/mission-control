"use client"

import { useState } from "react"
import { FileText, Folder, FolderOpen, Search, ChevronRight } from "lucide-react"

const docs = [
  {
    category: "Skills",
    icon: "🛠",
    files: [
      { name: "COI_OUTREACH/SKILL.md", modified: "Today", size: "4.2 KB" },
      { name: "REDFIN_SKILL/SKILL.md", modified: "Mar 29", size: "3.1 KB" },
      { name: "AGENT_EMAIL/SKILL.md", modified: "Mar 27", size: "2.8 KB" },
      { name: "CALENDAR_SKILL/SKILL.md", modified: "Mar 26", size: "1.9 KB" },
      { name: "COI_ADDITION/SKILL.md", modified: "Today", size: "1.4 KB" },
    ],
  },
  {
    category: "Projects",
    icon: "📁",
    files: [
      { name: "physiq/index.html", modified: "Today", size: "318 KB" },
      { name: "lrghomes-landing/index.html", modified: "Mar 29", size: "24 KB" },
      { name: "lrg-homes-website/", modified: "Mar 28", size: "—" },
      { name: "mission-control/", modified: "Today", size: "—" },
    ],
  },
  {
    category: "Memory",
    icon: "🧠",
    files: [
      { name: "MEMORY.md", modified: "Today", size: "6.1 KB" },
      { name: "2026-03-31-gemini-swap.md", modified: "Today", size: "1.2 KB" },
      { name: "2026-03-30-mission-control-spec.md", modified: "Today", size: "8.4 KB" },
      { name: "redfin-scan-state.json", modified: "Mar 29", size: "2.1 KB" },
    ],
  },
  {
    category: "Scripts",
    icon: "⚙️",
    files: [
      { name: "coi_outreach.py", modified: "Mar 28", size: "18 KB" },
      { name: "redfin-outreach-approval.py", modified: "Mar 27", size: "14 KB" },
      { name: "draft_batch.py", modified: "Mar 25", size: "9.2 KB" },
      { name: "test-sbfetch.mjs", modified: "Today", size: "3.8 KB" },
    ],
  },
]

export function DocumentsWidget() {
  const [search, setSearch] = useState("")
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["Skills", "Projects"]))
  const [selected, setSelected] = useState<string | null>(null)

  const toggle = (cat: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(cat) ? next.delete(cat) : next.add(cat)
      return next
    })
  }

  const filtered = docs.map(d => ({
    ...d,
    files: search
      ? d.files.filter(f => f.name.toLowerCase().includes(search.toLowerCase()))
      : d.files,
  })).filter(d => !search || d.files.length > 0)

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      {/* Search */}
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
        <Search className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search workspace..."
          className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-600 outline-none"
        />
      </div>

      {/* File tree */}
      <div className="divide-y divide-zinc-800 overflow-auto">
        {filtered.map(group => (
          <div key={group.category}>
            <button
              onClick={() => toggle(group.category)}
              className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-zinc-800/50 transition-colors"
            >
              <ChevronRight
                className={`w-3.5 h-3.5 text-zinc-500 transition-transform ${expanded.has(group.category) ? "rotate-90" : ""}`}
              />
              {expanded.has(group.category)
                ? <FolderOpen className="w-4 h-4 text-amber-400/70" />
                : <Folder className="w-4 h-4 text-amber-400/70" />}
              <span className="text-sm font-medium text-zinc-300">{group.category}</span>
              <span className="ml-auto text-xs text-zinc-600">{group.files.length}</span>
            </button>

            {expanded.has(group.category) && (
              <div className="bg-zinc-950/40">
                {group.files.map(file => (
                  <button
                    key={file.name}
                    onClick={() => setSelected(file.name)}
                    className={`w-full flex items-center gap-3 pl-10 pr-4 py-2 text-left hover:bg-zinc-800/40 transition-colors ${selected === file.name ? "bg-zinc-800/60" : ""}`}
                  >
                    <FileText className="w-3.5 h-3.5 text-zinc-600 shrink-0" />
                    <span className="text-xs text-zinc-300 flex-1 truncate font-mono">{file.name}</span>
                    <span className="text-xs text-zinc-600 shrink-0">{file.modified}</span>
                    <span className="text-xs text-zinc-700 w-14 text-right shrink-0">{file.size}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* File Browser coming soon */}
      <div className="px-4 py-3 border-t border-zinc-800 bg-zinc-950/40 flex items-center gap-2">
        <span className="text-xs text-zinc-600">📂</span>
        <p className="text-xs text-zinc-600 italic">File Browser coming soon — full workspace preview &amp; editing from the dashboard.</p>
      </div>
    </div>
  )
}
