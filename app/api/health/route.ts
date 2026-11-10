import { NextResponse } from "next/server"
import { buildHealth } from "@/lib/healthData"

// Health page data (Mission Control 2.0, Part E, 2026-11-10): the mini's
// check-in, its latest status snapshot (mini_status, written by
// scripts/mini-status.mjs), the judge, Jackie, and AI spend by key.
// Session-gated by middleware (NOT public). Each source fails on its own (see
// lib/healthData.ts), so this answers 200 with nulls + `errors`.
export const dynamic = "force-dynamic"
export const revalidate = 0

export async function GET() {
  try {
    return NextResponse.json(await buildHealth())
  } catch (e) {
    console.error("[health] failed:", e)
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
