import { NextResponse } from "next/server"

// Proxies to the CRMS FDA sidecar on localhost:5799
// Sidecar handles iMessage → SMS fallback via AppleScript + chat.db error detection.

const SIDECAR_URL = "http://localhost:5799"
const SIDECAR_TIMEOUT = 35000 // 35s — iMessage send + 5s error check + SMS fallback

export async function POST(request: Request) {
  try {
    const { phone, message } = await request.json()
    if (!phone || !message) {
      return NextResponse.json({ error: "phone and message required" }, { status: 400 })
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), SIDECAR_TIMEOUT)

    try {
      const res = await fetch(`${SIDECAR_URL}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, message }),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      const data = await res.json()
      return NextResponse.json(data, { status: res.ok ? 200 : 500 })
    } catch (fetchErr: unknown) {
      clearTimeout(timeout)
      const isAbort = fetchErr instanceof Error && fetchErr.name === "AbortError"
      return NextResponse.json({
        success: false,
        error: isAbort ? "timeout" : "sidecar unavailable",
      }, { status: 503 })
    }
  } catch (err) {
    console.error("crms/send error:", err)
    return NextResponse.json({ success: false, error: "internal error" }, { status: 500 })
  }
}
