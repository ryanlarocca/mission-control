"use client"

import { Suspense, useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import { LeadsTab } from "@/components/widgets/LeadsTab"
import { FollowUpsTab } from "@/components/widgets/FollowUpsTab"

type View = "leads" | "followups"

function LeadsPageBody() {
  const searchParams = useSearchParams()
  // When a card routes here with ?phone=..., force the Leads sub-view so
  // the card the user wants actually renders. Without this the wrapper's
  // view state could stay on "followups" after the router.push.
  const phoneParam = searchParams.get("phone")
  // ?embed=1 — page is rendered inside a lead-card iframe overlay. Hide the
  // sub-nav so the modal shows just the LeadsTab content.
  const embedMode = searchParams.get("embed") === "1"
  const [view, setView] = useState<View>("leads")

  useEffect(() => {
    if (phoneParam) setView("leads")
  }, [phoneParam])

  return (
    <div className="max-w-3xl">
      {/* Two tabs: Leads is the database, Follow Ups is the merged worklist
          (calls + drips) — see components/widgets/FollowUpsTab.tsx. */}
      {!embedMode && (
        <div className="mb-4 flex gap-1.5 border-b border-zinc-800">
          {[
            { key: "leads" as View, label: "Leads" },
            { key: "followups" as View, label: "Follow Ups" },
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

      {view === "leads" ? <LeadsTab /> : <FollowUpsTab />}
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
