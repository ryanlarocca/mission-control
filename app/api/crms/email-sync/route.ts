import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { MAX_SYNC_MESSAGES, syncRelationshipEmails } from "@/lib/relationshipEmailSync"

// The Mac-mini inbox agent (scripts/inbox-agent/cards.mjs) posts ryan@ email
// with Relationships contacts here — inbound, sent and bounces — and the
// cards learn about it silently (2026-11-11,
// briefs/BRIEF_RELATIONSHIP_EMAIL_SYNC_2026-11-11.md). Public path, gated by
// the same shared-secret header as /api/reply/drip-draft.
// Body: { messages: [{ gmailId, threadId, direction, at, from, to, subject, text, failedRecipient }] } (≤ 10)
// Returns { results: [{ gmailId, cards: [{ relationshipId, name, status, reason?, note }], done }] }.
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function POST(request: NextRequest) {
  const secret = process.env.REPLY_INTERNAL_SECRET || process.env.MC_PASSWORD || ""
  if (!secret || request.headers.get("x-reply-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }
  let body: { messages?: unknown }
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  if (!Array.isArray(body?.messages)) return NextResponse.json({ error: "messages[] required" }, { status: 400 })
  if (body.messages.length > MAX_SYNC_MESSAGES) {
    return NextResponse.json({ error: `at most ${MAX_SYNC_MESSAGES} messages per request` }, { status: 400 })
  }

  try {
    const results = await syncRelationshipEmails(getLeadsClient(), body.messages)
    return NextResponse.json({ results })
  } catch (e) {
    // Only the card list failing to load lands here — every message stays queued on the mini.
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
