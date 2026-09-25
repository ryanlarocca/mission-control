import { getLeadsClient } from "@/lib/leads"

// Inbox Agent — the Vercel half (briefs/BRIEF_INBOX_AGENT_2026-09-24.md).
//
// The Mac mini worker (scripts/inbox-agent/index.mjs) reads ryan@lrghomes.com,
// proposes where each attachment goes in Drive, screens deals, tracks open
// loops, and posts everything to the Marketing Telegram bot. Ryan's taps and
// reply-texts land on the bot webhook (app/api/campaign/telegram/route.ts),
// which runs on Vercel. This module is what that webhook calls: it records
// the decision in Supabase and answers Ryan. It never touches Gmail, Drive
// or the model — the worker picks the decision up on its next pass (≤5 min)
// and does the actual upload / redraft / regeneration.
//
// callback_data namespace: everything starts with "ix:" so it can't collide
// with the campaign / reply-planner prefixes in the webhook.
//   ix:fa:<uuid>   file approve      ix:fc:<uuid>  file change (reply expected)
//   ix:fs:<uuid>   file skip         ix:fm:<uuid>  make this rule manual again
//   ix:io:<uuid>   interview accept  ix:is:<uuid>  interview skip
//   ix:ro          rules approved    ix:rn         rules need changes (reply)
//   ix:ld:<uuid>   loop done         ix:lz:<uuid>  loop snooze 2 days
//   ix:sl:<uuid>   screen: look      ix:sp:<uuid>  screen: pass

export const INBOX_CB_PREFIX = "ix:"

export interface InboxCallbackResult {
  toast: string
  text?: string
  clearButtons?: boolean
}

type InboxRef =
  | { kind: "file"; id: string; status: string }
  | { kind: "interview"; id: string; status: string }
  | { kind: "rules" }
  | { kind: "loop"; id: string }
  | { kind: "screen"; id: string }

const UUID = "[0-9a-f-]{36}"

async function setSetting(key: string, value: Record<string, unknown>): Promise<void> {
  const sb = getLeadsClient()
  const { data } = await sb.from("inbox_settings").select("value").eq("key", key).maybeSingle()
  const merged = { ...((data?.value as Record<string, unknown>) || {}), ...value }
  await sb.from("inbox_settings").upsert({ key, value: merged, updated_at: new Date().toISOString() })
}

async function getSetting(key: string): Promise<Record<string, unknown>> {
  const sb = getLeadsClient()
  const { data } = await sb.from("inbox_settings").select("value").eq("key", key).maybeSingle()
  return (data?.value as Record<string, unknown>) || {}
}

/** Which inbox-agent message did Ryan reply to? Checked by the webhook before
 *  any branch that could text a lead, exactly like the Reply Planner lookup. */
export async function findInboxByTgMessage(tgMessageId: number): Promise<InboxRef | null> {
  const sb = getLeadsClient()
  const [file, iv, loop, screen, rules] = await Promise.all([
    sb.from("inbox_files").select("id, status").eq("tg_message_id", tgMessageId).maybeSingle(),
    sb.from("inbox_interview").select("id, status").eq("tg_message_id", tgMessageId).maybeSingle(),
    sb.from("inbox_loops").select("id").eq("tg_message_id", tgMessageId).maybeSingle(),
    sb.from("inbox_deal_screens").select("id").eq("tg_message_id", tgMessageId).maybeSingle(),
    getSetting("rules"),
  ])
  if (file.data) return { kind: "file", id: file.data.id, status: file.data.status }
  if (iv.data) return { kind: "interview", id: iv.data.id, status: iv.data.status }
  if (loop.data) return { kind: "loop", id: loop.data.id }
  if (screen.data) return { kind: "screen", id: screen.data.id }
  if (rules && Number(rules.tg_message_id) === tgMessageId) return { kind: "rules" }
  return null
}

/** Ryan replied (free text) to an inbox-agent message. Store it where the
 *  worker will find it and tell him what happens next. */
export async function recordInboxReply(ref: InboxRef, text: string): Promise<string> {
  const sb = getLeadsClient()
  const now = new Date().toISOString()
  const body = text.trim()
  if (!body) return "⚠️ Empty reply — nothing recorded."
  switch (ref.kind) {
    case "file": {
      if (ref.status === "filed") return "That one's already filed. Reply to a pending proposal to change it."
      await sb.from("inbox_files").update({ status: "changed", change_text: body, resolved_at: now }).eq("id", ref.id)
      return "✏️ Got it — I'll file it there on the next pass (≤5 min) and remember the rule."
    }
    case "interview": {
      await sb
        .from("inbox_interview")
        .update({ answer_text: body, answer_kind: "custom", status: "answered", answered_at: now })
        .eq("id", ref.id)
      return "📝 Noted. Next one coming up."
    }
    case "rules": {
      await setSetting("rules", { feedback: body, status: "revise", feedback_at: now })
      return "✏️ I'll rework the convention with that and show you the new version."
    }
    case "loop": {
      const lower = body.toLowerCase()
      if (/^(done|handled|did it|resolved|✓|✅)\b/.test(lower)) {
        await sb.from("inbox_loops").update({ status: "done", resolved_at: now }).eq("id", ref.id)
        return "✅ Marked done."
      }
      const snooze = /^snooze\s*(\d+)?\s*(d|day|days|w|week)?/.exec(lower)
      if (snooze) {
        const n = Number(snooze[1] || 2)
        const days = /^w/.test(snooze[2] || "") ? n * 7 : n
        const until = new Date(Date.now() + days * 86_400_000).toISOString()
        await sb.from("inbox_loops").update({ status: "snoozed", snooze_until: until }).eq("id", ref.id)
        return `⏰ Snoozed ${days} day${days === 1 ? "" : "s"}.`
      }
      await sb.from("inbox_loops").update({ ask: body }).eq("id", ref.id)
      return "📝 Updated the note on that item. (Reply done / snooze 3d to close or defer.)"
    }
    case "screen": {
      await sb.from("inbox_deal_screens").update({ ryan_verdict: body.slice(0, 200) }).eq("id", ref.id)
      return "📝 Noted on the screen."
    }
  }
}

/** Button tap on an inbox-agent message. Pure Supabase; returns what to say. */
export async function handleInboxCallback(data: string): Promise<InboxCallbackResult> {
  const sb = getLeadsClient()
  const now = new Date().toISOString()
  let m: RegExpExecArray | null

  if ((m = new RegExp(`^ix:fa:(${UUID})$`).exec(data))) {
    const { data: row } = await sb.from("inbox_files").select("status, proposed_folder, proposed_name").eq("id", m[1]).maybeSingle()
    if (!row) return { toast: "Not found" }
    if (row.status === "filed") return { toast: "Already filed", clearButtons: true }
    if (row.status !== "pending" && row.status !== "waiting") return { toast: `Already ${row.status}`, clearButtons: true }
    await sb.from("inbox_files").update({ status: "approved", resolved_at: now }).eq("id", m[1])
    return { toast: "Approved", clearButtons: true, text: `✅ Filing → ${row.proposed_folder}/${row.proposed_name} (next pass, ≤5 min)` }
  }
  if ((m = new RegExp(`^ix:fc:(${UUID})$`).exec(data))) {
    await sb.from("inbox_files").update({ status: "change_requested" }).eq("id", m[1]).in("status", ["pending", "waiting"])
    return {
      toast: "Reply with the folder + name",
      text: "✏️ Reply to the proposal above with where it goes and what to call it — e.g. “Properties/93 Ridgeview/Addendum A.pdf”, or just “Halleck folder, keep the name”.",
    }
  }
  if ((m = new RegExp(`^ix:fs:(${UUID})$`).exec(data))) {
    await sb.from("inbox_files").update({ status: "skipped", resolved_at: now }).eq("id", m[1]).in("status", ["pending", "waiting", "change_requested"])
    return { toast: "Skipped", clearButtons: true, text: "⏭ Skipped — not filed." }
  }
  if ((m = new RegExp(`^ix:fm:(${UUID})$`).exec(data))) {
    const { data: row } = await sb.from("inbox_files").select("rule_id").eq("id", m[1]).maybeSingle()
    if (row?.rule_id) {
      await sb.from("inbox_rules").update({ mode: "manual", approvals_in_row: 0, updated_at: now }).eq("id", row.rule_id)
      return { toast: "Rule is manual again", clearButtons: true, text: "↩️ That rule is back to manual — I'll ask before filing those." }
    }
    return { toast: "No rule attached", clearButtons: true }
  }
  if ((m = new RegExp(`^ix:io:(${UUID})$`).exec(data))) {
    await sb.from("inbox_interview").update({ answer_kind: "accepted", status: "answered", answered_at: now }).eq("id", m[1])
    return { toast: "Got it", clearButtons: true, text: "👍 Using my guess. Next one coming up." }
  }
  if ((m = new RegExp(`^ix:is:(${UUID})$`).exec(data))) {
    await sb.from("inbox_interview").update({ answer_kind: "skipped", status: "skipped", answered_at: now }).eq("id", m[1])
    return { toast: "Skipped", clearButtons: true }
  }
  if (data === "ix:ro") {
    await setSetting("rules", { status: "approved", approved_at: now })
    return { toast: "Rules approved", clearButtons: true, text: "📐 Convention locked in. Filing proposals start on the next pass — training mode, I'll ask before every upload." }
  }
  if (data === "ix:rn") {
    return { toast: "Reply with the changes", text: "✏️ Reply to the convention message with what's off and I'll redo it." }
  }
  if ((m = new RegExp(`^ix:ld:(${UUID})$`).exec(data))) {
    await sb.from("inbox_loops").update({ status: "done", resolved_at: now }).eq("id", m[1])
    return { toast: "Done", clearButtons: true }
  }
  if ((m = new RegExp(`^ix:lz:(${UUID})$`).exec(data))) {
    const until = new Date(Date.now() + 2 * 86_400_000).toISOString()
    await sb.from("inbox_loops").update({ status: "snoozed", snooze_until: until }).eq("id", m[1])
    return { toast: "Snoozed 2 days", clearButtons: true }
  }
  if ((m = new RegExp(`^ix:sl:(${UUID})$`).exec(data))) {
    await sb.from("inbox_deal_screens").update({ ryan_verdict: "look" }).eq("id", m[1])
    return { toast: "Marked: look further", clearButtons: true, text: "👀 Marked “look further”. Reply to the screen with what you want dug into." }
  }
  if ((m = new RegExp(`^ix:sp:(${UUID})$`).exec(data))) {
    await sb.from("inbox_deal_screens").update({ ryan_verdict: "pass" }).eq("id", m[1])
    return { toast: "Pass", clearButtons: true }
  }
  return { toast: "Unknown inbox action" }
}
