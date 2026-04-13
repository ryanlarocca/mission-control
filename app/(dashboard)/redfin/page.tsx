import { RedfinWidget } from "@/components/widgets/RedfinWidget"

export default function RedfinPage() {
  return (
    <div className="max-w-2xl">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-zinc-100">Redfin Search</h1>
        <p className="text-sm text-zinc-500 mt-0.5">Scored listings · Pipeline status · Outreach</p>
      </div>
      <RedfinWidget />
    </div>
  )
}
