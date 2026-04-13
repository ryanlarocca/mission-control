"use client"

import { useState } from "react"
import { Edit2, Trash2, Plus, Check, X, Dumbbell } from "lucide-react"

const today = new Date().toISOString().split("T")[0]

const initialEntries = [
  { id: 1, time: "7:30 AM", description: "Greek Yogurt + Berries", calories: 180, protein: 18, carbs: 22, fat: 3 },
  { id: 2, time: "10:00 AM", description: "Protein Shake", calories: 150, protein: 30, carbs: 5, fat: 2 },
  { id: 3, time: "12:30 PM", description: "Ground Turkey + Rice", calories: 520, protein: 48, carbs: 54, fat: 10 },
  { id: 4, time: "3:30 PM", description: "Almonds", calories: 160, protein: 6, carbs: 6, fat: 14 },
]

const goal = { calories: 2200, protein: 180, carbs: 220, fat: 65 }

const workoutLog = [
  { id: "w1", date: "Today", exercise: "Bench Press", sets: 4, reps: 8, weight: "185 lbs", notes: "Last set RPE 9" },
  { id: "w2", date: "Today", exercise: "Incline Dumbbell Press", sets: 3, reps: 12, weight: "65 lbs", notes: "" },
  { id: "w3", date: "Today", exercise: "Cable Flye", sets: 3, reps: 15, weight: "40 lbs", notes: "Slow eccentric" },
  { id: "w4", date: "Today", exercise: "Tricep Rope Pushdown", sets: 3, reps: 15, weight: "55 lbs", notes: "" },
]

type Entry = typeof initialEntries[0]

function MacroBar({ label, value, goal, color }: { label: string; value: number; goal: number; color: string }) {
  const pct = Math.min((value / goal) * 100, 100)
  return (
    <div>
      <div className="flex justify-between mb-1">
        <span className="text-xs text-zinc-400">{label}</span>
        <span className="text-xs font-mono text-zinc-300">{value} / {goal}g</span>
      </div>
      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function PhysiqWidget() {
  const [entries, setEntries] = useState<Entry[]>(initialEntries)
  const [editId, setEditId] = useState<number | null>(null)
  const [editValues, setEditValues] = useState<Partial<Entry>>({})

  const totals = entries.reduce(
    (acc, e) => ({ calories: acc.calories + e.calories, protein: acc.protein + e.protein, carbs: acc.carbs + e.carbs, fat: acc.fat + e.fat }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 }
  )

  function startEdit(entry: Entry) {
    setEditId(entry.id)
    setEditValues({ ...entry })
  }

  function saveEdit() {
    setEntries(prev => prev.map(e => e.id === editId ? { ...e, ...editValues } as Entry : e))
    setEditId(null)
  }

  function deleteEntry(id: number) {
    setEntries(prev => prev.filter(e => e.id !== id))
  }

  return (
    <div className="space-y-4">
      {/* Date + app link */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-zinc-500">{new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</p>
        </div>
        <a
          href="https://ryanlarocca.github.io/physiq/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
        >
          Open Physiq App →
        </a>
      </div>

      {/* Calorie ring summary */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-2xl font-bold text-zinc-100">{totals.calories}</p>
            <p className="text-xs text-zinc-500">of {goal.calories} cal</p>
          </div>
          <div className={`text-sm font-semibold ${totals.calories > goal.calories ? "text-red-400" : "text-green-400"}`}>
            {goal.calories - totals.calories > 0 ? `${goal.calories - totals.calories} remaining` : "Over goal"}
          </div>
        </div>
        <div className="space-y-2.5">
          <MacroBar label="Protein" value={totals.protein} goal={goal.protein} color="bg-blue-500" />
          <MacroBar label="Carbs" value={totals.carbs} goal={goal.carbs} color="bg-amber-500" />
          <MacroBar label="Fat" value={totals.fat} goal={goal.fat} color="bg-rose-500" />
        </div>
      </div>

      {/* Entry table */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between">
          <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Food Log</p>
          <button className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-200 transition-colors">
            <Plus className="w-3.5 h-3.5" /> Add
          </button>
        </div>

        <div className="divide-y divide-zinc-800">
          {entries.map(entry => (
            <div key={entry.id} className="px-4 py-3">
              {editId === entry.id ? (
                <div className="space-y-2">
                  <input
                    className="w-full bg-zinc-800 text-sm text-zinc-100 rounded px-2 py-1 outline-none border border-zinc-700"
                    value={editValues.description || ""}
                    onChange={e => setEditValues(p => ({ ...p, description: e.target.value }))}
                  />
                  <div className="grid grid-cols-4 gap-2">
                    {(["calories", "protein", "carbs", "fat"] as const).map(field => (
                      <div key={field}>
                        <p className="text-xs text-zinc-600 mb-0.5 capitalize">{field}</p>
                        <input
                          type="number"
                          className="w-full bg-zinc-800 text-xs text-zinc-100 rounded px-2 py-1 outline-none border border-zinc-700"
                          value={editValues[field] || 0}
                          onChange={e => setEditValues(p => ({ ...p, [field]: Number(e.target.value) }))}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <button onClick={saveEdit} className="flex items-center gap-1 text-xs text-green-400 hover:text-green-300">
                      <Check className="w-3.5 h-3.5" /> Save
                    </button>
                    <button onClick={() => setEditId(null)} className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300">
                      <X className="w-3.5 h-3.5" /> Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-zinc-100 truncate">{entry.description}</p>
                    <p className="text-xs text-zinc-600">{entry.time}</p>
                  </div>
                  <div className="flex items-center gap-3 text-xs font-mono shrink-0">
                    <span className="text-zinc-300">{entry.calories}</span>
                    <span className="text-blue-400">{entry.protein}p</span>
                    <span className="text-amber-400">{entry.carbs}c</span>
                    <span className="text-rose-400">{entry.fat}f</span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button onClick={() => startEdit(entry)} className="text-zinc-600 hover:text-zinc-300 transition-colors">
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => deleteEntry(entry.id)} className="text-zinc-600 hover:text-red-400 transition-colors">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Workout Log */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Dumbbell className="w-3.5 h-3.5 text-zinc-500" />
            <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Workout Log</p>
          </div>
          <button className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-200 transition-colors">
            <Plus className="w-3.5 h-3.5" /> Add
          </button>
        </div>

        <div className="divide-y divide-zinc-800">
          {workoutLog.map(w => (
            <div key={w.id} className="px-4 py-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-zinc-100">{w.exercise}</p>
                {w.notes && <p className="text-xs text-zinc-500 mt-0.5">{w.notes}</p>}
              </div>
              <div className="flex items-center gap-3 text-xs font-mono shrink-0">
                <span className="text-zinc-400">{w.sets}×{w.reps}</span>
                <span className="text-zinc-500">{w.weight}</span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button className="text-zinc-600 hover:text-zinc-300 transition-colors">
                  <Edit2 className="w-3.5 h-3.5" />
                </button>
                <button className="text-zinc-600 hover:text-red-400 transition-colors">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
