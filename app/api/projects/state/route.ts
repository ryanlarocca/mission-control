import { NextResponse } from "next/server"
import { sidecarHeaders } from "@/lib/sidecar"

export const dynamic = "force-dynamic"

const SIDECAR_URL = process.env.SIDECAR_URL || "http://localhost:5799"

export async function POST(request: Request) {
  const body = await request.text()
  try {
    const res = await fetch(`${SIDECAR_URL}/projects/state`, {
      method: "POST",
      headers: sidecarHeaders(),
      body,
      signal: AbortSignal.timeout(10000),
    })
    return NextResponse.json(await res.json(), { status: res.status })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 503 })
  }
}
