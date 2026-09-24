import { NextRequest, NextResponse } from "next/server"
import { sendThreadedEmailReply } from "@/lib/emailReply"

// Send an email reply to an inbound lead from the mailbox that received it.
// Auth: gated by middleware via the mc_session cookie (do NOT add this path
// to PUBLIC_PATHS). The send itself lives in lib/emailReply.ts (2026-09-24)
// so the Telegram planner draft can use the identical path.

interface EmailReplyBody {
  leadId?: string
  message?: string
  // Reply Planner: the reply_drafts row this text came from (null when Ryan
  // typed from scratch). Stamped as sent so draft-vs-sent is recorded.
  draftId?: string
}

export async function POST(request: NextRequest) {
  let body: EmailReplyBody
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const out = await sendThreadedEmailReply({ leadId: body?.leadId || "", text: body?.message || "", draftId: body?.draftId || null })
  if (!out.ok) return NextResponse.json({ error: out.error, ...(out.details ? { details: out.details } : {}) }, { status: out.status })
  return NextResponse.json({ ok: true, sentMessageId: out.sentMessageId, leadId: out.leadId, ...(out.logError ? { logError: out.logError } : {}) })
}
