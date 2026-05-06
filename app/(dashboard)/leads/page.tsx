"use client"

import { useState } from "react"
import { LeadsTab } from "@/components/widgets/LeadsTab"
import { FollowUpTab } from "@/components/widgets/FollowUpTab"

type View = "leads" | "followups"

export default function LeadsPage() {
  const [view, setView] = useState<View>("leads")

  return (
    <div className="max-w-3xl">
      {/* Phase 7C — Part 5: sub-nav between the main Leads view and the
          Follow-Up to-do list (recommendations from the AI call analyzer). */}
      <div className="mb-4 flex gap-1.5 border-b border-zinc-800">
        {[
          { key: "leads" as View, label: "Leads" },
          { key: "followups" as View, label: "Follow-ups" },
        ].map(({ key, label }) => {
          const active = view === key
          return (
            <button
              key={key}
              onClick={() => setView(key)}
              className={`px-3 py-2 text-sm border-b-2 transition-colors -mb-px ${
                active
                  ? "text-zinc-100 border-zinc-100 font-medium"
                  : "text-zinc-500 border-transparent hover:text-zinc-200"
              }`}
            >
              {label}
            </button>
          )
        })}
      </div>

      {view === "leads" ? <LeadsTab /> : <FollowUpTab />}
    </div>
  )
}
