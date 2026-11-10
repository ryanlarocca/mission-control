import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// The Hopper (2026-11-10): Ryan's list of tools and ideas not on day one.
// Table hopper_items (supabase/migrations/2026-11-10_hopper.sql).
// Session-gated by middleware. GET answers 503 with a plain message (never a
// crash) while the table isn't there yet.
export const dynamic = "force-dynamic"
export const revalidate = 0

const KINDS = new Set(["tool", "idea"])
const STATUSES = new Set(["open", "picked_up", "dropped"])
const COLS = "id, title, note, kind, status, created_at, updated_at"
const STATUS_ORDER: Record<string, number> = { open: 0, picked_up: 1, dropped: 2 }

function clean(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t ? t.slice(0, max) : null
}

export async function GET() {
  try {
    const { data, error } = await getLeadsClient()
      .from("hopper_items")
      .select(COLS)
      .order("created_at", { ascending: false })
      .limit(1000)
    if (error) {
      console.error("[hopper] list failed:", error.message)
      return NextResponse.json({ error: "Couldn't load the Hopper." }, { status: 503 })
    }
    const items = [...(data ?? [])].sort((a, b) => (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3))
    return NextResponse.json({ items })
  } catch (e) {
    console.error("[hopper] list threw:", e)
    return NextResponse.json({ error: "Couldn't load the Hopper." }, { status: 503 })
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const title = clean(body.title, 200)
    if (!title) return NextResponse.json({ error: "Give it a title." }, { status: 400 })
    const kind = typeof body.kind === "string" && KINDS.has(body.kind) ? body.kind : "idea"
    const { data, error } = await getLeadsClient()
      .from("hopper_items")
      .insert({ title, note: clean(body.note, 1000), kind })
      .select(COLS)
      .single()
    if (error) {
      const dup = error.code === "23505"
      return NextResponse.json({ error: dup ? "That one's already on the list." : error.message }, { status: dup ? 409 : 500 })
    }
    return NextResponse.json({ item: data })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

export async function PATCH(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const id = typeof body.id === "string" ? body.id : null
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })
    const patch: Record<string, unknown> = {}
    if (body.status !== undefined) {
      if (typeof body.status !== "string" || !STATUSES.has(body.status)) return NextResponse.json({ error: "bad status" }, { status: 400 })
      patch.status = body.status
    }
    if (body.title !== undefined) {
      const title = clean(body.title, 200)
      if (!title) return NextResponse.json({ error: "Title can't be empty." }, { status: 400 })
      patch.title = title
    }
    if (body.note !== undefined) patch.note = clean(body.note, 1000)
    if (body.kind !== undefined) {
      if (typeof body.kind !== "string" || !KINDS.has(body.kind)) return NextResponse.json({ error: "bad kind" }, { status: 400 })
      patch.kind = body.kind
    }
    if (!Object.keys(patch).length) return NextResponse.json({ error: "nothing to change" }, { status: 400 })
    patch.updated_at = new Date().toISOString()
    const { data, error } = await getLeadsClient().from("hopper_items").update(patch).eq("id", id).select(COLS).maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data) return NextResponse.json({ error: "not found" }, { status: 404 })
    return NextResponse.json({ item: data })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
