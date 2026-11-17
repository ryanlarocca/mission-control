import { NextRequest, NextResponse } from "next/server"
import { serveAudio } from "@/lib/serve-audio"

// Proxies a Twilio voicemail recording so the browser can play it without
// exposing Basic-Auth credentials. Only Twilio recording URLs are allowed.
// This route is auth-gated by middleware.ts (NOT in PUBLIC_PATHS).

const TWILIO_PREFIX = "https://api.twilio.com/"

export async function GET(request: NextRequest) {
  const target = request.nextUrl.searchParams.get("url")
  if (!target) {
    return NextResponse.json({ error: "url required" }, { status: 400 })
  }
  if (!target.startsWith(TWILIO_PREFIX)) {
    return NextResponse.json({ error: "Only Twilio recording URLs are allowed" }, { status: 400 })
  }

  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !token) {
    return NextResponse.json({ error: "Twilio credentials not configured" }, { status: 500 })
  }

  const auth = Buffer.from(`${sid}:${token}`).toString("base64")

  try {
    // Fetch the whole file — Twilio ignores Range — and serve ranges ourselves.
    const upstream = await fetch(target, {
      headers: { Authorization: `Basic ${auth}` },
      // Defensive: skip Next.js fetch cache.
      cache: "no-store",
    })

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "")
      console.error(`[recording-proxy] Upstream ${upstream.status}: ${text.slice(0, 200)}`)
      return NextResponse.json(
        { error: `Upstream ${upstream.status}` },
        { status: upstream.status === 404 ? 404 : 502 }
      )
    }

    const bytes = new Uint8Array(await upstream.arrayBuffer())
    return serveAudio(bytes, request.headers.get("range"))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[recording-proxy] Fetch threw:", msg)
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
