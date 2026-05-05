import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient, getMailboxForSource } from "@/lib/leads"

// Lead-pipeline auxiliary: when a lead card is expanded, pull the full
// Gmail thread (the inbound lead email + every reply on either side) from
// the mailbox owner's inbox via the CRMS sidecar's `gog` Gmail OAuth.
// Auth-gated by default through middleware. Best-effort: any failure
// returns an empty messages array so the card still renders.
//
// The client passes `{ leadId }` rather than a raw threadId so the proxy
// can: (a) verify the lead exists, (b) read its `gmail_thread_id` and
// `source`, and (c) derive the mailbox from the source via
// EMAIL_CAMPAIGN_MAP without trusting client-supplied identity.

interface SyncEmailBody {
  leadId?: string
}

export async function POST(request: NextRequest) {
  let body: SyncEmailBody
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const leadId = (body?.leadId || "").trim()
  if (!leadId) {
    return NextResponse.json({ error: "leadId is required" }, { status: 400 })
  }

  let lead: { gmail_thread_id: string | null; source: string | null } | null
  try {
    const sb = getLeadsClient()
    const { data, error } = await sb
      .from("leads")
      .select("gmail_thread_id, source")
      .eq("id", leadId)
      .maybeSingle()
    if (error) {
      console.error("[sync-email] Lead lookup failed:", error)
      return NextResponse.json({ messages: [] })
    }
    lead = data as { gmail_thread_id: string | null; source: string | null } | null
  } catch (e) {
    console.error("[sync-email] Lead lookup threw:", e)
    return NextResponse.json({ messages: [] })
  }

  if (!lead || !lead.gmail_thread_id) {
    return NextResponse.json({ messages: [] })
  }
  const mailbox = getMailboxForSource(lead.source)
  if (!mailbox) {
    console.warn(`[sync-email] No mailbox for source: ${lead.source}`)
    return NextResponse.json({ messages: [] })
  }

  const sidecarUrl = process.env.SIDECAR_URL?.replace(/\/+$/, "")
  if (!sidecarUrl) {
    console.error("[sync-email] SIDECAR_URL not set")
    return NextResponse.json({ messages: [] })
  }
  try {
    const res = await fetch(`${sidecarUrl}/sync-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: lead.gmail_thread_id, mailbox }),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      console.warn(`[sync-email] Sidecar returned ${res.status}`)
      return NextResponse.json({ messages: [] })
    }
    const data = await res.json()
    return NextResponse.json({ messages: data.messages || [] })
  } catch (e) {
    console.error("[sync-email] Sidecar call failed:", e)
    return NextResponse.json({ messages: [] })
  }
}
