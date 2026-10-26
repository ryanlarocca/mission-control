import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { fetchContactThread } from "@/lib/relationship-messages"

export const dynamic = "force-dynamic"
export const revalidate = 0

// GET /api/crms/messages?phone=… → the last PANEL_LIMIT messages of the
// contact's live 1:1 text thread (oldest first) + the thread's total count.
// Ryan: "I only really need the last 15 messages or so." Empty list when
// the sidecar is unreachable; the UI tells "no history" from "sidecar
// down" via `ok`. Business-line texts (Card # / office / agents line, from
// relationship_touches) are merged in and still return when the sidecar
// isn't configured — `ok` keeps meaning "sidecar reachable".
const PANEL_LIMIT = 15
export async function GET(request: Request) {
  const url = new URL(request.url)
  const phone = url.searchParams.get("phone") || ""
  if (!phone) return NextResponse.json({ error: "phone required" }, { status: 400 })
  const thread = await fetchContactThread(getLeadsClient(), phone)
  if (!process.env.SIDECAR_URL) return NextResponse.json({ ok: false, total: thread.length, messages: thread.slice(-PANEL_LIMIT) })
  return NextResponse.json({ ok: true, total: thread.length, messages: thread.slice(-PANEL_LIMIT) })
}
