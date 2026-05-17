"use client"

import { Suspense, useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import { LeadsTab } from "@/components/widgets/LeadsTab"
import { FollowUpTab } from "@/components/widgets/FollowUpTab"
import { DripsTab } from "@/components/widgets/DripsTab"

type View = "leads" | "followups" | "drips"

function LeadsPageBody() {
  const searchParams = useSearchParams()
  // When the Follow-Up tab routes here with ?phone=..., force the Leads
  // sub-view so the card the user wants to see actually renders. Without
  // this, the wrapper's view state stays on "followups" after the
  // router.push and the user lands back on the to-do list.
  const phoneParam = searchParams.get("phone")
  // ?embed=1 — page is rendered inside the Drips-tab lead modal (iframe).
  // Hide the sub-nav so the modal shows just the LeadsTab content, with the
  // deep-linked card auto-expanded.
  const embedMode = searchParams.get("embed") === "1"
  const [view, setView] = useState<View>("leads")

  useEffect(() => {
    if (phoneParam) setView("leads")
  }, [phoneParam])

  return (
    <div className="max-w-3xl">
      {/* Phase 7C — Part 5: sub-nav between the main Leads view and the
          Follow-Up to-do list (recommendations from the AI call analyzer). */}
      {!embedMode && (
        <div className="mb-4 flex gap-1.5 border-b border-zinc-800">
          {[
            { key: "leads" as View, label: "Leads" },
            { key: "followups" as View, label: "Follow-ups" },
            { key: "drips" as View, label: "Drips" },
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
      )}

      {view === "leads" ? <LeadsTab /> : view === "followups" ? <FollowUpTab /> : <DripsTab />}
    </div>
  )
}

export default function LeadsPage() {
  // useSearchParams needs a Suspense boundary in app-router client pages
  // so the page can statically render before query params resolve.
  return (
    <Suspense fallback={<div className="max-w-3xl" />}>
      <LeadsPageBody />
    </Suspense>
  )
}
