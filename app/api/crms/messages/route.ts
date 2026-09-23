import { NextResponse } from "next/server"
import { fetchThread } from "@/lib/relationship-messages"

export const dynamic = "force-dynamic"
export const revalidate = 0

// GET /api/crms/messages?phone=… → the last PANEL_LIMIT messages of the
// contact's live 1:1 text thread (oldest first) + the thread's total count.
// Ryan: "I only really need the last 15 messages or so." Empty list when
// the sidecar is unreachable; the UI tells "no history" from "sidecar
// down" via `ok`.
const PANEL_LIMIT = 15
export async function GET(request: Request) {
  const url = new URL(request.url)
  const phone = url.searchParams.get("phone") || ""
  if (!phone) return NextResponse.json({ error: "phone required" }, { status: 400 })
  if (!process.env.SIDECAR_URL) return NextResponse.json({ ok: false, messages: [] })
  const thread = await fetchThread(phone)
  return NextResponse.json({ ok: true, total: thread.length, messages: thread.slice(-PANEL_LIMIT) })
}
