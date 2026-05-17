"use client"

import { Suspense } from "react"
import { LeadsTab } from "@/components/widgets/LeadsTab"

// Slim lead viewer for the Drips-tab modal — lives outside the (dashboard)
// route group so the sidebar/nav don't render inside the iframe. LeadsTab
// itself reads ?phone= and ?embed=1 from the query string; embed=1 hides
// its filter/search chrome, leaving just the deep-linked card.
export default function LeadsEmbedPage() {
  return (
    <Suspense fallback={<div className="p-3 text-xs text-zinc-500">Loading lead…</div>}>
      <div className="p-3 md:p-4">
        <LeadsTab />
      </div>
    </Suspense>
  )
}
