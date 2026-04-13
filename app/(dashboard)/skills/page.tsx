import { SkillsWidget } from "@/components/widgets/SkillsWidget"

export default function SkillsPage() {
  return (
    <div className="max-w-2xl">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-zinc-100">Skills</h1>
        <p className="text-sm text-zinc-500 mt-0.5">Active automations running on Mac Mini</p>
      </div>
      <SkillsWidget />
    </div>
  )
}
