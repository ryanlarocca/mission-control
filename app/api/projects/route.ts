import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Projects page data (Mission Control 2.0, Part D, 2026-11-10): every row of
// project_memos (written by scripts/projects-sync.mjs on the Mac mini from the
// project memos), most recently touched first. Read-only. Session-gated by
// middleware. `?view=summary` leaves out the heavy fields (left_off, ships)
// for the Today card. Answers 503 with a plain message — never a crash —
// while the table isn't there yet or Supabase is down.
export const dynamic = "force-dynamic"
export const revalidate = 0

const SUMMARY = "slug, name, status, status_line, plain, owns, updated_on, archived, synced_at"
const FULL = `${SUMMARY}, left_off, ships`

export async function GET(req: Request) {
  const summary = new URL(req.url).searchParams.get("view") === "summary"
  try {
    const { data, error } = await getLeadsClient()
      .from("project_memos")
      .select(summary ? SUMMARY : FULL)
      .order("updated_on", { ascending: false, nullsFirst: false })
      .limit(500)
    if (error) {
      const missing = error.code === "42P01" || error.code === "PGRST205" || /does not exist|could not find the table/i.test(error.message)
      console.error("[projects] list failed:", error.message)
      return NextResponse.json(
        { error: missing ? "The projects list isn't set up yet." : "Couldn't load projects right now." },
        { status: 503 },
      )
    }
    return NextResponse.json({ projects: data ?? [] })
  } catch (e) {
    console.error("[projects] list threw:", e)
    return NextResponse.json({ error: "Couldn't load projects right now." }, { status: 503 })
  }
}
