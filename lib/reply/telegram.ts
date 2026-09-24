// Reply Planner Phase 5 — the plan + draft on Telegram. After a lead alert
// posts, a second message carries the plan line and the draft with
// [✅ Send] [🔁 Redraft] [❌ Dismiss]. A text reply to that message is a
// "why": the draft is redone with it and posted as v2 (old buttons cleared).
// Send goes out the same way the card sends (lead line SMS / threaded email)
// and then executes the plan.

import { getLeadsClient, leadAlertBotToken, sendLeadSms } from "@/lib/leads"
import { sendThreadedEmailReply } from "@/lib/emailReply"
import { buildLeadContext } from "./context"
import { proposePlan, stampLeadMoment, type Plan } from "./plan"
import { draftReply, type DraftChannel } from "./draft"
import { executePlanServer } from "./execute"
import { MOMENT_LABELS, NEXT_ACTION_LABELS } from "@/lib/reply-client"

const CHAT_ID = () => process.env.TELEGRAM_CHAT_ID

async function tg(method: string, body: Record<string, unknown>): Promise<{ ok?: boolean; result?: { message_id?: number } } | null> {
  const token = leadAlertBotToken()
  if (!token) return null
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })
    return (await res.json()) as { ok?: boolean; result?: { message_id?: number } }
  } catch (e) {
    console.error(`[reply/telegram] ${method} failed:`, e instanceof Error ? e.message : String(e))
    return null
  }
}

function planLine(plan: Plan): string {
  const parts = [MOMENT_LABELS[plan.moment] ?? plan.moment]
  if (plan.temperature) parts.push(plan.temperature)
  parts.push(NEXT_ACTION_LABELS[plan.next_action] ?? plan.next_action)
  return parts.join(" · ")
}

interface DraftRow {
  id: string
  lead_id: string | null
  channel: string | null
  draft_subject: string | null
  draft_body: string
  plan_json: Plan | null
  sent_at: string | null
  tg_message_id: number | null
}

async function loadDraft(draftId: string): Promise<DraftRow | null> {
  const sb = getLeadsClient()
  const { data } = await sb.from("reply_drafts").select("id, lead_id, channel, draft_subject, draft_body, plan_json, sent_at, tg_message_id").eq("id", draftId).maybeSingle<DraftRow>()
  return data ?? null
}

export async function findPlannerDraftByTgMessage(tgMessageId: number): Promise<DraftRow | null> {
  const sb = getLeadsClient()
  const { data } = await sb.from("reply_drafts").select("id, lead_id, channel, draft_subject, draft_body, plan_json, sent_at, tg_message_id").eq("tg_message_id", tgMessageId).order("created_at", { ascending: false }).limit(1).maybeSingle<DraftRow>()
  return data ?? null
}

async function postDraftMessage(args: { draftId: string; name: string; plan: Plan; body: string; subject: string | null; channel: string; replyTo?: number | null; note?: string | null }): Promise<number | null> {
  const chatId = CHAT_ID()
  if (!chatId) return null
  const text = [
    `✨ Plan for ${args.name}: ${planLine(args.plan)}`,
    args.plan.reason ? `(${args.plan.reason})` : null,
    "",
    args.subject ? `Subject: ${args.subject}` : null,
    args.body,
    "",
    args.note,
    `Reply to THIS message with what's off and I'll redraft. Tap ✅ to send as ${args.channel === "email" ? "an email" : "a text"}${args.plan.next_action !== "reply_only" ? ` and ${NEXT_ACTION_LABELS[args.plan.next_action]?.toLowerCase() ?? args.plan.next_action}` : ""}.`,
  ].filter((l) => l !== null).join("\n")
  const payload = {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: [[
      { text: "✅ Send", callback_data: `rsend:${args.draftId}` },
      { text: "🔁 Redraft", callback_data: `rredo:${args.draftId}` },
      { text: "❌ Dismiss", callback_data: `rdisc:${args.draftId}` },
    ]] },
  }
  let sent = await tg("sendMessage", { ...payload, ...(args.replyTo ? { reply_to_message_id: args.replyTo, allow_sending_without_reply: true } : {}) })
  if (!sent?.ok) sent = await tg("sendMessage", payload)
  const id = sent?.result?.message_id ?? null
  if (typeof id === "number") {
    const sb = getLeadsClient()
    await sb.from("reply_drafts").update({ tg_message_id: id }).eq("id", args.draftId)
  }
  return id
}

/** Draft from the plan for a lead and post it to Telegram. Called after an intake alert. */
export async function postPlannerDraft(leadId: string, opts: { dryRun?: boolean } = {}): Promise<{ ok: boolean; error?: string; draftId?: string | null; preview?: string }> {
  const ctx = await buildLeadContext(leadId)
  if (!ctx) return { ok: false, error: "lead not found" }
  let plan: Plan | null = ctx.moment
    ? { moment: ctx.moment, temperature: ctx.temperature, next_action: defaultAction(ctx.moment), reason: ctx.followup_reason || "", source: "ai" }
    : await proposePlan(ctx)
  if (!plan) return { ok: false, error: "plan unavailable" }
  if (plan.moment === "junk_wrong_person" || plan.next_action === "junk") return { ok: true, draftId: null }
  await stampLeadMoment(ctx.clusterIds, plan.moment)
  const channel: DraftChannel = ctx.inboundChannel === "email" ? "email" : "sms"
  if (channel === "sms" && !ctx.phone) return { ok: false, error: "no phone" }
  if (channel === "email" && !ctx.email) return { ok: false, error: "no email" }
  const out = await draftReply({ ctx, plan, channel, surface: "telegram", notes: ctx.notes })
  if (!out || !out.draftId) return { ok: false, error: "draft unavailable" }
  if (opts.dryRun) return { ok: true, draftId: out.draftId, preview: `Plan: ${planLine(out.plan)}\n${out.subject ? `Subject: ${out.subject}\n` : ""}${out.body}` }
  await postDraftMessage({ draftId: out.draftId, name: ctx.name || ctx.phone || ctx.email || "lead", plan: out.plan, body: out.body, subject: out.subject, channel })
  return { ok: true, draftId: out.draftId }
}

function defaultAction(moment: string): string {
  switch (moment) {
    case "soft_no": return "long_term_nurture"
    case "hard_no_optout": return "close_dead"
    case "junk_wrong_person": return "junk"
    case "offer_requested":
    case "invitation_to_talk": return "schedule_call"
    default: return "reply_only"
  }
}

/** Reply-to-draft text or the 🔁 button: redraft (with the why when given) and post v2. */
export async function redraftFromTelegram(draftId: string, why: string | null, replyTo?: number | null): Promise<{ ok: boolean; error?: string }> {
  const row = await loadDraft(draftId)
  if (!row || !row.lead_id) return { ok: false, error: "draft not found" }
  if (row.sent_at) return { ok: false, error: "that draft was already sent" }
  const ctx = await buildLeadContext(row.lead_id)
  if (!ctx) return { ok: false, error: "lead not found" }
  const plan: Plan = row.plan_json ?? { moment: ctx.moment || "question", temperature: ctx.temperature, next_action: "reply_only", reason: "", source: "ai" }
  const channel: DraftChannel = row.channel === "email" ? "email" : "sms"
  const out = await draftReply({
    ctx, plan, channel, surface: "telegram", notes: ctx.notes,
    why, parentDraftId: row.id, previousDraft: { subject: row.draft_subject, body: row.draft_body },
  })
  if (!out || !out.draftId) return { ok: false, error: "draft unavailable" }
  if (typeof row.tg_message_id === "number" && CHAT_ID()) {
    await tg("editMessageReplyMarkup", { chat_id: CHAT_ID(), message_id: row.tg_message_id, reply_markup: { inline_keyboard: [] } })
  }
  await postDraftMessage({
    draftId: out.draftId, name: ctx.name || ctx.phone || ctx.email || "lead", plan: out.plan, body: out.body, subject: out.subject, channel,
    replyTo: replyTo ?? row.tg_message_id, note: why ? `↩︎ redrafted from: "${why}"` : "↩︎ redrafted",
  })
  return { ok: true }
}

/** ✅ on a planner draft: send it the way the card would, then execute the plan. */
export async function sendPlannerDraft(draftId: string): Promise<{ ok: boolean; error?: string; label?: string; planNote?: string | null }> {
  const row = await loadDraft(draftId)
  if (!row || !row.lead_id) return { ok: false, error: "draft not found" }
  if (row.sent_at) return { ok: false, error: "already sent" }
  const ctx = await buildLeadContext(row.lead_id, { live: false })
  if (!ctx) return { ok: false, error: "lead not found" }
  const label = ctx.name || ctx.phone || ctx.email || "lead"
  if (row.channel === "email") {
    const sb = getLeadsClient()
    // The inbound email row (the thread) is the reply target.
    const { data: inbound } = await sb.from("leads").select("id").in("id", ctx.clusterIds).eq("lead_type", "email").not("twilio_number", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle<{ id: string }>()
    if (!inbound) return { ok: false, error: "no inbound email to reply to" }
    const out = await sendThreadedEmailReply({ leadId: inbound.id, text: row.draft_body, draftId: row.id })
    if (!out.ok) return { ok: false, error: out.error }
  } else {
    if (!ctx.phone) return { ok: false, error: "no phone" }
    const out = await sendLeadSms({ phone: ctx.phone, message: row.draft_body, source: ctx.source ?? null })
    if (!out.success) return { ok: false, error: out.error || "send failed" }
    const { markDraftSent } = await import("./record")
    await markDraftSent(row.id, { subject: null, body: row.draft_body })
  }
  let planNote: string | null = null
  try {
    planNote = await executePlanServer(row.lead_id, row.plan_json)
  } catch (e) {
    planNote = `sent, but the plan step failed: ${e instanceof Error ? e.message : String(e)}`
  }
  return { ok: true, label, planNote }
}

export async function dismissPlannerDraft(draftId: string): Promise<void> {
  const row = await loadDraft(draftId)
  if (row && typeof row.tg_message_id === "number" && CHAT_ID()) {
    await tg("editMessageReplyMarkup", { chat_id: CHAT_ID(), message_id: row.tg_message_id, reply_markup: { inline_keyboard: [] } })
  }
}

/** Fire-and-forget hook for intake webhooks: asks the planner route to post a draft without blocking the webhook. */
export async function triggerTelegramDraft(leadId: string | null | undefined): Promise<void> {
  if (!leadId) return
  const base = process.env.NEXT_PUBLIC_BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) || "http://localhost:3000"
  const secret = process.env.REPLY_INTERNAL_SECRET || process.env.MC_PASSWORD || ""
  try {
    await fetch(`${base}/api/reply/telegram-draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-reply-secret": secret },
      body: JSON.stringify({ leadId }),
      signal: AbortSignal.timeout(1500),
    })
  } catch {
    /* the target keeps running after our client-side timeout */
  }
}
