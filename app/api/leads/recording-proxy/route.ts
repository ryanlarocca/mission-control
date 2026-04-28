import { NextRequest, NextResponse } from "next/server"

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
    const upstream = await fetch(target, {
      headers: { Authorization: `Basic ${auth}` },
      // Forward range requests so the browser can seek
      ...(request.headers.get("range") ? { headers: { Authorization: `Basic ${auth}`, Range: request.headers.get("range")! } } : {}),
    })

    if (!upstream.ok && upstream.status !== 206) {
      const text = await upstream.text().catch(() => "")
      console.error(`[recording-proxy] Upstream ${upstream.status}: ${text.slice(0, 200)}`)
      return NextResponse.json(
        { error: `Upstream ${upstream.status}` },
        { status: upstream.status === 404 ? 404 : 502 }
      )
    }

    const headers = new Headers()
    headers.set("Content-Type", upstream.headers.get("Content-Type") || "audio/mpeg")
    const len = upstream.headers.get("Content-Length")
    if (len) headers.set("Content-Length", len)
    const range = upstream.headers.get("Content-Range")
    if (range) headers.set("Content-Range", range)
    headers.set("Accept-Ranges", upstream.headers.get("Accept-Ranges") || "bytes")
    headers.set("Cache-Control", "private, max-age=3600")

    return new NextResponse(upstream.body, { status: upstream.status, headers })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[recording-proxy] Fetch threw:", msg)
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
