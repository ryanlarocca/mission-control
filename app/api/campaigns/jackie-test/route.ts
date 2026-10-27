import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { buildJackieScoreboard } from "@/lib/jackieScoreboard"

// Jackie coin-flip scoreboard for Campaign Performance (lib/jackieScoreboard.ts).
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    return NextResponse.json(await buildJackieScoreboard(getLeadsClient()))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
