"use client"

import { useEffect, useState } from "react"
import { Bug, FileText, ChevronRight, ChevronDown } from "lucide-react"

interface BugFile {
  name: string
  path: string
  preview: string
}

interface BugSession {
  date: string
  files: BugFile[]
  modified: string
}

function formatDate(dateStr: string) {
  // dateStr is like "2026-04-02"
  const d = new Date(dateStr + "T12:00:00")
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" })
}

function formatFileName(name: string) {
  return name.replace(".md", "").replace(/_/g, " ")
}

export function BugsWidget() {
  const [sessions, setSessions] = useState<BugSession[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedDate, setExpandedDate] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [content, setContent] = useState<string>("")
  const [contentLoading, setContentLoading] = useState(false)
  const [mobileView, setMobileView] = useState<"list" | "content">("list")

  useEffect(() => {
    fetch("/api/bugs")
      .then(r => r.json())
      .then(d => {
        setSessions(d.sessions ?? [])
        // Auto-expand the most recent session
        if (d.sessions?.length > 0) {
          setExpandedDate(d.sessions[0].date)
        }
      })
      .finally(() => setLoading(false))
  }, [])

  function selectFile(filePath: string) {
    setSelectedFile(filePath)
    setContentLoading(true)
    setMobileView("content")
    fetch(`/api/bugs/content?path=${encodeURIComponent(filePath)}`)
      .then(r => r.json())
      .then(d => setContent(d.content ?? d.error ?? ""))
      .finally(() => setContentLoading(false))
  }

  const totalFiles = sessions.reduce((acc, s) => acc + s.files.length, 0)

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-lg font-semibold text-zinc-100">Bugs</h1>
        <p className="text-sm text-zinc-500 mt-0.5">
          {loading ? "Loading…" : `${sessions.length} sessions · ${totalFiles} files`}
        </p>
      </div>

      {loading ? (
        <div className="text-sm text-zinc-500 animate-pulse">Loading bug sessions…</div>
      ) : sessions.length === 0 ? (
        <div className="text-sm text-zinc-500">No bug files found.</div>
      ) : (
        <div className="sm:flex sm:gap-4" style={{ minHeight: 500 }}>

          {/* Left: session + file list */}
          <div className={`sm:block sm:w-64 sm:shrink-0 sm:overflow-y-auto space-y-1 ${mobileView === "content" ? "hidden" : "block"}`}>
            {sessions.map(session => {
              const expanded = expandedDate === session.date
              return (
                <div key={session.date}>
                  <button
                    onClick={() => setExpandedDate(expanded ? null : session.date)}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
                  >
                    {expanded ? <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-zinc-500 shrink-0" />}
                    <span>{formatDate(session.date)}</span>
                    <span className="ml-auto text-xs text-zinc-600">{session.files.length}</span>
                  </button>

                  {expanded && (
                    <div className="ml-4 space-y-0.5 mt-0.5 mb-1">
                      {session.files.length === 0 ? (
                        <p className="text-xs text-zinc-600 px-3 py-1">No .md files</p>
                      ) : session.files.map(file => {
                        const active = selectedFile === file.path
                        return (
                          <button
                            key={file.path}
                            onClick={() => selectFile(file.path)}
                            className={`w-full text-left px-3 py-2 rounded-md transition-colors ${
                              active ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <FileText className="w-3 h-3 shrink-0 text-zinc-600" />
                              <span className="text-xs font-medium truncate">{formatFileName(file.name)}</span>
                            </div>
                            {file.preview && (
                              <p className="text-[10px] text-zinc-600 mt-0.5 truncate pl-5">{file.preview}</p>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Right: file content */}
          <div className={`sm:flex flex-1 flex-col bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden min-w-0 ${mobileView === "list" ? "hidden" : "flex"}`}>
            {/* Mobile back */}
            <div className="sm:hidden px-4 pt-3">
              <button
                onClick={() => setMobileView("list")}
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors mb-2"
              >
                ← All sessions
              </button>
            </div>

            {!selectedFile ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center">
                  <Bug className="w-8 h-8 text-zinc-700 mx-auto mb-2" />
                  <p className="text-sm text-zinc-500">Select a file to view</p>
                </div>
              </div>
            ) : contentLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <p className="text-sm text-zinc-500 animate-pulse">Loading…</p>
              </div>
            ) : (
              <>
                <div className="px-4 py-3 border-b border-zinc-800">
                  <p className="text-xs font-mono text-zinc-400">{selectedFile}</p>
                </div>
                <div className="flex-1 overflow-y-auto p-4">
                  <pre className="text-xs text-zinc-300 whitespace-pre-wrap font-mono leading-relaxed">{content}</pre>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
