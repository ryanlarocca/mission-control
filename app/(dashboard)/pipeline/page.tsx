import { RealEstateWidget } from "@/components/widgets/RealEstateWidget"

export default function PipelinePage() {
  return (
    <div className="max-w-3xl">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-zinc-100">Real Estate</h1>
        <p className="text-sm text-zinc-500 mt-0.5">Agent emails · COI outreach · Redfin · Contacts · Leads</p>
      </div>
      <RealEstateWidget />
    </div>
  )
}
