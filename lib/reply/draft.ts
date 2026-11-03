// Reply Planner — step two: draft from the plan. Every surface calls this.
// Since 2026-11-03 it is the coach writer with no gist (lib/reply/coach.ts):
// Opus with thinking, the full thread, the playbook principles for the
// moment, Ryan's own past replies as register, and on a "Not right" redraft
// every note in the chain, not just the latest. The critic flags, never
// rewrites. The voice + channel rules below are shared with coach.ts and
// lib/inboxAgent.ts.

import { hasLlmKey } from "@/lib/llm"
import { getLeadsClient } from "@/lib/leads"
import type { ReplyContext } from "./context"
import type { CriticVerdict } from "./critic"
import type { Plan } from "./plan"
import { coachDraft, type CoachTurn } from "./coach"

export { AUTO_PROMPT_VERSION as DRAFT_PROMPT_VERSION } from "./coach"

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
  // Drips: the engine's rules for this touch (see coach.ts touchBrief).
  touchBrief?: string | null
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
  read?: string
}

// Voice + channel rules live in ./voice so coach.ts can import them
// without a runtime cycle (this file imports coachDraft).
export { VOICE_SYSTEM, channelRules } from "./voice"

/** Rebuild a "Not right" session as coach turns from the reply_drafts parent
 *  chain (oldest first): each turn is a draft plus the note that produced it
 *  (turns[0].gist = the root's gist, "" for an auto draft). Ryan's manual
 *  edits (model "ryan-edit") replace the body of the turn they edited. The
 *  newest body is what the card actually showed, when the caller has it. */
export async function loadDraftChain(parentDraftId: string, latestBody?: string | null): Promise<CoachTurn[]> {
  const sb = getLeadsClient()
  const rows: Array<{ id: string; parent_draft_id: string | null; draft_body: string | null; why_text: string | null; gist: string | null; model: string | null }> = []
  let id: string | null = parentDraftId
  const seen = new Set<string>()
  while (id && !seen.has(id) && rows.length < 12) {
    seen.add(id)
    type Row = (typeof rows)[number]
    const { data, error }: { data: Row | null; error: unknown } = await sb.from("reply_drafts").select("id, parent_draft_id, draft_body, why_text, gist, model").eq("id", id).maybeSingle()
    if (error || !data) break
    rows.push(data)
    id = data.parent_draft_id
  }
  rows.reverse()
  const turns: CoachTurn[] = []
  for (const r of rows) {
    const body = (r.draft_body ?? "").trim()
    if (!body) continue
    if (r.model === "ryan-edit" && turns.length) { turns[turns.length - 1].body = body; continue }
    turns.push({ gist: (r.why_text ?? r.gist ?? "").trim(), body })
  }
  if (turns.length && latestBody?.trim()) turns[turns.length - 1].body = latestBody.trim()
  return turns
}

/** Auto draft = the coach writer with no gist (2026-11-03). Same Opus model,
 *  thinking and full history as Coach. A "Not right" redraft carries every
 *  earlier note in the chain as a turn, so a fix already made stays made. */
export async function draftReply(args: DraftArgs): Promise<DraftResult | null> {
  if (!hasLlmKey()) return null
  const why = args.why?.trim() || ""
  let turns: CoachTurn[] = []
  if (why) {
    turns = args.parentDraftId ? await loadDraftChain(args.parentDraftId, args.previousDraft?.body ?? null) : []
    if (!turns.length && args.previousDraft?.body?.trim()) turns = [{ gist: "", body: args.previousDraft.body.trim() }]
  }
  const out = await coachDraft({
    ctx: args.ctx, plan: args.plan, channel: args.channel, surface: args.surface,
    gist: why, turns, auto: true,
    notes: args.notes ?? null, touchBrief: args.touchBrief ?? null,
    parentDraftId: args.parentDraftId ?? null, dripQueueId: args.dripQueueId ?? null,
    skipCritic: args.skipCritic, skipRecord: args.skipRecord, skipStamp: true,
    excludeExemplarReply: args.excludeExemplarReply ?? null,
  })
  if (!out) return null
  return {
    draftId: out.draftId, subject: out.subject, body: out.body, plan: out.plan, critic: out.critic,
    playbookVersion: out.playbookVersion, promptVersion: out.promptVersion, exemplarCount: out.exemplarCount, read: out.read,
  }
}
