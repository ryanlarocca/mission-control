import { TerminalWidget } from "@/components/widgets/TerminalWidget"

export default function TerminalPage() {
  return (
    <div className="max-w-3xl">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-zinc-100">Terminal</h1>
        <p className="text-sm text-zinc-500 mt-0.5">Cody&apos;s live workspace</p>
      </div>
      <TerminalWidget />
    </div>
  )
}
