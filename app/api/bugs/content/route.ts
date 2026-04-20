import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

const SIDECAR_URL = process.env.SIDECAR_URL || "http://localhost:5799"

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const filePath = searchParams.get("path")

  if (!filePath) {
    return NextResponse.json({ error: "No path provided" }, { status: 400 })
  }

  try {
    const qs = new URLSearchParams({ path: filePath })
    const res = await fetch(`${SIDECAR_URL}/bugs/content?${qs}`, {
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    })
    return NextResponse.json(await res.json(), { status: res.status })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 503 })
  }
}
