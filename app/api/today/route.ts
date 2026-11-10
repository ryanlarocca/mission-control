import { NextResponse } from "next/server"
import { buildToday } from "@/lib/todayData"

// Today page data (Mission Control 2.0 shell, 2026-11-10): health pills,
// appointments, Jackie overnight, AI spend. Follow-ups and Relationships
// touches come from their own existing routes. Session-gated by middleware.
// Each section fails on its own (see lib/todayData.ts), so this answers 200
// with nulls + `errors` rather than failing the whole page.
export const dynamic = "force-dynamic"
export const revalidate = 0

export async function GET() {
  try {
    return NextResponse.json(await buildToday())
  } catch (e) {
    console.error("[today] failed:", e)
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
