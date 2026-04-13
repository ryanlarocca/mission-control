import { GoogleAdsWidget } from "@/components/widgets/GoogleAdsWidget"

export default function AdsPage() {
  return (
    <div className="max-w-2xl">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-zinc-100">Google Ads</h1>
        <p className="text-sm text-zinc-500 mt-0.5">LRG Homes campaigns · Spend · Conversions</p>
      </div>
      <GoogleAdsWidget />
    </div>
  )
}
