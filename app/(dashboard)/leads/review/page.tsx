import { Suspense } from "react"
import { LeadReviewTab } from "@/components/widgets/LeadReviewTab"

// /leads/review — hidden one-off review screen (not in the menu). Ryan taps a
// decision per person; picks are recorded in lead_review_picks and applied
// afterwards on his say-so. Without ?batch the newest batch is shown (the
// login redirect keeps the path but drops the query).
export default function LeadReviewPage() {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-zinc-500">Loading…</div>}>
      <LeadReviewTab />
    </Suspense>
  )
}
