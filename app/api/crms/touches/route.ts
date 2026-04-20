import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const revalidate = 0

const SIDECAR_URL = process.env.SIDECAR_URL || "http://localhost:5799"

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const phone = url.searchParams.get("phone") || ""
    const full = url.searchParams.get("full") === "1" ? "1" : "0"
    if (!phone) return NextResponse.json({ error: "phone required" }, { status: 400 })

    const res = await fetch(`${SIDECAR_URL}/touches?phone=${encodeURIComponent(phone)}&full=${full}`, {
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    })
    if (!res.ok) {
      return NextResponse.json({ error: "sidecar unavailable", count: 0, lastSentAt: null, lastMessagePreview: null, history: [] }, { status: 503 })
    }
    return NextResponse.json(await res.json())
  } catch (err) {
    return NextResponse.json({ error: String(err), count: 0, lastSentAt: null, lastMessagePreview: null, history: [] }, { status: 503 })
  }
}
