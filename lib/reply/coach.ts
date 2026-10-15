// Coach mode (briefs/BRIEF_COACHED_DRAFT_2026-10-15.md §C) — "tell it the
// gist, it drops the message". Ryan dictates what he wants to say (the
// number, the reasoning, the decision); Opus reads the WHOLE history plus
// the gist and returns a 2-3 line read of the situation and the draft. A
// refinement ("shorter", "make it 925") is another coach turn that sees the
// previous drafts. Same plan chips, critic and reply_drafts log as Auto.

import { completeText, extractJsonObject, OPUS, hasLlmKey } from "@/lib/llm"
import { describeContact, formatThread, type ReplyContext } from "./context"
import { loadPlaybook, principlesFor } from "./playbook"
import { loadExemplars, formatExemplars } from "./exemplars"
import { critique, type CriticVerdict } from "./critic"
import { recordDraft } from "./record"
import { proposePlan, stampLeadMoment, type Plan } from "./plan"
import { VOICE_SYSTEM, channelRules, type DraftArgs, type DraftChannel } from "./draft"
import { relationshipGuidance, intentForMoment, normalizeCategory } from "./relationship"

export const COACH_PROMPT_VERSION = "coach-v1-2026-10-15"
// Adaptive thinking shares max_tokens with the answer on Opus; the brief
// asks for >= 8192 so a long email plus the read never clips.
export const COACH_MAX_TOKENS = 8192

export interface CoachTurn {
  gist: string
  body: string
}

export interface CoachArgs {
  ctx: ReplyContext
  channel: DraftChannel
  surface: DraftArgs["surface"]
  // The gist for THIS turn: the brief on the first turn, the follow-up
  // ("shorter") on a refinement.
  gist: string
  // Prior turns when refining, oldest first: each gist and the draft it got.
  turns?: CoachTurn[] | null
  // Chips as shown on the card. Omitted → proposePlan runs first so the
  // moment / next_action are stamped like Auto.
  plan?: Plan | null
  parentDraftId?: string | null
  dripQueueId?: string | null
  skipCritic?: boolean
  skipRecord?: boolean
  // Dry runs: don't stamp leads.moment.
  skipStamp?: boolean
}

export interface CoachResult {
  read: string
  subject: string | null
  body: string
  draftId: string | null
  plan: Plan
  critic: CriticVerdict | null
  playbookVersion: string
  promptVersion: string
  exemplarCount: number
}

export const COACH_SYSTEM = `${VOICE_SYSTEM}

COACH MODE. Ryan has told you the gist of what he wants to say. His gist is the source of truth for every number, decision and intent in the reply: a figure he gave is a given fact, use it exactly (never a bracketed placeholder for something he said). A figure he did not give and the record does not contain is still never invented.
The gist is rough speech. Apply its meaning; never quote it or echo its phrasing.
For a text message, the usual three-sentence ceiling is lifted for this draft: as long as the gist needs, as short as it can be. Delivering a hard number politely needs the reason, the number, the terms, and an open door; nothing more.
You also write a short READ of the situation for Ryan's eyes only. It is never sent.`

/** Coach channel rules: text stays a text (no subject, no sign-off, plain
 *  ASCII) but without the three-sentence ceiling; email rules unchanged. */
export function coachChannelRules(channel: DraftChannel): string {
  if (channel === "email") return channelRules(channel)
  return `Reply channel: TEXT MESSAGE. "subject" is null. No sign-off, no greeting line if the thread is active, plain ASCII. As long as the gist needs and as short as it can be; the three-sentence ceiling does not apply to a coached text.`
}

export interface CoachPromptInput {
  ctx: ReplyContext
  plan: Plan
  channel: DraftChannel
  gist: string
  turns: CoachTurn[]
  principles: string | null
  exemplarText: string
  today: string
}

/** Pure prompt assembly. Exported so the unit test can check the whole
 *  thread, the money facts and the gist all reach the model. */
export function buildCoachPrompt(input: CoachPromptInput): string {
  const { ctx, plan, channel, turns, principles, exemplarText, today } = input
  const gist = input.gist.trim()
  const category = ctx.kind === "relationship" ? normalizeCategory(ctx.category) : null
  const originalGist = turns.length ? turns[0].gist.trim() : gist

  let turnsBlock = ""
  if (turns.length) {
    const lines: string[] = ["THE DRAFTS SO FAR IN THIS COACHING SESSION (oldest → newest) AND WHAT RYAN SAID AFTER EACH"]
    turns.forEach((t, i) => {
      lines.push(`Draft ${i + 1}${i === 0 ? " (from the gist above)" : ""}:`)
      lines.push(t.body.trim())
      const next = i + 1 < turns.length ? turns[i + 1].gist : gist
      lines.push(`Ryan's follow-up: "${next.trim()}"`)
      lines.push("")
    })
    lines.push("Apply exactly what his latest follow-up asks for and keep everything he did not change. The original gist still governs the numbers and the intent unless a follow-up changes them.")
    turnsBlock = `\n${lines.join("\n")}\n`
  }

  return `TODAY IS ${today}.

THE PLAN (the chips on the card; the reply must serve it)
  moment: ${plan.moment}${plan.temperature ? ` · temperature: ${plan.temperature}` : ""}${ctx.kind === "relationship" ? ` · contact type: ${category} · they ${plan.familiarity === "Reintro" ? "may not remember Ryan" : "know Ryan"}` : ""} · next action: ${plan.next_action}
  why this plan: ${plan.reason || "(not stated)"}

PRINCIPLES FOR THIS MOMENT (from Ryan's playbook)
${principles || "(no written principles yet for this moment — use judgment, the register examples, and Ryan's gist)"}

CONTACT
${describeContact(ctx)}
${ctx.kind === "relationship" && ctx.notes ? `Notes on this contact:\n${ctx.notes.slice(0, 3000)}\n` : ""}
FULL CONVERSATION (oldest → newest; "them" is the contact, "ryan" is Ryan, "ryan(drip)" is an automated touch; a "call transcript" row is a recorded live call with BOTH voices in it — read who says what from the words, not the label)
${formatThread(ctx, Math.max(16, ctx.thread.length))}

RYAN'S PAST REPLIES IN THIS KIND OF MOMENT (register and length only; a coached example shows the gist he gave and what he actually sent — match the register, never reuse its sentences or its specifics)
${exemplarText}

RYAN'S GIST (dictated; authoritative on numbers, decisions and intent; rough speech — apply the meaning, never quote it)
"${originalGist}"
${turnsBlock}
${coachChannelRules(channel)}

WHAT TO RETURN — JSON only: { "read": "...", "subject": ${channel === "email" ? '"..."' : "null"}, "body": "..." }
"read": 2 to 3 plain lines for Ryan, each a sentence, separated by newlines. Never sent. Cover: (1) what they said that matters, quoting their own words from the record; (2) what Ryan owes or promised them, and any open thread; (3) risks — anything in the gist that contradicts the record (a prior offer or number on the card, a stated floor, an owner or decision-maker who is not them, a promise Ryan already made). If the gist conflicts with the record, say so plainly here and still draft to the gist.
"body": the reply itself, in Ryan's voice, serving the plan and the gist.`
}

export async function coachDraft(args: CoachArgs): Promise<CoachResult | null> {
  if (!hasLlmKey()) return null
  const { ctx, channel } = args
  const gist = args.gist.trim()
  if (!gist) return null
  const turns = (args.turns ?? []).filter((t) => t && typeof t.gist === "string" && typeof t.body === "string" && t.body.trim())

  let plan: Plan | null = args.plan ?? null
  if (!plan) {
    plan = await proposePlan(ctx)
    if (!plan) return null
  }
  if (ctx.kind === "lead" && !args.skipStamp) await stampLeadMoment(ctx.clusterIds, plan.moment)

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
  })
  const exemplarText = formatExemplars(exemplars)
  const today = new Date().toISOString().slice(0, 10)
  const prompt = buildCoachPrompt({ ctx, plan, channel, gist, turns, principles, exemplarText, today })

  let read = ""
  let subject: string | null = null
  let body = ""
  try {
    const out = await completeText({
      model: OPUS, system: COACH_SYSTEM, prompt, maxTokens: COACH_MAX_TOKENS, thinking: true, effort: "high", tag: "[reply/coach]",
    })
    const parsed = JSON.parse(extractJsonObject(out.text)) as { read?: unknown; subject?: unknown; body?: unknown }
    body = typeof parsed.body === "string" ? parsed.body.trim() : ""
    read = typeof parsed.read === "string" ? parsed.read.trim() : ""
    subject = channel === "email" && typeof parsed.subject === "string" && parsed.subject.trim() ? parsed.subject.trim() : null
    if (subject) subject = subject.replace(/^(re:\s*)?subject:\s*/i, (m) => (/^re:/i.test(m) ? "Re: " : "")).trim() || subject
    if (!body) throw new Error("empty body")
  } catch (e) {
    console.error("[reply/coach] failed:", e instanceof Error ? e.message : String(e))
    return null
  }

  let critic: CriticVerdict | null = null
  if (!args.skipCritic) {
    const c = await critique({ ctx, plan, principles, subject, body, exemplars: exemplarText, gist: turns.length ? `${turns[0].gist}\n(follow-ups: ${[...turns.slice(1).map((t) => t.gist), gist].join(" / ")})` : gist })
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
      model: OPUS,
      prompt_version: COACH_PROMPT_VERSION,
      playbook_version: pb.version,
      why_text: null,
      parent_draft_id: args.parentDraftId || null,
      critic_json: critic,
      mode: "coach",
      gist,
      read_text: read || null,
    })
  }

  return { read, subject, body, draftId, plan, critic, playbookVersion: pb.version, promptVersion: COACH_PROMPT_VERSION, exemplarCount: exemplars.length }
}
