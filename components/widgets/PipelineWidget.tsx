"use client"

import { usePipeline } from "@/hooks/usePipeline"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { RefreshCw, Home, Users } from "lucide-react"
import type { Listing, OutreachContact } from "@/types"

const statusColors: Record<string, string> = {
  new: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  contacted: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  showing: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  offer: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  closed: "bg-green-500/20 text-green-400 border-green-500/30",
  dead: "bg-zinc-500/20 text-zinc-500 border-zinc-500/30",
  pending: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
  sent: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  replied: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  meeting: "bg-green-500/20 text-green-400 border-green-500/30",
}

function ScoreBadge({ score }: { score: number }) {
  const color = score >= 9 ? "text-green-400" : score >= 8 ? "text-yellow-400" : "text-zinc-400"
  return <span className={`text-xs font-bold tabular-nums ${color}`}>{score.toFixed(1)}</span>
}

function ListingRow({ listing }: { listing: Listing }) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-zinc-800 last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-zinc-100 truncate">{listing.address}</p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-zinc-500">${(listing.price / 1000).toFixed(0)}k</span>
          {listing.beds && <span className="text-xs text-zinc-600">{listing.beds}bd/{listing.baths}ba</span>}
          {listing.daysOnMarket !== undefined && (
            <span className="text-xs text-zinc-600">{listing.daysOnMarket}d</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <ScoreBadge score={listing.score} />
        <span className={`text-xs px-1.5 py-0.5 rounded border ${statusColors[listing.status] || statusColors.new}`}>
          {listing.status}
        </span>
      </div>
    </div>
  )
}

function ContactRow({ contact }: { contact: OutreachContact }) {
  return (
    <div className="flex items-center gap-3 py-2 border-b border-zinc-800 last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-zinc-200">{contact.name}</p>
        <p className="text-xs text-zinc-500">{contact.type}</p>
      </div>
      <span className={`text-xs px-1.5 py-0.5 rounded border ${statusColors[contact.status] || statusColors.pending}`}>
        {contact.status}
      </span>
    </div>
  )
}

export function PipelineWidget() {
  const { listings, contacts, lastUpdated, loading, error, refresh } = usePipeline()

  return (
    <Card className="bg-zinc-900 border-zinc-800 h-full flex flex-col">
      <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
          <Home className="w-4 h-4 text-zinc-400" />
          Real Estate Pipeline
        </CardTitle>
        <div className="flex items-center gap-2">
          {lastUpdated && (
            <span className="text-xs text-zinc-600">
              {lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
          <button onClick={refresh} className="text-zinc-600 hover:text-zinc-400 transition-colors">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden flex flex-col gap-4 pt-0">
        {error && <p className="text-xs text-red-400">Error: {error}</p>}

        <div className="flex-1 overflow-hidden">
          <div className="flex items-center gap-1.5 mb-2">
            <Home className="w-3 h-3 text-zinc-500" />
            <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
              Listings ({listings.length})
            </span>
          </div>
          <ScrollArea className="h-auto max-h-[500px]">
            {listings.length === 0 && !loading ? (
              <p className="text-xs text-zinc-600">No listings</p>
            ) : (
              listings.map(l => <ListingRow key={l.id} listing={l} />)
            )}
          </ScrollArea>
        </div>

        <div className="flex-1 overflow-hidden">
          <div className="flex items-center gap-1.5 mb-2">
            <Users className="w-3 h-3 text-zinc-500" />
            <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
              Outreach ({contacts.length})
            </span>
          </div>
          <ScrollArea className="h-auto max-h-[400px]">
            {contacts.map(c => <ContactRow key={c.id} contact={c} />)}
          </ScrollArea>
        </div>
      </CardContent>
    </Card>
  )
}
