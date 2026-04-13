import { StocksWidget } from "@/components/widgets/StocksWidget"

export default function StocksPage() {
  return (
    <div className="max-w-2xl">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-zinc-100">Stocks</h1>
        <p className="text-sm text-zinc-500 mt-0.5">Portfolio · Live prices · P&amp;L</p>
      </div>
      <StocksWidget />
    </div>
  )
}
