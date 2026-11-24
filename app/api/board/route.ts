import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { BOARD_COLS, BOARD_DONE_DAYS, BOARD_LOG_COLS, isBoardLane } from "@/lib/boardItems"

// The Board (2026-11-20): one card per open thread, four lanes. Table
// board_items (supabase/migrations/2026-11-20_board_items.sql). Chats write to
// the same table through scripts/board.mjs. Session-gated by middleware.
//   GET    open cards + cards done in the last BOARD_DONE_DAYS days
//   GET    ?history=<id>  that card's dated log (board_item_log, newest first)
//   POST   { title, next_step?, lane?, waiting_on?, due_date?, due_note?, tag?, link? }
//   PATCH  { id, status?, lane?, title?, next_step?, waiting_on?, due_date?, due_note?, tag?, link?, on_hold? }
// Every write from the page is stamped updated_by "Ryan"; the DB trigger logs it.
// (This path used to serve the retired 90-day goals board; its /events and
// /periods sub-routes are left in place for the old tables.)
export const dynamic = "force-dynamic"
export const revalidate = 0

function clean(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t ? t.slice(0, max) : null
}

function cleanDate(v: unknown): string | null | undefined {
  if (v === null || v === "") return null
  if (typeof v !== "string") return undefined
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined
}

export async function GET(req: Request) {
  try {
    const sb = getLeadsClient()
    const historyId = new URL(req.url).searchParams.get("history")
    if (historyId) {
      if (!/^[0-9a-f-]{36}$/i.test(historyId)) return NextResponse.json({ error: "bad id" }, { status: 400 })
      const { data, error } = await sb.from("board_item_log").select(BOARD_LOG_COLS).eq("item_id", historyId).order("at", { ascending: false }).limit(100)
      if (error) {
        console.error("[board] history failed:", error.message)
        return NextResponse.json({ error: "Couldn't load the history." }, { status: 503 })
      }
      return NextResponse.json({ entries: data ?? [] })
    }
    const since = new Date(Date.now() - BOARD_DONE_DAYS * 86_400_000).toISOString()
    const [open, done] = await Promise.all([
      sb.from("board_items").select(BOARD_COLS).eq("status", "open").limit(1000),
      sb.from("board_items").select(BOARD_COLS).eq("status", "done").gte("done_at", since).order("done_at", { ascending: false }).limit(200),
    ])
    const err = open.error ?? done.error
    if (err) {
      console.error("[board] list failed:", err.message)
      return NextResponse.json({ error: "Couldn't load the Board." }, { status: 503 })
    }
    return NextResponse.json({ items: [...(open.data ?? []), ...(done.data ?? [])] })
  } catch (e) {
    console.error("[board] list threw:", e)
    return NextResponse.json({ error: "Couldn't load the Board." }, { status: 503 })
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const title = clean(body.title, 200)
    if (!title) return NextResponse.json({ error: "Give it a title." }, { status: 400 })
    const due = cleanDate(body.due_date)
    const row = {
      title,
      next_step: clean(body.next_step, 500),
      lane: isBoardLane(body.lane) ? body.lane : "you",
      waiting_on: clean(body.waiting_on, 120),
      due_date: due ?? null,
      due_note: clean(body.due_note, 40),
      tag: clean(body.tag, 24),
      link: clean(body.link, 1000),
      source: "board page",
      updated_by: "Ryan",
    }
    const { data, error } = await getLeadsClient().from("board_items").insert(row).select(BOARD_COLS).single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
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
      if (body.status !== "open" && body.status !== "done") return NextResponse.json({ error: "bad status" }, { status: 400 })
      patch.status = body.status
      patch.done_at = body.status === "done" ? new Date().toISOString() : null
    }
    if (body.lane !== undefined) {
      if (!isBoardLane(body.lane)) return NextResponse.json({ error: "bad lane" }, { status: 400 })
      patch.lane = body.lane
    }
    if (body.title !== undefined) {
      const title = clean(body.title, 200)
      if (!title) return NextResponse.json({ error: "Title can't be empty." }, { status: 400 })
      patch.title = title
    }
    if (body.due_date !== undefined) {
      const due = cleanDate(body.due_date)
      if (due === undefined) return NextResponse.json({ error: "Date must be YYYY-MM-DD." }, { status: 400 })
      patch.due_date = due
    }
    if (body.on_hold !== undefined) {
      if (typeof body.on_hold !== "boolean") return NextResponse.json({ error: "bad on_hold" }, { status: 400 })
      if (body.on_hold && patch.due_date === null) return NextResponse.json({ error: "On hold needs a date to come back." }, { status: 400 })
      patch.on_hold = body.on_hold
    }
    // No date → can't be on hold (it would never come back).
    if (patch.due_date === null) patch.on_hold = false
    const texts: [string, number][] = [["next_step", 500], ["waiting_on", 120], ["due_note", 40], ["tag", 24], ["link", 1000]]
    for (const [k, max] of texts) if (body[k] !== undefined) patch[k] = clean(body[k], max)
    if (!Object.keys(patch).length) return NextResponse.json({ error: "nothing to change" }, { status: 400 })
    patch.updated_at = new Date().toISOString()
    patch.updated_by = "Ryan"
    const { data, error } = await getLeadsClient().from("board_items").update(patch).eq("id", id).select(BOARD_COLS).maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data) return NextResponse.json({ error: "not found" }, { status: 404 })
    return NextResponse.json({ item: data })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
