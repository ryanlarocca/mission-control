import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Logs an outreach touch. Inserts one row into `relationship_touches`
// (replaces the BoB "Log" tab) and, on a "sent", advances the contact's
// cadence clock; on a "skipped", snoozes the contact 24h.
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const {
      id, modality, message, action, tier, category, generatedMessage, wasEdited,
    } = await request.json()

    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "id required" }, { status: 400 })
    }

    const supabase = getLeadsClient()
    let logAppended = true
    let lastContactedWritten: boolean | null = null
    let snoozeWritten: boolean | null = null

    // Append-only touch row. generated_message (original AI draft) + was_edited
    // feed the generate route's voice few-shot and future voice-learning.
    const ins = await supabase.from("relationship_touches").insert({
      relationship_id: id,
      modality: modality ?? null,
      action: action ?? null,
      message: typeof message === "string" ? message : null,
      generated_message: typeof generatedMessage === "string" ? generatedMessage : null,
      was_edited: wasEdited === true ? true : wasEdited === false ? false : null,
      tier_at_touch: tier ?? null,
      category_at_touch: category ?? null,
    })
    if (ins.error) {
      console.error("Failed to insert relationship_touch:", ins.error)
      logAppended = false
    }

    if (action === "sent") {
      // last_contacted_at drives cadence — CRITICAL.
      const upd = await supabase
        .from("relationships")
        .update({ last_contacted_at: new Date().toISOString() })
        .eq("id", id)
      lastContactedWritten = !upd.error
      if (upd.error) console.error("Failed to update last_contacted_at:", upd.error)
    }

    if (action === "skipped") {
      // Snooze the contact 24h so it drops out of today's queue.
      const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      const upd = await supabase.from("relationships").update({ snooze_until: until }).eq("id", id)
      snoozeWritten = !upd.error
      if (upd.error) console.error("Failed to write snooze:", upd.error)
    }

    // A "sent" that failed to record last_contacted_at would keep the contact
    // re-appearing in the queue — surface it as a 500 so the UI can react.
    if (action === "sent" && lastContactedWritten === false) {
      return NextResponse.json(
        { ok: false, logAppended, lastContactedWritten, error: "Failed to write last_contacted_at" },
        { status: 500 }
      )
    }

    return NextResponse.json({ ok: true, logAppended, lastContactedWritten, snoozeWritten })
  } catch (err) {
    console.error("crms/log error:", err)
    return NextResponse.json({ error: "Failed to log action" }, { status: 500 })
  }
}
