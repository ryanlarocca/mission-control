// Reply Planner — step two: draft from the plan. Sonnet, full thread, the
// playbook principles for the moment, Ryan's own past replies for the same
// moment as register, and (on a redraft) Ryan's one-sentence "why". Then the
// critic pass, then a reply_drafts row. Every surface calls this.

import { completeText, extractJsonObject, SONNET, hasLlmKey } from "@/lib/llm"
import { describeContact, formatThread, type ReplyContext } from "./context"
import { loadPlaybook, principlesFor } from "./playbook"
import { loadExemplars, formatExemplars } from "./exemplars"
import { critique, type CriticVerdict } from "./critic"
import { recordDraft } from "./record"
import type { Plan } from "./plan"
import { relationshipGuidance, intentForMoment, normalizeCategory } from "./relationship"

export const DRAFT_PROMPT_VERSION = "draft-v1-2026-09-24"

export type DraftChannel = "email" | "sms" | "imessage"

export interface DraftArgs {
  ctx: ReplyContext
  plan: Plan
  channel: DraftChannel
  surface: "leads_card" | "followups" | "relationships" | "drip" | "telegram" | "eval"
  why?: string | null
  parentDraftId?: string | null
  previousDraft?: { subject?: string | null; body: string } | null
  // Extra steering that is not a "why" — e.g. Ryan's card notes.
  notes?: string | null
  skipCritic?: boolean
  skipRecord?: boolean
  excludeExemplarReply?: string | null
  // Drips: the drip_queue row this draft belongs to.
  dripQueueId?: string | null
}

export interface DraftResult {
  draftId: string | null
  subject: string | null
  body: string
  plan: Plan
  critic: CriticVerdict | null
  playbookVersion: string
  promptVersion: string
  exemplarCount: number
}

const VOICE_SYSTEM = `You write replies as Ryan LaRocca, a cash home buyer and investor in the Bay Area. Ryan sends these himself; the reader must never sense a system wrote it.

How Ryan writes:
- Plain, warm, direct. Short sentences. Says the thing, then stops.
- Specific to this person and this conversation. Nothing generic, nothing that could be pasted to anyone else.
- Never claims a memory, a feeling, or a fact that is not in the conversation or the contact details. If a figure or date is needed and is not given, write a bracketed placeholder like [OFFER PRICE] rather than inventing one.
- Plain ASCII punctuation: regular hyphens, straight quotes, no em-dashes or en-dashes. No emojis.
- Texts: as short as the moment allows. A confirmation or a thank-you is one line; three sentences is the ceiling. No sign-off.
- Emails: a few short paragraphs at most, "Ryan" alone on the last line.
- Register examples are for tone and length only. Do not reuse their sentences or their specifics.`

function channelRules(channel: DraftChannel): string {
  return channel === "email"
    ? `Reply channel: EMAIL. Return JSON { "subject": "...", "body": "..." }. Subject short and specific (a reply in an existing thread keeps the thread's subject, prefixed "Re: " if it is not already). Body ends with "Ryan" on its own line.`
    : `Reply channel: TEXT MESSAGE. Return JSON { "subject": null, "body": "..." }. One to three sentences. No greeting line needed if the thread is active. No sign-off.`
}

export async function draftReply(args: DraftArgs): Promise<DraftResult | null> {
  if (!hasLlmKey()) return null
  const { ctx, plan, channel } = args
  const pb = loadPlaybook()
  const category = ctx.kind === "relationship" ? normalizeCategory(ctx.category) : null
  const shared = ctx.kind === "relationship" ? principlesFor(pb, "relationships_shared") : null
  const momentPrinciples = principlesFor(pb, plan.moment)
  const guidance = ctx.kind === "relationship"
    ? relationshipGuidance({
        category: category!,
        intent: plan.intent ?? intentForMoment(plan.moment),
        familiarity: plan.familiarity ?? (ctx.everContacted ? "Knows" : "Reintro"),
        everContacted: ctx.everContacted,
        moment: plan.moment,
      })
    : null
  const principles = [shared, momentPrinciples, guidance].filter(Boolean).join("\n\n") || null
  const exemplars = await loadExemplars({
    moment: plan.moment,
    channel: channel === "imessage" ? "sms" : channel,
    surface: ctx.kind === "lead" ? "leads" : "relationships",
    category,
    excludeLeadId: ctx.kind === "lead" ? ctx.leadId : null,
    excludeReply: args.excludeExemplarReply ?? null,
  })
  const exemplarText = formatExemplars(exemplars)
  const today = new Date().toISOString().slice(0, 10)

  const prompt = `TODAY IS ${today}.

THE PLAN (decided before this draft; the reply must serve it)
  moment: ${plan.moment}${plan.temperature ? ` · temperature: ${plan.temperature}` : ""}${ctx.kind === "relationship" ? ` · contact type: ${category} · they ${plan.familiarity === "Reintro" ? "may not remember Ryan" : "know Ryan"}` : ""} · next action: ${plan.next_action}
  why this plan: ${plan.reason || "(not stated)"}

PRINCIPLES FOR THIS MOMENT (from Ryan's playbook)
${principles || "(no written principles yet for this moment — use judgment and the register examples)"}

CONTACT
${describeContact(ctx)}
${ctx.kind === "relationship" && ctx.notes ? `Notes on this contact:\n${ctx.notes.slice(0, 1500)}\n` : ""}
CONVERSATION (oldest → newest; "them" is the contact, "ryan" is Ryan, "ryan(drip)" is an automated touch)
${formatThread(ctx, 16)}

RYAN'S PAST REPLIES IN THIS KIND OF MOMENT (register and length only)
${exemplarText}
${args.notes ? `
RYAN'S NOTES ON THIS CONTACT (his shorthand; apply the intent, never quote)
${args.notes.slice(0, 1200)}
` : ""}${args.why ? `
RYAN REJECTED THE PREVIOUS DRAFT. His words on what was off:
"${args.why.trim()}"
${args.previousDraft ? `The rejected draft was:\n${args.previousDraft.subject ? `Subject: ${args.previousDraft.subject}\n` : ""}${args.previousDraft.body}\n` : ""}
Fix exactly what he named. Keep everything he did not object to.
` : ""}
${channelRules(channel)}

Write the reply the conversation is actually waiting for. Respond with the JSON object only.`

  let subject: string | null = null
  let body = ""
  try {
    const out = await completeText({ model: SONNET, system: VOICE_SYSTEM, prompt, maxTokens: 4096, tag: "[reply/draft]" })
    const parsed = JSON.parse(extractJsonObject(out.text)) as { subject?: unknown; body?: unknown }
    body = typeof parsed.body === "string" ? parsed.body.trim() : ""
    subject = channel === "email" && typeof parsed.subject === "string" && parsed.subject.trim() ? parsed.subject.trim() : null
    // Inbound email rows store "Subject: <x>" as their first line, so the
    // model can echo it into "Re: Subject: <x>". Strip the literal prefix.
    if (subject) subject = subject.replace(/^(re:\s*)?subject:\s*/i, (m) => (/^re:/i.test(m) ? "Re: " : "")).trim() || subject
    if (!body) throw new Error("empty body")
  } catch (e) {
    console.error("[reply/draft] failed:", e instanceof Error ? e.message : String(e))
    return null
  }

  let critic: CriticVerdict | null = null
  if (!args.skipCritic) {
    const c = await critique({ ctx, plan, principles, subject, body, exemplars: exemplarText })
    critic = c.verdict
    subject = c.subject
    body = c.body
  }

  let draftId: string | null = null
  if (!args.skipRecord) {
    draftId = await recordDraft({
      surface: args.surface,
      lead_id: ctx.kind === "lead" ? ctx.leadId : null,
      relationship_id: ctx.kind === "relationship" ? ctx.relationshipId : null,
      drip_queue_id: args.dripQueueId || null,
      channel,
      moment: plan.moment,
      temperature: plan.temperature,
      next_action: plan.next_action,
      plan_json: plan,
      draft_subject: subject,
      draft_body: body,
      model: SONNET,
      prompt_version: DRAFT_PROMPT_VERSION,
      playbook_version: pb.version,
      why_text: args.why?.trim() || null,
      parent_draft_id: args.parentDraftId || null,
      critic_json: critic,
    })
  }

  return { draftId, subject, body, plan, critic, playbookVersion: pb.version, promptVersion: DRAFT_PROMPT_VERSION, exemplarCount: exemplars.length }
}
