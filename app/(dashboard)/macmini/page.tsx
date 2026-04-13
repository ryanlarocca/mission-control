import { MacMiniWidget } from "@/components/widgets/MacMiniWidget"

export default function MacMiniPage() {
  return (
    <div className="max-w-2xl">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-zinc-100">Mac Mini</h1>
        <p className="text-sm text-zinc-500 mt-0.5">System status · Remote access · Process monitor</p>
      </div>
      <MacMiniWidget />
    </div>
  )
}
