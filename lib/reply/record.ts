// reply_drafts writes. Every generated draft gets a row; a send links to the
// row it came from. Failures are logged, never thrown — a missing record
// must not block a reply.

import { getLeadsClient } from "@/lib/leads"

export interface DraftRecord {
  surface: string
  lead_id?: string | null
  relationship_id?: string | null
  drip_queue_id?: string | null
  channel?: string | null
  moment?: string | null
  temperature?: string | null
  next_action?: string | null
  plan_json?: unknown
  draft_subject?: string | null
  draft_body: string
  model: string
  prompt_version: string
  playbook_version: string
  why_text?: string | null
  parent_draft_id?: string | null
  critic_json?: unknown
}

export async function recordDraft(rec: DraftRecord): Promise<string | null> {
  try {
    const sb = getLeadsClient()
    const { data, error } = await sb.from("reply_drafts").insert(rec).select("id").single()
    if (error) {
      console.error("[reply/record] insert failed:", error.message)
      return null
    }
    return data?.id ?? null
  } catch (e) {
    console.error("[reply/record] insert threw:", e instanceof Error ? e.message : String(e))
    return null
  }
}

/** Called by the send routes. Marks the draft as sent with what actually went out. */
export async function markDraftSent(draftId: string, sent: { subject?: string | null; body: string }): Promise<void> {
  if (!draftId) return
  try {
    const sb = getLeadsClient()
    const { data: d } = await sb.from("reply_drafts").select("draft_body, draft_subject").eq("id", draftId).maybeSingle()
    const norm = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim()
    const wasEdited = !d ? null : norm(d.draft_body) !== norm(sent.body) || (sent.subject != null && d.draft_subject != null && norm(d.draft_subject) !== norm(sent.subject))
    const { error } = await sb
      .from("reply_drafts")
      .update({ sent_body: sent.body, sent_subject: sent.subject ?? null, sent_at: new Date().toISOString(), was_edited: wasEdited })
      .eq("id", draftId)
    if (error) console.error("[reply/record] markSent failed:", error.message)
  } catch (e) {
    console.error("[reply/record] markSent threw:", e instanceof Error ? e.message : String(e))
  }
}
