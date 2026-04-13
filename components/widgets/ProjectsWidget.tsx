"use client"

import { useEffect, useState } from "react"
import { ChevronLeft, ChevronDown, ChevronRight, FileText, FolderOpen, RefreshCw, CheckCircle, RotateCcw, Plus, X } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

interface ProjectEntry {
  id: string
  name: string
  files: string[]
  description: string
  modified: string
  completed: boolean
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const h = Math.floor(diff / 3600000)
  if (h < 1) return "just now"
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" })
}

function FileViewer({
  project,
  file,
  onBack,
}: {
  project: string
  file: string
  onBack: () => void
}) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    setContent(null)
    setError(false)
    fetch(`/api/projects/content?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}`)
      .then(r => r.json())
      .then(d => {
        if (d.content) setContent(d.content)
        else setError(true)
      })
      .catch(() => setError(true))
  }, [project, file])

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-100 mb-5 transition-colors"
      >
        <ChevronLeft className="w-4 h-4" />
        <span className="font-mono text-xs text-zinc-500">{project}/</span>
        <span className="text-zinc-300">{file}</span>
      </button>

      {!content && !error && (
        <div className="py-20 text-center text-zinc-600 text-sm">Loading...</div>
      )}
      {error && (
        <div className="py-20 text-center text-zinc-600 text-sm">Could not load file.</div>
      )}
      {content && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg px-5 py-5 prose prose-invert prose-sm max-w-none
          prose-headings:text-zinc-100 prose-headings:font-semibold
          prose-p:text-zinc-300 prose-p:leading-relaxed
          prose-a:text-blue-400 prose-a:no-underline hover:prose-a:underline
          prose-code:text-emerald-400 prose-code:bg-zinc-800 prose-code:px-1 prose-code:rounded prose-code:text-xs
          prose-pre:bg-zinc-950 prose-pre:border prose-pre:border-zinc-800
          prose-li:text-zinc-300
          prose-strong:text-zinc-100
          prose-hr:border-zinc-800
          prose-blockquote:border-zinc-700 prose-blockquote:text-zinc-400
        ">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      )}
    </div>
  )
}

function ProjectCard({
  project,
  onOpen,
  onToggleComplete,
}: {
  project: ProjectEntry
  onOpen: (project: string, file: string) => void
  onToggleComplete: (id: string, completed: boolean) => void
}) {
  const [busy, setBusy] = useState(false)

  const handleToggle = async () => {
    setBusy(true)
    await fetch("/api/projects/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: project.id, action: project.completed ? "restore" : "complete" }),
    })
    onToggleComplete(project.id, !project.completed)
    setBusy(false)
  }

  return (
    <div className={`bg-zinc-900 border rounded-lg overflow-hidden transition-colors ${
      project.completed ? "border-zinc-800/50 opacity-60" : "border-zinc-800 hover:border-zinc-700"
    }`}>
      <div className="px-4 py-4">
        <div className="flex items-start gap-3">
          <FolderOpen className={`w-4 h-4 shrink-0 mt-0.5 ${project.completed ? "text-zinc-600" : "text-amber-400/70"}`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 mb-1">
              <p className={`text-sm font-semibold truncate ${project.completed ? "text-zinc-500 line-through" : "text-zinc-100"}`}>
                {project.name}
              </p>
              <span className="text-xs text-zinc-600 shrink-0">{timeAgo(project.modified)}</span>
            </div>

            {project.description && (
              <p className="text-xs text-zinc-400 leading-relaxed mb-3 line-clamp-2">{project.description}</p>
            )}

            <div className="flex items-center justify-between gap-2 flex-wrap">
              {project.files.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {project.files.map(f => (
                    <button
                      key={f}
                      onClick={() => onOpen(project.id, f)}
                      className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition-colors"
                    >
                      <FileText className="w-3 h-3 text-zinc-500" />
                      {f}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-zinc-600 italic">No readable docs</p>
              )}

              <button
                onClick={handleToggle}
                disabled={busy}
                className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border transition-colors shrink-0 ml-auto ${
                  project.completed
                    ? "border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600"
                    : "border-zinc-700 text-zinc-500 hover:text-emerald-400 hover:border-emerald-500/40"
                }`}
              >
                {project.completed
                  ? <><RotateCcw className="w-3 h-3" /> Restore</>
                  : <><CheckCircle className="w-3 h-3" /> Complete</>
                }
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ProjectsWidget() {
  const [projects, setProjects] = useState<ProjectEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [viewing, setViewing] = useState<{ project: string; file: string } | null>(null)
  const [lastFetch, setLastFetch] = useState("")
  const [completedOpen, setCompletedOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState("")
  const [newDesc, setNewDesc] = useState("")
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState("")

  const handleCreate = async () => {
    if (!newName.trim()) return
    setCreating(true)
    setCreateError("")
    const res = await fetch("/api/projects/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), description: newDesc.trim() }),
    })
    const data = await res.json()
    if (res.ok) {
      setAdding(false)
      setNewName("")
      setNewDesc("")
      load()
    } else {
      setCreateError(data.error ?? "Failed to create project")
    }
    setCreating(false)
  }

  const load = () => {
    setLoading(true)
    fetch("/api/projects/list")
      .then(r => r.json())
      .then(d => {
        setProjects(d.projects ?? [])
        setLastFetch(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }

  const handleToggleComplete = (id: string, nowComplete: boolean) => {
    setProjects(prev =>
      prev.map(p => p.id === id ? { ...p, completed: nowComplete } : p)
    )
  }

  useEffect(() => { load() }, [])

  if (viewing) {
    return (
      <FileViewer
        project={viewing.project}
        file={viewing.file}
        onBack={() => setViewing(null)}
      />
    )
  }

  const active = projects.filter(p => !p.completed)
  const completed = projects.filter(p => p.completed)

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Projects</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            {active.length} active · {completed.length} completed · live filesystem
            {lastFetch && ` · ${lastFetch}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setAdding(o => !o); setCreateError("") }}
            className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-emerald-400 transition-colors px-2.5 py-1.5 rounded hover:bg-zinc-800"
          >
            {adding ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
            {adding ? "Cancel" : "New"}
          </button>
          <button
            onClick={load}
            className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-2.5 py-1.5 rounded hover:bg-zinc-800"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* New project form */}
      {adding && (
        <div className="bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-4 mb-4 space-y-3">
          <input
            type="text"
            placeholder="Project name"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleCreate()}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-500"
            autoFocus
          />
          <input
            type="text"
            placeholder="Description (optional)"
            value={newDesc}
            onChange={e => setNewDesc(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleCreate()}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-500"
          />
          {createError && <p className="text-xs text-red-400">{createError}</p>}
          <button
            onClick={handleCreate}
            disabled={creating || !newName.trim()}
            className="w-full py-2 rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-sm font-medium text-white transition-colors"
          >
            {creating ? "Creating..." : "Create Project"}
          </button>
        </div>
      )}

      {loading && projects.length === 0 && (
        <div className="py-20 text-center text-zinc-600 text-sm">Loading projects...</div>
      )}

      {/* Active projects */}
      <div className="space-y-3">
        {active.map(p => (
          <ProjectCard
            key={p.id}
            project={p}
            onOpen={(project, file) => setViewing({ project, file })}
            onToggleComplete={handleToggleComplete}
          />
        ))}
        {active.length === 0 && !loading && (
          <p className="text-sm text-zinc-600 py-4">No active projects.</p>
        )}
      </div>

      {/* Completed section */}
      {completed.length > 0 && (
        <div className="mt-6">
          <button
            onClick={() => setCompletedOpen(o => !o)}
            className="flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors mb-3"
          >
            {completedOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            <span className="uppercase tracking-widest font-semibold">Completed ({completed.length})</span>
          </button>

          {completedOpen && (
            <div className="space-y-3">
              {completed.map(p => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  onOpen={(project, file) => setViewing({ project, file })}
                  onToggleComplete={handleToggleComplete}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
