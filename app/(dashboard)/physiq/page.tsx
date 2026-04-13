import { PhysiqWidget } from "@/components/widgets/PhysiqWidget"

export default function PhysiqPage() {
  return (
    <div className="max-w-2xl">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-zinc-100">Physiq Portal</h1>
        <p className="text-sm text-zinc-500 mt-0.5">Today&apos;s macros · Edit entries · Goals</p>
      </div>
      <PhysiqWidget />
    </div>
  )
}
