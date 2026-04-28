import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Outbound message endpoint for the Leads tab. Sends via the CRMS sidecar
// (iMessage with SMS fallback — same path the Relationships tab uses) and
// logs the outbound message to the leads table with is_outbound=true so it
// shows up in the lead's event timeline.
//
// Why a separate route instead of calling /api/crms/send + PATCH /api/leads
// from the client: keeping the send + log atomic on the server avoids a
// half-state where the message went out but the row never got logged.

const SIDECAR_URL = process.env.SIDECAR_URL || "http://localhost:5799"
const SIDECAR_TIMEOUT = 35000

export async function POST(request: NextRequest) {
  let body: { phone?: string; message?: string; source?: string | null } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const { phone, message } = body
  const source = body.source ?? null

  if (!phone || typeof phone !== "string") {
    return NextResponse.json({ error: "phone is required" }, { status: 400 })
  }
  if (!message || typeof message !== "string" || !message.trim()) {
    return NextResponse.json({ error: "message is required" }, { status: 400 })
  }

  // Send via sidecar
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SIDECAR_TIMEOUT)
  let sendData: { success?: boolean; service?: string; error?: string } = {}
  let sendOk = false
  try {
    const res = await fetch(`${SIDECAR_URL}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, message }),
      signal: controller.signal,
    })
    clearTimeout(timeout)
    sendData = await res.json().catch(() => ({}))
    sendOk = res.ok && sendData.success !== false
  } catch (e) {
    clearTimeout(timeout)
    const isAbort = e instanceof Error && e.name === "AbortError"
    return NextResponse.json(
      { success: false, error: isAbort ? "timeout" : "sidecar unavailable" },
      { status: 503 }
    )
  }

  if (!sendOk) {
    return NextResponse.json(
      { success: false, error: sendData.error || "send failed" },
      { status: 502 }
    )
  }

  // Send succeeded — log the outbound row. This is best-effort; if Supabase
  // fails the message still went out, so we still return success but flag
  // the logging failure.
  let loggedId: string | null = null
  let logError: string | null = null
  try {
    const sb = getLeadsClient()
    // twilio_number=null is the outbound marker — see lib/leads.ts conventions.
    // No separate is_outbound column needed.
    const { data, error } = await sb
      .from("leads")
      .insert({
        source,
        twilio_number: null,
        caller_phone: phone,
        lead_type: "sms",
        message,
        status: "contacted",
      })
      .select("id")
      .single()
    if (error) {
      logError = error.message
      console.error("[leads/send] Insert failed:", error)
    } else {
      loggedId = data?.id ?? null
    }
  } catch (e) {
    logError = e instanceof Error ? e.message : String(e)
    console.error("[leads/send] Insert threw:", logError)
  }

  return NextResponse.json({
    success: true,
    service: sendData.service ?? null,
    leadId: loggedId,
    logError,
  })
}
