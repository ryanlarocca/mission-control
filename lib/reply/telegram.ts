// Reply Planner Phase 5 — the plan + draft on Telegram. After a lead alert
// posts, a second message carries the plan line and the draft with
// [✅ Send] [🔁 Redraft] [❌ Dismiss]. A text reply to that message is a
// "why": the draft is redone with it and posted as v2 (old buttons cleared).
// Send goes out the same way the card sends (lead line SMS / threaded email)
// and then executes the plan.

import { getLeadsClient, leadAlertBotToken, sendLeadSms } from "@/lib/leads"
import { sendThreadedEmailReply } from "@/lib/emailReply"
import { buildLeadContext, buildRelationshipContext } from "./context"
import { proposePlan, stampLeadMoment, type Plan } from "./plan"
import { draftReply, type DraftChannel } from "./draft"
import { coachDraft } from "./coach"
import { executePlanServer } from "./execute"
import { MOMENT_LABELS, NEXT_ACTION_LABELS } from "@/lib/reply-client"
import { sendOfficeText, type Rel } from "@/lib/office-reply"
import { displayLine } from "@/lib/card-line"
import { sendAgentsLineText } from "@/lib/campaignSms"
import { findLatestEmailThread, newThreadSubject, replySubject, sendRelationshipEmail, type EmailThreadRef } from "@/lib/relationshipEmail"

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
  relationship_id: string | null
  channel: string | null
  draft_subject: string | null
  draft_body: string
  plan_json: Plan | null
  sent_at: string | null
  tg_message_id: number | null
  gist: string | null
  parent_draft_id: string | null
}

// Relationships drafts carry the number the alert named (the reply target)
// and the line it goes out on, on the plan — ✅ and 🔁 text the same number
// from the same line a typed reply would. An email draft (line "email",
// 2026-11-11) carries whether it was drafted into an existing thread, so ✅
// sends under the subject the draft message showed.
export type RelationshipDraftLine = "office" | "agents" | "email"
type OfficePlan = Plan & { send_to?: string | null; line?: RelationshipDraftLine | null; email_threaded?: boolean | null }

/** The subject an email draft goes out under, as sendRelationshipEmail will
 * pick it: in their thread → "Re: <thread subject>"; no thread → the
 * drafter's subject as a fresh one (Re:/Fwd: dropped, empty → "Checking in"). */
export function emailDraftSubject(thread: Pick<EmailThreadRef, "subject"> | null, drafted: string | null | undefined): string {
  return thread ? replySubject(thread.subject) : newThreadSubject(drafted)
}

/** The ✅ confirmation's "who" for an email that went out. */
export function emailSentLabel(name: string, out: { threaded?: boolean; mailbox?: string }): string {
  return `${name} by email — ${out.threaded ? "same thread" : "new email"}${out.mailbox ? `, from ${out.mailbox}` : ""}`
}

async function loadDraft(draftId: string): Promise<DraftRow | null> {
  const sb = getLeadsClient()
  const { data } = await sb.from("reply_drafts").select("id, lead_id, relationship_id, channel, draft_subject, draft_body, plan_json, sent_at, tg_message_id, gist, parent_draft_id").eq("id", draftId).maybeSingle<DraftRow>()
  return data ?? null
}

export async function findPlannerDraftByTgMessage(tgMessageId: number): Promise<DraftRow | null> {
  const sb = getLeadsClient()
  const { data } = await sb.from("reply_drafts").select("id, lead_id, relationship_id, channel, draft_subject, draft_body, plan_json, sent_at, tg_message_id, gist, parent_draft_id").eq("tg_message_id", tgMessageId).order("created_at", { ascending: false }).limit(1).maybeSingle<DraftRow>()
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
  // A DNC'd contact whose latest message is an explicit remove request gets
  // the opt-out confirmation plan, whatever moment the cluster carries.
  const { explicitOptOutPhrase } = await import("@/lib/dnc")
  const optOut = ctx.kind === "lead" && ctx.doNotContact && !!explicitOptOutPhrase(ctx.lastInbound?.text ?? null)
  let plan: Plan | null = optOut
    ? { moment: "hard_no_optout", temperature: ctx.temperature, next_action: "close_dead", reason: "asked to be taken off the list", source: "ai" }
    : ctx.moment
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

/** "draft: <gist>" replied to a lead alert (2026-11-07, Ryan on Anita's text
 *  alert): the coach writer drafts from his gist and posts it with the same
 *  ✅/🔁/❌ buttons. Nothing is sent until ✅. Replies to the posted draft
 *  redraft via redraftFromTelegram (the gist rides the parent chain). */
export async function coachDraftFromTelegram(phone: string, gist: string, replyTo?: number | null): Promise<{ ok: boolean; error?: string }> {
  const sb = getLeadsClient()
  const { data: lead } = await sb.from("leads").select("id").eq("caller_phone", phone).order("created_at", { ascending: false }).limit(1).maybeSingle<{ id: string }>()
  if (!lead) return { ok: false, error: `no lead on file for ${phone}` }
  return coachDraftForLead(lead.id, gist, replyTo)
}

/** The same, for a lead the alert named by id (lib/alertSubject). Texts or
 *  emails by the channel they reached us on. */
export async function coachDraftForLead(leadId: string, gist: string, replyTo?: number | null): Promise<{ ok: boolean; error?: string }> {
  const ctx = await buildLeadContext(leadId)
  if (!ctx) return { ok: false, error: "lead not found" }
  const channel: DraftChannel = ctx.inboundChannel === "email" && ctx.email ? "email" : "sms"
  if (channel === "sms" && !ctx.phone) return { ok: false, error: "no phone" }
  // His gist decides what happens, not the record: the proposed plan said
  // "schedule call" on Anita's pass. ✅ sends the reply and nothing else.
  const proposed = await proposePlan(ctx)
  if (!proposed) return { ok: false, error: "plan unavailable" }
  const plan: Plan = { ...proposed, next_action: "reply_only" }
  const out = await coachDraft({ ctx, channel, surface: "telegram", gist, plan, notes: ctx.notes })
  if (!out || !out.draftId) return { ok: false, error: "draft unavailable" }
  await postDraftMessage({
    draftId: out.draftId, name: ctx.name || ctx.phone || ctx.email || "lead", plan: out.plan, body: out.body, subject: out.subject, channel,
    replyTo, note: out.read ? `🧠 ${out.read}` : null,
  })
  return { ok: true }
}

/** Reply-to-draft text or the 🔁 button: redraft (with the why when given) and post v2. */
export async function redraftFromTelegram(draftId: string, why: string | null, replyTo?: number | null): Promise<{ ok: boolean; error?: string }> {
  const row = await loadDraft(draftId)
  if (row && !row.lead_id && row.relationship_id) return redraftRelationship(row, why, replyTo)
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
  if (row && !row.lead_id && row.relationship_id) return sendRelationshipDraft(row)
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
    const out = await sendThreadedEmailReply({ leadId: inbound.id, text: row.draft_body, draftId: row.id, optOutConfirmation: row.plan_json?.moment === "hard_no_optout" })
    if (!out.ok) return { ok: false, error: out.error }
  } else {
    if (!ctx.phone) return { ok: false, error: "no phone" }
    const out = await sendLeadSms({ phone: ctx.phone, message: row.draft_body, source: ctx.source ?? null, optOutConfirmation: row.plan_json?.moment === "hard_no_optout" })
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

/** "Draft: <gist>" replied to an alert about a Relationships contact —
 *  office line or agents line, text, call or summary (2026-11-10 — a pass
 *  on a wholesaler's deal text got "no lead on file"). Same coach writer and
 *  ✅/🔁/❌ buttons as a lead; ✅ texts from `line` and logs a touch, which
 *  restarts the contact's cadence. `line` "email" (2026-11-11, an email to
 *  ryan@): drafted as an email, no phone needed, ✅ emails it in their
 *  thread from ryan@ (sendRelationshipEmail). */
export async function coachDraftForRelationship(relationshipId: string, sendTo: string | null, gist: string, replyTo?: number | null, line: RelationshipDraftLine = "office"): Promise<{ ok: boolean; error?: string }> {
  if (line === "email") return coachEmailDraftForRelationship(relationshipId, gist, replyTo)
  const ctx = await buildRelationshipContext(relationshipId)
  if (!ctx) return { ok: false, error: "contact not found" }
  const proposed = await proposePlan(ctx)
  if (!proposed) return { ok: false, error: "plan unavailable" }
  const to = sendTo || ctx.phone
  if (!to) return { ok: false, error: "no phone on the card" }
  const plan: OfficePlan = { ...proposed, next_action: "reply_only", send_to: to, line }
  const out = await coachDraft({ ctx, channel: "sms", surface: "telegram", gist, plan, notes: ctx.notes })
  if (!out || !out.draftId) return { ok: false, error: "draft unavailable" }
  await postDraftMessage({
    draftId: out.draftId, name: ctx.name || to, plan: out.plan, body: out.body, subject: null, channel: "sms",
    replyTo, note: out.read ? `🧠 ${out.read}` : null,
  })
  return { ok: true }
}

// The email half of coachDraftForRelationship. Mirrors the lead path's
// email drafts (coachDraftForLead): the coach writes with channel "email"
// and the draft message shows a subject — here the one it will really go
// out under, since the thread decides it, not the drafter.
async function coachEmailDraftForRelationship(relationshipId: string, gist: string, replyTo?: number | null): Promise<{ ok: boolean; error?: string }> {
  const ctx = await buildRelationshipContext(relationshipId)
  if (!ctx) return { ok: false, error: "contact not found" }
  if (!ctx.email?.includes("@")) return { ok: false, error: "no email address on the card" }
  const [proposed, thread] = await Promise.all([
    proposePlan(ctx),
    findLatestEmailThread(getLeadsClient(), relationshipId).catch(() => null),
  ])
  if (!proposed) return { ok: false, error: "plan unavailable" }
  const plan: OfficePlan = { ...proposed, next_action: "reply_only", send_to: null, line: "email", email_threaded: !!thread }
  const out = await coachDraft({ ctx, channel: "email", surface: "telegram", gist, plan, notes: ctx.notes })
  if (!out || !out.draftId) return { ok: false, error: "draft unavailable" }
  await postDraftMessage({
    draftId: out.draftId, name: ctx.name || ctx.email || "contact", plan: out.plan, body: out.body, subject: emailDraftSubject(thread, out.subject), channel: "email",
    replyTo, note: out.read ? `🧠 ${out.read}` : null,
  })
  return { ok: true }
}

async function sendRelationshipDraft(row: DraftRow): Promise<{ ok: boolean; error?: string; label?: string; planNote?: string | null }> {
  if (row.sent_at) return { ok: false, error: "already sent" }
  if (row.channel === "email") {
    // sendRelationshipEmail threads it into their newest conversation, logs
    // the touch with its Gmail ids, restarts the clock and marks the draft
    // sent. A threaded draft keeps the thread's subject; a fresh one goes
    // out under the drafter's.
    const plan = row.plan_json as OfficePlan | null
    const out = await sendRelationshipEmail({ relationshipId: row.relationship_id!, body: row.draft_body, draftId: row.id, subject: plan?.email_threaded ? null : row.draft_subject })
    if (!out.ok) return { ok: false, error: out.error || "send failed" }
    const sb = getLeadsClient()
    const { data: rel } = await sb.from("relationships").select("name").eq("id", row.relationship_id!).maybeSingle<{ name: string | null }>()
    return { ok: true, label: emailSentLabel(rel?.name || out.to || "contact", out), planNote: out.touchLogged === false ? "⚠️ logged with a warning" : null }
  }
  const sb = getLeadsClient()
  const { data: rel } = await sb.from("relationships").select("id, name, phone, status, tier, category").eq("id", row.relationship_id!).maybeSingle<Rel & { phone: string | null }>()
  if (!rel) return { ok: false, error: "contact not found" }
  const plan = row.plan_json as OfficePlan | null
  const to = plan?.send_to || rel.phone
  if (!to) return { ok: false, error: "no phone on the card" }
  if (plan?.line === "agents") {
    // Opt-outs are the suppression list, checked inside sendAgentsLineText —
    // a card's do_not_contact status is the Cleanup "never" verdict, which
    // many campaign agents carry (see lib/agentsLineInbound).
    const out = await sendAgentsLineText({ to10: to.replace(/\D/g, "").slice(-10), body: row.draft_body, draftId: row.id })
    if (!out.success) return { ok: false, error: out.error || "send failed" }
    return { ok: true, label: `${rel.name ?? to} from the agents line`, planNote: out.logWarning ? "⚠️ logged with a warning" : null }
  }
  const out = await sendOfficeText(sb, rel, to, row.draft_body, row.id)
  if (!out.ok) return { ok: false, error: out.error }
  return { ok: true, label: `${rel.name ?? to} from ${displayLine(out.from)}`, planNote: out.logWarning ? "⚠️ logged with a warning" : null }
}

// Redraft a Relationships coach draft: the chain's gists + drafts are the
// turns (oldest first), the reply (or "another version") is this turn.
async function redraftRelationship(row: DraftRow, why: string | null, replyTo?: number | null): Promise<{ ok: boolean; error?: string }> {
  if (row.sent_at) return { ok: false, error: "that draft was already sent" }
  const ctx = await buildRelationshipContext(row.relationship_id!)
  if (!ctx) return { ok: false, error: "contact not found" }
  const chain: DraftRow[] = [row]
  while (chain.length < 6 && chain[0].parent_draft_id) {
    const parent = await loadDraft(chain[0].parent_draft_id)
    if (!parent) break
    chain.unshift(parent)
  }
  const turns = chain.map((d) => ({ gist: d.gist ?? "", body: d.draft_body }))
  // The draft keeps its channel (an email draft redrafts as an email); the
  // thread is looked up again so the shown subject is the one ✅ will use.
  const channel: DraftChannel = row.channel === "email" ? "email" : "sms"
  const thread = channel === "email" ? await findLatestEmailThread(getLeadsClient(), row.relationship_id!).catch(() => null) : null
  const prior = row.plan_json as OfficePlan | null
  const plan: OfficePlan | null = channel === "email" && prior ? { ...prior, email_threaded: !!thread } : prior
  const out = await coachDraft({
    ctx, channel, surface: "telegram", gist: why?.trim() || "Give me a different version.", turns, plan, notes: ctx.notes, parentDraftId: row.id,
  })
  if (!out || !out.draftId) return { ok: false, error: "draft unavailable" }
  if (typeof row.tg_message_id === "number" && CHAT_ID()) {
    await tg("editMessageReplyMarkup", { chat_id: CHAT_ID(), message_id: row.tg_message_id, reply_markup: { inline_keyboard: [] } })
  }
  await postDraftMessage({
    draftId: out.draftId, name: ctx.name || ctx.phone || ctx.email || "contact", plan: out.plan, body: out.body,
    subject: channel === "email" ? emailDraftSubject(thread, out.subject) : null, channel,
    replyTo: replyTo ?? row.tg_message_id, note: why ? `↩︎ redrafted from: "${why}"` : "↩︎ redrafted",
  })
  return { ok: true }
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
  // The prod alias, not VERCEL_URL: per-deployment URLs can sit behind
  // Vercel's deployment protection and would 401 the server-to-server call.
  const base = process.env.MC_BASE_URL || (process.env.VERCEL ? "https://mission-control-three-chi.vercel.app" : "http://localhost:3000")
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
