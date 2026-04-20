import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const revalidate = 0

const SIDECAR_URL = process.env.SIDECAR_URL || "http://localhost:5799"

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const project = searchParams.get("project")
  const file = searchParams.get("file")

  if (!project || !file) {
    return NextResponse.json({ error: "Missing project or file param" }, { status: 400 })
  }

  try {
    const qs = new URLSearchParams({ project, file })
    const res = await fetch(`${SIDECAR_URL}/projects/content?${qs}`, {
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 503 })
  }
}
