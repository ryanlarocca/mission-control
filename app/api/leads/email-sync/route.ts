import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { isQuietRequest, MAX_SYNC_MESSAGES, syncLeadEmails } from "@/lib/leadEmailSync"

// The Mac-mini inbox agent (scripts/inbox-agent/leadmail.mjs) posts ryan@
// email with leads here — mail Ryan sent to a lead and a lead's replies — and
// it lands on the lead card (2026-11-17, briefs/BRIEF_LEAD_EMAIL_SYNC_2026-11-17.md).
// Public path, gated by the same shared-secret header as /api/crms/email-sync.
// Body: { quiet?, messages: [{ gmailId, threadId, direction: "inbound" | "sent", at, from, to, subject, text, kind? }] } (≤ 10)
// An inbound message newly logged posts one Telegram alert, never on `quiet` (a hand catch-up).
// Returns { results: [{ gmailId, leads: [{ leadId, card, name, status, reason? }], alerted, done }] }.
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function POST(request: NextRequest) {
  const secret = process.env.REPLY_INTERNAL_SECRET || process.env.MC_PASSWORD || ""
  if (!secret || request.headers.get("x-reply-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }
  let body: { messages?: unknown; quiet?: unknown }
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  if (!Array.isArray(body?.messages)) return NextResponse.json({ error: "messages[] required" }, { status: 400 })
  if (body.messages.length > MAX_SYNC_MESSAGES) {
    return NextResponse.json({ error: `at most ${MAX_SYNC_MESSAGES} messages per request` }, { status: 400 })
  }

  try {
    const results = await syncLeadEmails(getLeadsClient(), body.messages, { quiet: isQuietRequest(body.quiet) })
    return NextResponse.json({ results })
  } catch (e) {
    // Only the lead rows failing to load lands here — every message stays queued on the mini.
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
