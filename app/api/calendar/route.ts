import { NextResponse } from "next/server"
import { mockCalendarEvents } from "@/lib/mockData"

export async function GET() {
  // Fully mocked for MVP — Google Calendar OAuth deferred
  return NextResponse.json({ events: mockCalendarEvents })
}
