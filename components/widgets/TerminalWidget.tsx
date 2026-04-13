"use client"

import { useEffect, useRef, useState } from "react"
import { mockTerminalLines } from "@/lib/mockData"
import type { TerminalLine } from "@/types"

const lineStyles: Record<string, string> = {
  command: "text-green-400 font-semibold",
  output: "text-zinc-300",
  error: "text-red-400",
  success: "text-emerald-400",
  dim: "text-zinc-600",
}

function TerminalLine({ line }: { line: TerminalLine }) {
  const style = lineStyles[line.type] || "text-zinc-300"
  const prefix = line.type === "command" ? <span className="text-zinc-600 select-none mr-2">$</span> : null

  return (
    <div className={`font-mono text-xs leading-5 ${style}`}>
      {prefix}
      {line.text}
    </div>
  )
}

const newLines: TerminalLine[] = [
  { id: "n1", type: "command", text: "curl -s https://ryanlarocca.github.io/physiq/ | grep -c 'sbFetch'" },
  { id: "n2", type: "success", text: "26" },
  { id: "n3", type: "dim", text: "─── awaiting next task ───" },
]

export function TerminalWidget() {
  const [visibleLines, setVisibleLines] = useState<TerminalLine[]>([])
  const [showCursor, setShowCursor] = useState(true)
  const [streaming, setStreaming] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Stream lines in on mount
  useEffect(() => {
    const allLines = [...mockTerminalLines, ...newLines]
    let i = 0
    const interval = setInterval(() => {
      if (i >= allLines.length) {
        setStreaming(false)
        clearInterval(interval)
        return
      }
      setVisibleLines(prev => [...prev, allLines[i]])
      i++
    }, 90)
    return () => clearInterval(interval)
  }, [])

  // Blink cursor
  useEffect(() => {
    const interval = setInterval(() => setShowCursor(p => !p), 530)
    return () => clearInterval(interval)
  }, [])

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [visibleLines])

  return (
    <div className="flex flex-col h-[calc(100vh-140px)] bg-zinc-950 border border-zinc-800 rounded-lg overflow-hidden font-mono">
      {/* Terminal header bar */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-800 bg-zinc-900">
        <div className="flex gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
          <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
          <span className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
        </div>
        <span className="text-xs text-zinc-500 mx-auto">cody@mission-control — physiq</span>
        <span className={`text-xs flex items-center gap-1.5 ${streaming ? "text-green-400" : "text-zinc-500"}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${streaming ? "bg-green-400 animate-pulse" : "bg-zinc-600"}`} />
          {streaming ? "running" : "idle"}
        </span>
      </div>

      {/* Terminal body */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-0.5">
        {visibleLines.map(line => (
          <TerminalLine key={line.id} line={line} />
        ))}

        {/* Cursor */}
        <div className="font-mono text-xs leading-5 text-zinc-300 flex items-center gap-1 mt-0.5">
          <span className="text-zinc-600 select-none">$</span>
          <span
            className={`inline-block w-2 h-3.5 bg-green-400 align-middle transition-opacity duration-75 ${showCursor ? "opacity-100" : "opacity-0"}`}
          />
        </div>

        <div ref={bottomRef} />
      </div>
    </div>
  )
}
