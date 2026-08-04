"use client"

import { useCallback, useEffect, useState } from "react"
import { Plus } from "lucide-react"
import type { StrengthCard } from "@/lib/gymTracker"
import { ExerciseCard } from "./gym-tracker/ExerciseCard"
import { ExerciseDetailSheet } from "./gym-tracker/ExerciseDetailSheet"
import { type SaveSetResult } from "./gym-tracker/LogSetSheet"
import { AddExerciseModal } from "./gym-tracker/AddExerciseModal"
import { CardioTab } from "./gym-tracker/CardioTab"
import { StatsTab } from "./gym-tracker/StatsTab"
import { VoiceQuickLog } from "./gym-tracker/VoiceQuickLog"

type Tab = "strength" | "cardio" | "stats"

export function GymTrackerWidget() {
  const [tab, setTab] = useState<Tab>("strength")
  const [cards, setCards] = useState<StrengthCard[] | null>(null)
  const [activeCard, setActiveCard] = useState<StrengthCard | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const loadStrength = useCallback(async () => {
    try {
      const res = await fetch("/api/physiq/gym/strength")
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Failed to load")
      setCards(json.cards ?? [])
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load")
      setCards([])
    }
  }, [])

  useEffect(() => { loadStrength() }, [loadStrength])

  function flashToast(msg: string) {
    setToast(msg)
    window.setTimeout(() => setToast(null), 2500)
  }

  // Set logged from inside the detail sheet — toast + refresh the board, but
  // leave the sheet open so the new point lands on the chart mid-workout.
  function onLogged(result: SaveSetResult) {
    if (result.isNewPr) flashToast(`🏆 New PR — ${result.exerciseName}!`)
    else flashToast(`Logged · ${result.exerciseName}`)
    loadStrength()
  }

  return (
    <div className="space-y-4">
      {/* Voice quick-log — always visible, logs straight from one spoken phrase */}
      {cards && cards.length > 0 && (
        <VoiceQuickLog cards={cards} onLogged={(r) => {
          if (r.isNewPr) flashToast(`🏆 New PR — ${r.exerciseName}!`)
          else flashToast(`Logged · ${r.exerciseName}`)
          loadStrength()
        }} />
      )}

      {/* Sub-tabs */}
      <div className="flex gap-1.5">
        {(["strength", "cardio", "stats"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded-full text-sm capitalize transition-colors ${
              tab === t ? "bg-zinc-700 text-zinc-100" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "strength" ? (
        <>
          {cards === null ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-36 bg-zinc-800 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : cards.length === 0 ? (
            <p className="text-sm text-zinc-500 py-8 text-center">
              {loadError ?? "No exercises yet. Tap + to add your first one."}
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {cards.map((card) => (
                <ExerciseCard key={card.id} card={card} onTap={() => setActiveCard(card)} />
              ))}
            </div>
          )}

          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-200 transition-colors"
          >
            <Plus size={16} /> Add Exercise
          </button>
        </>
      ) : tab === "cardio" ? (
        <CardioTab />
      ) : (
        <StatsTab />
      )}

      {activeCard && (
        <ExerciseDetailSheet
          card={activeCard}
          onClose={() => setActiveCard(null)}
          onLogged={onLogged}
        />
      )}

      {showAdd && (
        <AddExerciseModal
          defaultCategory={tab === "cardio" ? "cardio" : "strength"}
          onClose={() => setShowAdd(false)}
          onAdded={() => { setShowAdd(false); loadStrength() }}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] bg-amber-500 text-zinc-950 font-semibold text-sm px-4 py-2 rounded-full shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}
