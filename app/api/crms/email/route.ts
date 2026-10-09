import { NextResponse } from "next/server"
import { sendRelationshipEmail } from "@/lib/relationshipEmail"

// Email a Relationships contact from the card / detail modal. Threads into
// their latest campaign reply when there is one; otherwise a fresh email from
// ryan@. Logs the touch + advances the cadence clock server-side so the
// client has one call to make (unlike text, which is send + /api/crms/log).
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  let body: { id?: unknown; message?: unknown; subject?: unknown; draftId?: unknown; generatedMessage?: unknown; wasEdited?: unknown; newThread?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 })
  }
  if (typeof body.id !== "string" || !body.id.trim()) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 })
  if (typeof body.message !== "string" || !body.message.trim()) return NextResponse.json({ ok: false, error: "message required" }, { status: 400 })

  try {
    const result = await sendRelationshipEmail({
      relationshipId: body.id,
      body: body.message,
      subject: typeof body.subject === "string" ? body.subject : null,
      draftId: typeof body.draftId === "string" ? body.draftId : null,
      generatedMessage: typeof body.generatedMessage === "string" ? body.generatedMessage : null,
      wasEdited: typeof body.wasEdited === "boolean" ? body.wasEdited : null,
      newThread: body.newThread === true,
    })
    return NextResponse.json(result, { status: result.status })
  } catch (err) {
    console.error("crms/email error:", err)
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "internal error" }, { status: 500 })
  }
}
