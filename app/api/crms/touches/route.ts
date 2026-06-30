import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

export const dynamic = "force-dynamic"
export const revalidate = 0

const SIDECAR_URL = process.env.SIDECAR_URL || "http://localhost:5799"

async function checkHasReply(phone: string): Promise<boolean> {
  try {
    const supabase = getLeadsClient()
    const norm = phone.replace(/\D/g, "").slice(-10)

    // Find the relationship by phone (last 10 digits match)
    const { data: rels } = await supabase
      .from("relationships")
      .select("id, phone")
      .not("phone", "is", null)

    const rel = (rels ?? []).find((r: { id: string; phone: string }) => {
      const rNorm = String(r.phone ?? "").replace(/\D/g, "").slice(-10)
      return rNorm === norm
    })
    if (!rel) return false

    // Check if any touch for this relationship has a replied_at
    const { data: touches } = await supabase
      .from("relationship_touches")
      .select("id")
      .eq("relationship_id", rel.id)
      .not("replied_at", "is", null)
      .limit(1)

    return (touches ?? []).length > 0
  } catch {
    return false
  }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const phone = url.searchParams.get("phone") || ""
    const full = url.searchParams.get("full") === "1" ? "1" : "0"
    if (!phone) return NextResponse.json({ error: "phone required" }, { status: 400 })

    // Fetch sidecar touch summary and reply status in parallel
    const [sidecarRes, hasReply] = await Promise.all([
      fetch(`${SIDECAR_URL}/touches?phone=${encodeURIComponent(phone)}&full=${full}`, {
        signal: AbortSignal.timeout(10000),
        cache: "no-store",
      }),
      checkHasReply(phone),
    ])

    if (!sidecarRes.ok) {
      return NextResponse.json({ error: "sidecar unavailable", count: 0, lastSentAt: null, lastMessagePreview: null, hasReply: false, history: [] }, { status: 503 })
    }

    const data = await sidecarRes.json()
    return NextResponse.json({ ...data, hasReply })
  } catch (err) {
    return NextResponse.json({ error: String(err), count: 0, lastSentAt: null, lastMessagePreview: null, hasReply: false, history: [] }, { status: 503 })
  }
}
