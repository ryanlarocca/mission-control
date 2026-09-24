// Reply Planner — the closed list of "moments" a reply can be answering
// (briefs/BRIEF_REPLY_PLANNER_2026-09-24.md). A moment is the first chip of
// the plan; the playbook (briefs/REPLY_PLAYBOOK.md) holds the principles for
// each. Dependency-free so lib/leads.ts can import the rubric for intake
// triage without a cycle.

export const LEAD_MOMENTS = [
  "soft_no",
  "hard_no_optout",
  "question",
  "invitation_to_talk",
  "price_pushback",
  "offer_requested",
  "info_provided",
  "silence_breaker",
  "junk_wrong_person",
] as const
export type LeadMoment = (typeof LEAD_MOMENTS)[number]

export const RELATIONSHIP_MOMENTS = [
  "re_engagement",
  "reply_to_them",
  "life_event",
  "referral_ask",
  "check_in",
] as const
export type RelationshipMoment = (typeof RELATIONSHIP_MOMENTS)[number]

export type Moment = LeadMoment | RelationshipMoment
export const ALL_MOMENTS: readonly Moment[] = [...LEAD_MOMENTS, ...RELATIONSHIP_MOMENTS]

export function isLeadMoment(m: unknown): m is LeadMoment {
  return typeof m === "string" && (LEAD_MOMENTS as readonly string[]).includes(m)
}
export function isRelationshipMoment(m: unknown): m is RelationshipMoment {
  return typeof m === "string" && (RELATIONSHIP_MOMENTS as readonly string[]).includes(m)
}
export function isMoment(m: unknown): m is Moment {
  return isLeadMoment(m) || isRelationshipMoment(m)
}

// Shared rubric text for every prompt that classifies a lead's latest
// message. Kept here so intake triage (email, call) and the on-demand
// planner agree on what each moment means.
export const LEAD_MOMENT_RUBRIC = `moment — what kind of moment the SENDER's latest message creates. Pick exactly one:
  soft_no            — declined without opting out: "not at this time", "not interested right now", "we're holding onto it".
  hard_no_optout     — explicit stop, hostile, unsubscribe, or a door-closing "good luck with your search".
  question           — they asked Ryan something (who he is, is this a form letter, how it works) and are waiting on the answer.
  invitation_to_talk — they proposed or asked for a call, a time, or a visit.
  price_pushback     — they quoted a higher number, an appraisal, an agent's opinion, or called the offer low.
  offer_requested    — they asked what Ryan would pay.
  info_provided      — they answered Ryan's questions (units, rents, condition) or gave a status update (accepted another offer, listed with an agent).
  silence_breaker    — nothing new from them; Ryan is the one reaching out after a quiet stretch.
  junk_wrong_person  — wrong number, spam, unrelated.
A message can touch two moments; choose the one the reply must answer first.`

// Next-action vocabulary — the third plan chip. Phase 2 wires "Send
// executes the plan" to these.
export const LEAD_NEXT_ACTIONS = [
  "reply_only",        // send the reply, no cadence change
  "long_term_nurture", // reply + move to the long-term nurture track
  "drip",              // reply + keep/start the standard drip
  "schedule_call",     // reply + follow-up reminder for a call
  "close_dead",        // no reply or a one-liner; mark dead
  "junk",              // mark junk, no reply
] as const
export type LeadNextAction = (typeof LEAD_NEXT_ACTIONS)[number]

export const RELATIONSHIP_NEXT_ACTIONS = ["send", "call", "skip"] as const
export type RelationshipNextAction = (typeof RELATIONSHIP_NEXT_ACTIONS)[number]
