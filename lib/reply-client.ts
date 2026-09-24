// Reply Planner — client-side helpers shared by every composer (Leads card,
// Follow Ups modal, Relationships). Server logic lives in lib/reply/.

import {
  LEAD_MOMENTS, RELATIONSHIP_MOMENTS, LEAD_NEXT_ACTIONS, RELATIONSHIP_NEXT_ACTIONS,
} from "@/lib/reply/moments"

export interface Plan {
  moment: string
  temperature: string | null
  next_action: string
  reason: string
  source: "ai" | "ryan"
}

export interface DraftResponse {
  draftId: string | null
  subject: string | null
  body: string
  plan: Plan
  critic: { ok: boolean; issues: string[]; rewritten: boolean } | null
  playbookVersion: string
  exemplarCount: number
}

export const MOMENT_LABELS: Record<string, string> = {
  soft_no: "Soft no",
  hard_no_optout: "Hard no",
  question: "Question",
  invitation_to_talk: "Wants to talk",
  price_pushback: "Price pushback",
  offer_requested: "Wants an offer",
  info_provided: "Gave details",
  silence_breaker: "Silence breaker",
  junk_wrong_person: "Junk / wrong person",
  re_engagement: "Re-engage",
  reply_to_them: "Reply to them",
  life_event: "Life event",
  referral_ask: "Referral ask",
  check_in: "Check-in",
}

export const NEXT_ACTION_LABELS: Record<string, string> = {
  reply_only: "Reply only",
  long_term_nurture: "Long-term nurture",
  drip: "Standard drip",
  schedule_call: "Call reminder",
  close_dead: "Close (dead)",
  junk: "Junk",
  send: "Send",
  call: "Call",
  skip: "Skip",
}

export const TEMPERATURES = ["hot", "warm", "cold"] as const

export function momentOptions(kind: "lead" | "relationship"): readonly string[] {
  return kind === "lead" ? LEAD_MOMENTS : RELATIONSHIP_MOMENTS
}
export function nextActionOptions(kind: "lead" | "relationship"): readonly string[] {
  return kind === "lead" ? LEAD_NEXT_ACTIONS : RELATIONSHIP_NEXT_ACTIONS
}

/** Default next action when only a stored moment is known (no plan proposed yet). */
export function defaultNextAction(moment: string | null | undefined): string {
  switch (moment) {
    case "soft_no": return "long_term_nurture"
    case "hard_no_optout": return "close_dead"
    case "junk_wrong_person": return "junk"
    case "offer_requested":
    case "invitation_to_talk": return "schedule_call"
    default: return "reply_only"
  }
}

/** Suffix for the send button so it says what it will do. Null = plain send. */
export function sendSuffixFor(plan: Plan | null | undefined): string | null {
  switch (plan?.next_action) {
    case "long_term_nurture": return "+ nurture"
    case "drip": return "+ drip"
    case "schedule_call": return "+ call reminder"
    case "close_dead": return "+ close"
    case "junk": return "+ junk"
    default: return null
  }
}

export async function requestDraft(args: {
  leadId?: string
  relationshipId?: string
  channel: "email" | "sms" | "imessage"
  surface: "leads_card" | "followups" | "relationships" | "telegram"
  plan?: Plan | null
  why?: string | null
  parentDraftId?: string | null
  previousDraft?: { subject?: string | null; body: string } | null
}): Promise<DraftResponse> {
  const res = await fetch("/api/reply/draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      leadId: args.leadId, relationshipId: args.relationshipId, channel: args.channel, surface: args.surface,
      plan: args.plan ?? undefined, why: args.why ?? undefined, parentDraftId: args.parentDraftId ?? undefined,
      previousDraft: args.previousDraft ?? undefined,
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data as DraftResponse
}

/** "Send executes the plan": after a successful send, move status / drip / follow-up to match. */
export async function executePlan(leadId: string, plan: Plan | null | undefined): Promise<string | null> {
  if (!plan || !leadId) return null
  const post = (path: string) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
  const patch = (body: Record<string, unknown>) =>
    fetch("/api/leads", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: leadId, ...body }) })
  try {
    switch (plan.next_action) {
      case "long_term_nurture": {
        const r = await post(`/api/leads/${leadId}/long-term-nurture`)
        if (!r.ok && r.status !== 409) throw new Error((await r.json().catch(() => ({}))).error || `nurture HTTP ${r.status}`)
        return "Moved to long-term nurture"
      }
      case "drip": {
        const r = await post(`/api/leads/${leadId}/apply-drip`)
        if (!r.ok) {
          const err = (await r.json().catch(() => ({}))).error || ""
          if (!/already/i.test(err)) throw new Error(err || `drip HTTP ${r.status}`)
        }
        return "Drip running"
      }
      case "schedule_call": {
        const d = new Date(); d.setDate(d.getDate() + 1)
        const r = await patch({ recommended_followup_date: d.toISOString().slice(0, 10), followup_reason: "Call them (Reply Planner)" })
        if (!r.ok) throw new Error(`follow-up HTTP ${r.status}`)
        return "Call reminder set for tomorrow"
      }
      case "close_dead": {
        const r = await patch({ status: "dead" })
        if (!r.ok) throw new Error(`status HTTP ${r.status}`)
        return "Closed"
      }
      case "junk": {
        const r = await patch({ is_junk: true, status: "dead" })
        if (!r.ok) throw new Error(`junk HTTP ${r.status}`)
        return "Marked junk"
      }
      default:
        return null
    }
  } catch (e) {
    console.error("[reply-client] executePlan failed:", e)
    throw e
  }
}
