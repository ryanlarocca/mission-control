import { NextResponse } from "next/server"
import { fetchThread } from "@/lib/relationship-messages"

export const dynamic = "force-dynamic"
export const revalidate = 0

// GET /api/crms/messages?phone=… → the contact's live 1:1 text thread
// (oldest first). Empty list when the sidecar is unreachable; the UI
// distinguishes "no history" from "sidecar down" via `ok`.
export async function GET(request: Request) {
  const url = new URL(request.url)
  const phone = url.searchParams.get("phone") || ""
  if (!phone) return NextResponse.json({ error: "phone required" }, { status: 400 })
  if (!process.env.SIDECAR_URL) return NextResponse.json({ ok: false, messages: [] })
  const messages = await fetchThread(phone)
  return NextResponse.json({ ok: true, messages })
}
