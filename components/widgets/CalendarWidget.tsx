"use client"

import { useCalendar } from "@/hooks/useCalendar"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { RefreshCw, Calendar, MapPin } from "lucide-react"
import type { CalendarEvent } from "@/types"

const typeColors: Record<string, string> = {
  showing: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  meeting: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  call: "bg-green-500/20 text-green-400 border-green-500/30",
  personal: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
  other: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
}

const typeDot: Record<string, string> = {
  showing: "bg-purple-400",
  meeting: "bg-blue-400",
  call: "bg-green-400",
  personal: "bg-zinc-400",
  other: "bg-zinc-400",
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

function formatDate(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)

  if (d.toDateString() === today.toDateString()) return "Today"
  if (d.toDateString() === tomorrow.toDateString()) return "Tomorrow"
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })
}

function EventRow({ event }: { event: CalendarEvent }) {
  return (
    <div className="flex gap-3 py-2.5 border-b border-zinc-800 last:border-0">
      <div className="flex flex-col items-center pt-1">
        <div className={`w-2 h-2 rounded-full ${typeDot[event.type] || typeDot.other}`} />
        <div className="w-px flex-1 bg-zinc-800 mt-1" />
      </div>
      <div className="flex-1 min-w-0 pb-1">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm text-zinc-100 leading-tight">{event.title}</p>
          <span className={`text-xs px-1.5 py-0.5 rounded border shrink-0 ${typeColors[event.type]}`}>
            {event.type}
          </span>
        </div>
        <p className="text-xs text-zinc-500 mt-0.5">
          {formatDate(event.startTime)} · {formatTime(event.startTime)} – {formatTime(event.endTime)}
        </p>
        {event.location && (
          <p className="text-xs text-zinc-600 mt-0.5 flex items-center gap-1 truncate">
            <MapPin className="w-3 h-3 shrink-0" />
            {event.location}
          </p>
        )}
      </div>
    </div>
  )
}

export function CalendarWidget() {
  const { events, lastUpdated, loading, error, refresh } = useCalendar()

  const todayEvents = events.filter(e => {
    const d = new Date(e.startTime)
    const today = new Date()
    return d.toDateString() === today.toDateString()
  })

  const upcomingEvents = events.filter(e => {
    const d = new Date(e.startTime)
    const today = new Date()
    return d.toDateString() !== today.toDateString()
  }).slice(0, 5)

  return (
    <Card className="bg-zinc-900 border-zinc-800 h-full flex flex-col">
      <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
          <Calendar className="w-4 h-4 text-zinc-400" />
          Calendar & Events
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

        {todayEvents.length > 0 && (
          <div>
            <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">Today</p>
            {todayEvents.map(e => <EventRow key={e.id} event={e} />)}
          </div>
        )}

        {todayEvents.length === 0 && !loading && (
          <div className="py-4 text-center">
            <p className="text-sm text-zinc-500">Nothing scheduled today</p>
          </div>
        )}

        {upcomingEvents.length > 0 && (
          <div>
            <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">Upcoming</p>
            {upcomingEvents.map(e => <EventRow key={e.id} event={e} />)}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
