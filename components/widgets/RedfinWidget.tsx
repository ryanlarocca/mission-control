"use client"

import { useState } from "react"
import { Search, Bed, Bath, Square, TrendingUp, ExternalLink } from "lucide-react"

const mockResults = [
  {
    id: "r1", address: "5610 Balcones Dr", city: "Austin, TX 78731", price: 755000,
    beds: 5, baths: 4, sqft: 3400, dom: 5, score: 9.1, status: "offer",
    pricePerSqft: 222, notes: "Best deal this month. Offer in review."
  },
  {
    id: "r2", address: "1842 Maple Grove Ct", city: "Austin, TX 78745", price: 485000,
    beds: 4, baths: 3, sqft: 2340, dom: 3, score: 8.4, status: "showing",
    pricePerSqft: 207, notes: "Pool, backs to greenbelt. Seller motivated."
  },
  {
    id: "r3", address: "3301 Stonewall Dr", city: "Austin, TX 78731", price: 620000,
    beds: 4, baths: 2, sqft: 2780, dom: 7, score: 7.8, status: "contacted",
    pricePerSqft: 223, notes: null
  },
  {
    id: "r4", address: "908 Ridgemont Ave", city: "Cedar Park, TX 78613", price: 399000,
    beds: 3, baths: 2, sqft: 1890, dom: 1, score: 7.2, status: "new",
    pricePerSqft: 211, notes: null
  },
  {
    id: "r5", address: "214 Westlake Hills Blvd", city: "Austin, TX 78746", price: 1100000,
    beds: 5, baths: 4, sqft: 4100, dom: 2, score: 7.5, status: "new",
    pricePerSqft: 268, notes: null
  },
]

const statusColors: Record<string, string> = {
  new: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  contacted: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  showing: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  offer: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  closed: "bg-green-500/20 text-green-400 border-green-500/30",
}

function ScoreBadge({ score }: { score: number }) {
  const color = score >= 9 ? "text-green-400" : score >= 8 ? "text-yellow-400" : "text-zinc-400"
  return <span className={`text-sm font-bold tabular-nums ${color}`}>{score.toFixed(1)}</span>
}

export function RedfinWidget() {
  const [query, setQuery] = useState("")
  const [minScore, setMinScore] = useState(0)

  const results = mockResults.filter(r => {
    const matchesSearch = !query || r.address.toLowerCase().includes(query.toLowerCase()) || r.city.toLowerCase().includes(query.toLowerCase())
    const matchesScore = r.score >= minScore
    return matchesSearch && matchesScore
  })

  return (
    <div className="space-y-4">
      {/* Search + filters */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 flex items-center gap-3">
        <Search className="w-4 h-4 text-zinc-500 shrink-0" />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search address or city..."
          className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-600 outline-none"
        />
        <div className="flex items-center gap-2 border-l border-zinc-700 pl-3">
          <span className="text-xs text-zinc-500">Min score</span>
          <select
            value={minScore}
            onChange={e => setMinScore(Number(e.target.value))}
            className="bg-zinc-800 text-xs text-zinc-300 rounded px-1.5 py-0.5 outline-none border border-zinc-700"
          >
            <option value={0}>Any</option>
            <option value={7}>7.0+</option>
            <option value={8}>8.0+</option>
            <option value={9}>9.0+</option>
          </select>
        </div>
      </div>

      {/* Results count */}
      <p className="text-xs text-zinc-600">{results.length} listings</p>

      {/* Listing cards */}
      <div className="space-y-3">
        {results.map(listing => (
          <div key={listing.id} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 hover:border-zinc-700 transition-colors">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div>
                <p className="text-sm font-semibold text-zinc-100">{listing.address}</p>
                <p className="text-xs text-zinc-500">{listing.city}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <ScoreBadge score={listing.score} />
                <span className={`text-xs px-1.5 py-0.5 rounded border ${statusColors[listing.status] || statusColors.new}`}>
                  {listing.status}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-4 mb-2">
              <span className="text-base font-bold text-zinc-100">
                ${(listing.price / 1000).toFixed(0)}k
              </span>
              <span className="text-xs text-zinc-600">${listing.pricePerSqft}/sqft</span>
              <span className="text-xs text-zinc-600">{listing.dom}d on market</span>
            </div>

            <div className="flex items-center gap-4 text-xs text-zinc-500">
              <span className="flex items-center gap-1"><Bed className="w-3 h-3" />{listing.beds} bd</span>
              <span className="flex items-center gap-1"><Bath className="w-3 h-3" />{listing.baths} ba</span>
              <span className="flex items-center gap-1"><Square className="w-3 h-3" />{listing.sqft.toLocaleString()} sqft</span>
              <a href="https://redfin.com" target="_blank" rel="noopener noreferrer" className="ml-auto flex items-center gap-1 text-zinc-600 hover:text-zinc-300 transition-colors">
                <ExternalLink className="w-3 h-3" />
                Redfin
              </a>
            </div>

            {listing.notes && (
              <p className="text-xs text-amber-400/80 mt-2 border-t border-zinc-800 pt-2">{listing.notes}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
