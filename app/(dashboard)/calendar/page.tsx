import { CalendarWidget } from "@/components/widgets/CalendarWidget"

export default function CalendarPage() {
  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-zinc-100">Calendar & Events</h1>
        <p className="text-sm text-zinc-500 mt-0.5">Today&apos;s showings and upcoming events</p>
      </div>
      <CalendarWidget />
    </div>
  )
}
