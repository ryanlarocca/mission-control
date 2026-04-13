import { SocialWidget } from "@/components/widgets/SocialWidget"

export default function SocialPage() {
  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-zinc-100">Physiq Social Engine</h1>
        <p className="text-sm text-zinc-500 mt-0.5">Video approval queue, platform metrics, and backend activity</p>
      </div>
      <SocialWidget />
    </div>
  )
}
