"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

// The web twin of the Telegram card's ✋ Disagree: type what's off, it's
// stored on that review and put in front of the next one. It never moves
// the odds by itself.
export default function DisagreeButton({ checkpointId, existing }: { checkpointId: string; existing: string | null }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState("")
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle")
  const [err, setErr] = useState("")

  async function save() {
    if (!text.trim()) return
    setState("saving")
    try {
      const res = await fetch("/api/cycle/note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkpoint_id: checkpointId, note: text }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      setState("saved")
      setText("")
      setOpen(false)
      router.refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setState("error")
    }
  }

  return (
    <div className="mt-2">
      {existing && <p className="mb-2 whitespace-pre-line rounded bg-zinc-800/60 p-2 text-xs text-zinc-300">Your note: {existing}</p>}
      {!open ? (
        <button onClick={() => setOpen(true)} className="w-full rounded-md bg-zinc-700 py-2 text-xs font-semibold text-zinc-100">
          ✋ Disagree{state === "saved" ? " — saved, add another" : ""}
        </button>
      ) : (
        <div className="flex flex-col gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder="What's off? It's shown to the next review."
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 p-2 text-sm text-zinc-100 placeholder:text-zinc-600"
          />
          <div className="flex gap-2">
            <button onClick={save} disabled={state === "saving" || !text.trim()} className="flex-1 rounded-md bg-zinc-200 py-2 text-xs font-semibold text-zinc-900 disabled:opacity-50">
              {state === "saving" ? "Saving…" : "Save note"}
            </button>
            <button onClick={() => setOpen(false)} className="rounded-md px-3 py-2 text-xs text-zinc-400">
              Cancel
            </button>
          </div>
          {state === "error" && <p className="text-xs text-red-400">Couldn&apos;t save: {err}</p>}
        </div>
      )}
    </div>
  )
}
