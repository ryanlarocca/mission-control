"use client"

import { IdCard } from "lucide-react"
import { CARD_LINE_DISPLAY } from "@/lib/card-line"

// Card # toggle (2026-10-26), shared by the queue card and the detail modal —
// the Relationships twin of Leads' My Cell button. ON = calls and texts to
// this contact go from the business-card line instead of Ryan's cell. The
// parent owns the flag (optimistic flip + revert, see CRMSTab
// handleCardLineToggle); the server re-reads it on every call/send.
export function CardLineButton({ on, onToggle, disabled }: {
  on: boolean
  onToggle: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={on}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded text-xs font-medium transition-colors disabled:opacity-50 ${
        on
          ? "bg-sky-900/40 border border-sky-900 text-sky-200"
          : "bg-zinc-900 border border-zinc-800 hover:border-sky-900/60 text-zinc-300 hover:text-sky-200"
      }`}
      title={on
        ? `Calls and texts to this contact go from your business card number ${CARD_LINE_DISPLAY} — click to switch back to your cell`
        : `Call and text from your business card number ${CARD_LINE_DISPLAY} instead of your cell`}
    >
      <IdCard className="w-3.5 h-3.5" />
      {on ? "Card # ✓" : "Card #"}
    </button>
  )
}
