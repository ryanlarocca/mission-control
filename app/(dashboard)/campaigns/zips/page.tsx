import { Suspense } from "react"
import { ZipCutTab } from "@/components/widgets/ZipCutTab"

// /campaigns/zips?campaign=<id> — tick the site zips to drop from a
// direct-mail list build. Without ?campaign the newest campaign that has
// zips loaded is used (the login redirect keeps the path but drops the query).
export default function CampaignZipsPage() {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-zinc-500">Loading…</div>}>
      <ZipCutTab />
    </Suspense>
  )
}
