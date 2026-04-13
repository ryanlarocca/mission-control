import { AgentsWidget } from "@/components/widgets/AgentsWidget"

export default function AgentsPage() {
  return (
    <div className="max-w-3xl">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-zinc-100">Agents</h1>
        <p className="text-sm text-zinc-500 mt-0.5">Thadius · Cody — status and activity</p>
      </div>
      <AgentsWidget />
    </div>
  )
}
