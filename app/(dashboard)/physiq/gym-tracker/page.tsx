import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { GymTrackerWidget } from "@/components/widgets/GymTrackerWidget"

// Standalone gym-tracker prototype. Not wired into the Physiq tab yet — review
// here, then a follow-up brief replaces the mock workout log in PhysiqWidget.
export default function GymTrackerPage() {
  return (
    <div className="max-w-3xl">
      <Link
        href="/physiq"
        className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors mb-3"
      >
        <ArrowLeft size={14} /> Back to Physiq
      </Link>
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-zinc-100">Gym Tracker</h1>
        <p className="text-sm text-zinc-500 mt-0.5">Log lifts between sets · 🏆 PRs · e1RM trend</p>
      </div>
      <GymTrackerWidget />
    </div>
  )
}
