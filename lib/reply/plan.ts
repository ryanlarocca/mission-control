// Reply Planner — step one: propose the plan (moment, temperature, next
// action) before anything is drafted. Cheap Haiku call over the full
// context. The card shows these as three chips Ryan can change; the draft
// is always generated from whatever the chips say.

import { completeText, extractJsonObject, HAIKU, hasLlmKey } from "@/lib/llm"
import { TEMPERATURE_RUBRIC, VALID_TEMPERATURES, getLeadsClient } from "@/lib/leads"
import {
  LEAD_MOMENT_RUBRIC, LEAD_NEXT_ACTIONS, RELATIONSHIP_MOMENTS, RELATIONSHIP_NEXT_ACTIONS,
  isLeadMoment, isRelationshipMoment,
} from "./moments"
import { describeContact, formatThread, type ReplyContext } from "./context"

export interface Plan {
  moment: string
  temperature: string | null   // leads only
  next_action: string
  reason: string
  source: "ai" | "ryan"
  // Relationships only — the CRMS tab's two knobs travel with the plan.
  familiarity?: "Knows" | "Reintro" | null
  intent?: "CatchUp" | "Deal" | "Referral" | "Portfolio" | null
}

export const PLAN_PROMPT_VERSION = "plan-v1-2026-09-24"

export async function proposePlan(ctx: ReplyContext): Promise<Plan | null> {
  if (!hasLlmKey()) return null
  const today = new Date().toISOString().slice(0, 10)
  const prompt = ctx.kind === "lead"
    ? `You are planning Ryan's next move with a seller lead. Ryan is a cash home buyer in the Bay Area. Read the whole conversation, then decide the plan. Do NOT write the reply.

TODAY IS ${today}.

CONTACT
${describeContact(ctx)}

CONVERSATION (oldest → newest)
${formatThread(ctx, 20)}

Respond in JSON only:
{
  "moment": one of soft_no | hard_no_optout | question | invitation_to_talk | price_pushback | offer_requested | info_provided | silence_breaker | junk_wrong_person,
  "temperature": "hot" | "warm" | "cold",
  "next_action": one of ${LEAD_NEXT_ACTIONS.join(" | ")},
  "reason": "one short sentence, quoting their words where useful"
}

${LEAD_MOMENT_RUBRIC}

temperature:
${TEMPERATURE_RUBRIC}

next_action:
  reply_only         — answer them; nothing about cadence changes.
  long_term_nurture  — answer them AND move to the long-term nurture track (default after a soft_no).
  drip               — answer them and keep/start the standard drip (engaged but not ready to transact).
  schedule_call      — answer them and set a call reminder (they invited contact or asked for an offer).
  close_dead         — hard no / opt-out: no reply or a one-liner, then mark dead.
  junk               — wrong person / spam: no reply.`
    : `You are planning Ryan's next touch with a known contact (an agent, vendor, lender, or friend). Read the thread and the notes, then decide the plan. Do NOT write the message.

TODAY IS ${today}.

CONTACT
${describeContact(ctx)}
Notes: ${(ctx.notes || "(none)").slice(0, 1500)}

THREAD (oldest → newest)
${formatThread(ctx, 12)}

Respond in JSON only:
{
  "moment": one of ${RELATIONSHIP_MOMENTS.join(" | ")},
  "next_action": one of ${RELATIONSHIP_NEXT_ACTIONS.join(" | ")},
  "reason": "one short sentence"
}

moment:
  re_engagement — Ryan reaching out after a gap; nothing new from them.
  reply_to_them — they wrote last and are waiting on Ryan.
  life_event    — something happened for them (a sale, a baby, a move) worth acknowledging.
  referral_ask  — the point of the touch is to ask them to send deals or people.
  check_in      — light touch, no ask.`

  try {
    const out = await completeText({ model: HAIKU, prompt, maxTokens: 400, tag: "[reply/plan]" })
    const parsed = JSON.parse(extractJsonObject(out.text)) as Partial<Plan>
    const okMoment = ctx.kind === "lead" ? isLeadMoment(parsed.moment) : isRelationshipMoment(parsed.moment)
    if (!okMoment) return null
    const actions: readonly string[] = ctx.kind === "lead" ? LEAD_NEXT_ACTIONS : RELATIONSHIP_NEXT_ACTIONS
    const next_action = typeof parsed.next_action === "string" && actions.includes(parsed.next_action)
      ? parsed.next_action
      : ctx.kind === "lead" ? "reply_only" : "send"
    const temperature = ctx.kind === "lead" && typeof parsed.temperature === "string" && (VALID_TEMPERATURES as readonly string[]).includes(parsed.temperature)
      ? parsed.temperature
      : ctx.kind === "lead" ? ctx.temperature : null
    return {
      moment: parsed.moment as string,
      temperature,
      next_action,
      reason: typeof parsed.reason === "string" ? parsed.reason.trim() : "",
      source: "ai",
      ...(ctx.kind === "relationship" ? { familiarity: ctx.last_contacted_at ? "Knows" as const : "Reintro" as const, intent: null } : {}),
    }
  } catch (e) {
    console.error("[reply/plan] failed:", e instanceof Error ? e.message : String(e))
    return null
  }
}

/** Stamp the moment on every row of the lead's cluster so worklists and the drip engine see it. */
export async function stampLeadMoment(clusterIds: string[], moment: string): Promise<void> {
  if (!clusterIds.length) return
  try {
    const sb = getLeadsClient()
    const { error } = await sb.from("leads").update({ moment, moment_at: new Date().toISOString() }).in("id", clusterIds)
    if (error) console.error("[reply/plan] moment stamp failed:", error.message)
  } catch (e) {
    console.error("[reply/plan] moment stamp threw:", e instanceof Error ? e.message : String(e))
  }
}
