"use client"

import { formatLoad, formatShortDate, type StrengthCard } from "@/lib/gymTracker"
import { Sparkline } from "./Sparkline"

// One strength exercise card. The whole card is the tap target → opens the
// Log Set sheet. Matches PhysiqWidget styling (zinc-900 / zinc-800).
export function ExerciseCard({
  card,
  onTap,
}: {
  card: StrengthCard
  onTap: () => void
}) {
  const { lastSet, prSet } = card

  return (
    <button
      onClick={onTap}
      className="text-left w-full bg-zinc-900 border border-zinc-800 rounded-lg p-4 hover:border-zinc-700 transition-colors flex flex-col gap-2 min-h-[44px]"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-zinc-100 font-semibold leading-tight">{card.name}</h3>
        {prSet && (
          <span className="shrink-0 text-[11px] font-medium text-amber-400 bg-amber-400/10 border border-amber-400/20 rounded-full px-2 py-0.5">
            🏆 {formatLoad(prSet.weight_lbs, prSet.reps)}
          </span>
        )}
      </div>

      <div className="text-sm space-y-0.5">
        {lastSet ? (
          <div className="text-zinc-300">
            {formatLoad(lastSet.weight_lbs, lastSet.reps)}
            <span className="text-zinc-500"> · {formatShortDate(lastSet.date)}</span>
          </div>
        ) : (
          <div className="text-zinc-500">No sets logged yet</div>
        )}
        {prSet && (
          <div className="text-zinc-400">
            🏆 {formatLoad(prSet.weight_lbs, prSet.reps)}
            <span className="text-zinc-500"> · {formatShortDate(prSet.date)}</span>
          </div>
        )}
      </div>

      <div className="mt-1 flex items-center justify-between">
        <Sparkline data={card.sparkline} />
        <span className="text-[11px] text-zinc-600">{card.sessionCount} sessions</span>
      </div>
    </button>
  )
}
