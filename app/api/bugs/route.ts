import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const revalidate = 0

const SIDECAR_URL = process.env.SIDECAR_URL || "http://localhost:5799"

export async function GET() {
  try {
    const res = await fetch(`${SIDECAR_URL}/bugs`, {
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    })
    if (!res.ok) {
      return NextResponse.json({ error: "sidecar unavailable", sessions: [] }, { status: 503 })
    }
    return NextResponse.json(await res.json())
  } catch (err) {
    return NextResponse.json({ error: String(err), sessions: [] }, { status: 503 })
  }
}
