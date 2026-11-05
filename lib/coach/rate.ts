// Post-call rating (Sales Coach, 2026-11-02). Every call Ryan goes into —
// an outbound voicemail or conversation from either tab, an inbound call he
// answered — gets an Opus critique a minute or two after hang-up: a 1–10
// score against fixed anchors, what went well, what to improve, advice,
// and the line to say next time. Posted to the Marketing bot (the same
// chat as lead alerts) and stored as JSON on the call row so the weekly
// view can read it later. Skipped under 15 seconds, for Personal contacts,
// and for Jackie's calls.

import type { SupabaseClient } from "@supabase/supabase-js"
import { completeText, extractJsonObject, hasLlmKey, OPUS } from "@/lib/llm"
import { sendTelegramAlert, getLeadsClient } from "@/lib/leads"
import { formatPhone } from "@/lib/utils"
import {
  describeLeadContext, describeRelationshipContext, gatherLeadContext, gatherRelationshipContext,
} from "./context"
import type { CallScript } from "./script"

export const MIN_RATE_SEC = 15

export type RatedCallType = "voicemail" | "conversation" | "no_contact"

export interface CallRating {
  callType: RatedCallType
  score: number
  headline: string
  wentWell: string[]
  improve: string[]
  advice: string[]
  sayNextTime: string | null
  usedScript: boolean | null
  talkRatio: number | null
  model: string
  ratedAt: string
  separated: boolean
}

const SYSTEM = `You are the sales coach for Ryan LaRocca of LRG Homes, a direct cash buyer of houses and small multifamily in the South Bay and Peninsula. You review a recording of one call he just made or took, and send him a short rating on his phone. He asked for exactly this: a score out of ten, what he did well, what to improve, and training advice. Be direct and specific. Quote his actual words when you praise or correct. Never pad, never flatter, never moralize.

Scoring anchors (use the whole scale; the number must mean the same thing next month):
- 9–10: a hook that makes sense to the person (their own ask if recent; a soft "you may not remember" reminder if the contact is months old); says plainly that he buys houses for cash, in his own words; a number given when one was asked for, or promised on the call; a concrete next step or a reason to call back; no hedges; sounds like a normal person, not a script. Nothing to fix.
- 7–8: did most of that; one clear miss.
- 5–6: polite, clear, correct facts, but generic — no hook, no reason to act, soft ask.
- 3–4: hedging, apologetic, missed an obvious buying signal, no callback number on a voicemail, or quoting a stale exchange at someone as if they remember it.
- 1–2: unprepared, wrong facts, talked over them, or left nothing usable.

Things that are NOT points, ever:
- Template sales phrasing. "I buy directly, no agents, and close on your timeline" and lines like it earn nothing; if he sounds like he is reading a sales script, say so under improve. The test is "would a stranger hearing this find it normal."
- Having a number worked out before the call. Ryan prices on the fly, on the phone, by design. Never advise him to run comps, look up the house or prepare an offer before dialing. "I can give you a number on the call" is the right promise.

The record comes before your read of the transcript:
- The prompt may carry a block headed WHAT THE RECORD SHOWS (an appointment that was set, a number he gave, the agreed next step). Those are facts. Never write that he failed to do something the record shows he did. If an appointment was set, the close happened: credit it under went_well, and judge only how he got there.
- Before you write that he missed something (no number, no next step, no close, never asked a question), find the place in the transcript that proves it. A long call's key moment is often in the last few minutes; read to the end. If the transcript is one mixed block and you cannot tell who proposed a thing, do not assign it to the other person.
- Offering to meet and then letting the seller pick the time is a close. So is "if you want to keep talking, you have my number" when it is followed by the seller asking to meet and him naming a day and time.

Rapport:
- Small talk is not wasted time. Most of these sellers are older homeowners selling a house their family has lived in, and they sell to the person they trust. Judge rapport by what it produced: after it, did the person open up (family trouble, money, debt, the mortgage, who decides), stay on the line, ask to meet? If so the rapport worked. Say that under went_well, and do not count the minutes against him.
- When the seller is the one steering the small talk, following along is right. Flag rapport only when he kept it going after the seller tried to get to business, talked mostly about himself, or let a clear opening to turn to the house go by. A slow opening on a call that ended with a meeting and a number on the table is not a "clear miss".
- Reassurance about the thing that worries a seller (a relative or tenant who has to move out, an eviction, insurance, a lien, a mortgage payoff, "get your own attorney") is a deliberate part of how he builds trust. It is not "outside his lane" and not something to cut. Only when he promised a specific legal result or a timeline he does not control, say so in one line under improve, with no script.

Advice points forward:
- advice is about the NEXT step with this person, not a general lesson. If an appointment was set, advice is what to walk in knowing and what to settle at the meeting: who is on title, who else has to agree, who lives there and on what terms, what the seller needs the money for, anything the seller raised more than once that he did not follow up. Name the specific loose ends from this call.
- say_next_time is a line he can use at that next step (the meeting, the callback), not a redo of a moment that already went fine.

What to look at:
- VOICEMAIL: hook fits how long ago they last spoke (their words if recent; a reminder with an out if stale); reason to call back; said what he does in plain words; callback number said clearly, ideally twice; hedge words ("I guess", "just", "checking in", "any interest", "if you were"); natural register; length (under ~30 seconds is right).
- CONVERSATION: opening (after any small talk); whether he asked discovery questions (timeline, who decides, condition, what they need); talk ratio; whether a number was given when the person asked or when the moment was there; how objections were handled; buying signals he missed; whether a next step with a date was set; whether he confirmed the number/address.
- RELATIONSHIP calls (an agent, vendor, lender, investor): warmth, whether he asked about their business, whether he gave them a reason to think of him (buy box, speed of close), whether a next step or referral ask was made.
- If a script was shown, say whether he used it and whether that helped.
- If the transcript is speaker-separated, the lines are labelled; "Ryan:" is him. If it is one mixed block, say less about turn-taking and never guess who said what.
- If the recording is only a greeting, dead air, a wrong number, or a hang-up with no message, call_type is "no_contact", score it null, and keep the rest empty.

Reply with ONLY a JSON object:
{"call_type": "voicemail" | "conversation" | "no_contact", "score": 1-10 | null, "headline": one line, "went_well": [2-3 short strings], "improve": [2-3 short strings], "advice": [1-2 short strings], "say_next_time": one spoken line or null, "used_script": true | false | null}`

interface RawRating {
  call_type?: unknown; score?: unknown; headline?: unknown; went_well?: unknown; improve?: unknown; advice?: unknown; say_next_time?: unknown; used_script?: unknown
}

async function rateWithOpus(prompt: string, opts: { separated: boolean; talkRatio: number | null }): Promise<CallRating | null> {
  if (!hasLlmKey()) return null
  try {
    const out = await completeText({ model: OPUS, system: SYSTEM, prompt, maxTokens: 8192, effort: "medium", tag: "[coach/rate]" })
    const j = JSON.parse(extractJsonObject(out.text)) as RawRating
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")
    const list = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : [])
    const callType: RatedCallType = j.call_type === "voicemail" || j.call_type === "conversation" ? j.call_type : "no_contact"
    const scoreNum = typeof j.score === "number" ? Math.round(j.score) : NaN
    const score = Number.isFinite(scoreNum) ? Math.min(10, Math.max(1, scoreNum)) : 0
    return {
      callType,
      score,
      headline: str(j.headline),
      wentWell: list(j.went_well),
      improve: list(j.improve),
      advice: list(j.advice),
      sayNextTime: str(j.say_next_time) || null,
      usedScript: typeof j.used_script === "boolean" ? j.used_script : null,
      talkRatio: opts.talkRatio,
      model: OPUS,
      ratedAt: new Date().toISOString(),
      separated: opts.separated,
    }
  } catch (e) {
    console.error("[coach/rate] failed:", e instanceof Error ? e.message : String(e))
    return null
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function mmss(sec: number | null): string {
  if (!sec || sec <= 0) return ""
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return ` · ${m}:${String(s).padStart(2, "0")}`
}

export function formatRatingTelegram(r: CallRating, who: string, durationSec: number | null): string {
  const kind = r.callType === "voicemail" ? "voicemail" : "live call"
  const lines: string[] = [
    `🎯 <b>Call rating ${r.score}/10</b> — ${esc(who)} · ${kind}${mmss(durationSec)}`,
  ]
  if (r.headline) lines.push(esc(r.headline))
  if (r.wentWell.length) lines.push("", "✅ <b>Went well</b>", ...r.wentWell.map((s) => `• ${esc(s)}`))
  if (r.improve.length) lines.push("", "🔧 <b>Improve</b>", ...r.improve.map((s) => `• ${esc(s)}`))
  if (r.advice.length) lines.push("", "💡 <b>Advice</b>", ...r.advice.map((s) => `• ${esc(s)}`))
  if (r.sayNextTime) lines.push("", `🗣 <b>Say next time:</b> “${esc(r.sayNextTime)}”`)
  const foot: string[] = []
  if (r.usedScript === true) foot.push("used the script")
  if (r.usedScript === false) foot.push("script not used")
  if (r.talkRatio != null && r.callType === "conversation") foot.push(`you talked ${Math.round(r.talkRatio * 100)}%`)
  if (foot.length) lines.push("", `<i>${esc(foot.join(" · "))}</i>`)
  return lines.join("\n")
}

function scriptBlock(script: unknown): string {
  if (!script || typeof script !== "object") return "No script was shown for this call."
  const s = script as Partial<CallScript>
  const vm = Array.isArray(s.voicemail) ? s.voicemail.join(" ") : ""
  const live = s.live ? `Opener: ${s.live.opener}\nQuestions: ${(s.live.questions || []).join(" | ")}\nObjection: ${s.live.objection}\nAnswer: ${s.live.answer}` : ""
  return `Script shown on the card before the call:\nHook: ${s.hook || ""}\nVoicemail: ${vm}\n${live}`
}

// The whole call. Until 2026-11-05 the coach read the first 16,000
// characters — about 20 minutes — so on a 31-minute seller call it never saw
// the meeting being set and marked the close as missing. 90k covers a
// labelled two-hour call; past that the middle is dropped, never the end.
const TRANSCRIPT_MAX_CHARS = 90_000
export function clipTranscript(t: string): string {
  if (t.length <= TRANSCRIPT_MAX_CHARS) return t
  const head = Math.floor(TRANSCRIPT_MAX_CHARS * 0.4)
  const tail = TRANSCRIPT_MAX_CHARS - head
  return `${t.slice(0, head)}\n[…middle of the call not shown…]\n${t.slice(-tail)}`
}

/** What the call analysis established, as plain statements for the coach. */
export function callFacts(a: {
  appointment?: { date: string; time: string; location: string | null; with: string | null } | null
  offer_verbalized?: boolean
  offer_amount?: number | null
  followup_reason?: string | null
} | null | undefined): string[] {
  if (!a) return []
  const out: string[] = []
  if (a.appointment) {
    const ap = a.appointment
    out.push(`An in-person appointment was set on this call: ${ap.date} at ${ap.time}${ap.location ? `, at ${ap.location}` : ""}${ap.with ? `, with ${ap.with}` : ""}.`)
  }
  if (a.offer_verbalized && typeof a.offer_amount === "number" && a.offer_amount > 0) {
    out.push(`Ryan gave a number on this call: about $${Math.round(a.offer_amount).toLocaleString("en-US")}.`)
  }
  if (a.followup_reason) out.push(`Next step on the card: ${a.followup_reason}`)
  return out
}

function factsBlock(facts: string[] | undefined): string {
  const list = (facts ?? []).map((f) => f.trim()).filter(Boolean)
  if (!list.length) return ""
  return `\nWHAT THE RECORD SHOWS (from the call analysis — treat as true)\n${list.map((f) => `- ${f}`).join("\n")}\n`
}

async function storeRating(sb: SupabaseClient, table: "leads" | "relationship_touches", id: string, rating: CallRating): Promise<void> {
  const { error } = await sb.from(table).update({ coach_rating: rating }).eq("id", id)
  // The column arrives with supabase/migrations/2026-11-02_coach.sql; until
  // it is applied the rating still reaches Telegram — just log the miss.
  if (error) console.error(`[coach/rate] ${table}.coach_rating write failed (${id}): ${error.message}`)
}

/** Rate a Leads-tab call (outbound from the card, or an inbound call Ryan
 *  answered) and post it. Never throws. */
export async function rateLeadCall(args: {
  leadId: string
  callerPhone: string
  direction: "inbound" | "outbound"
  transcript: string
  separated: boolean
  talkRatio?: number | null
  durationSec: number | null
  // What the call analysis already established (appointment set, number
  // given, next step) — see callFacts in lib/leads. The coach is told these
  // are true so it cannot contradict the card.
  facts?: string[]
  // Rate only: nothing stored, nothing posted (replays of an old call).
  dryRun?: boolean
}): Promise<CallRating | null> {
  try {
    if ((args.durationSec ?? 0) < MIN_RATE_SEC) return null
    const sb = getLeadsClient()
    const ctx = await gatherLeadContext(sb, args.callerPhone)
    const { data: row } = await sb.from("leads").select("coach_script").eq("id", args.leadId).maybeSingle()
    const who = [ctx.name, ctx.propertyAddress].filter(Boolean).join(" · ") || (formatPhone(args.callerPhone) ?? args.callerPhone)
    const prompt = `CALL: ${args.direction === "outbound" ? "Ryan called this seller lead from the card" : "This seller lead called in and Ryan answered"}. Duration ${args.durationSec ?? "?"}s. Transcript is ${args.separated ? "speaker-separated" : "ONE MIXED BLOCK (both voices together)"}.

WHO THEY ARE
${describeLeadContext(ctx)}

${scriptBlock(row?.coach_script)}
${factsBlock(args.facts)}
TRANSCRIPT
${clipTranscript(args.transcript)}

Rate the call.`
    const rating = await rateWithOpus(prompt, { separated: args.separated, talkRatio: args.talkRatio ?? null })
    if (!rating) return null
    if (args.dryRun) return rating
    await storeRating(sb, "leads", args.leadId, rating)
    if (rating.callType === "no_contact" || rating.score === 0) {
      console.log(`[coach/rate] lead ${args.leadId}: no contact — not posting`)
      return rating
    }
    await sendTelegramAlert(formatRatingTelegram(rating, who, args.durationSec))
    return rating
  } catch (e) {
    console.error("[coach/rate] lead call threw:", e instanceof Error ? e.message : String(e))
    return null
  }
}

/** Rate a Relationships-tab call (click-to-call, or an office/agents-line
 *  call Ryan answered). Personal contacts are skipped. Never throws. */
export async function rateRelationshipCall(args: {
  touchId: string
  relationshipId: string
  kind: "outbound" | "inbound"
  transcript: string
  separated: boolean
  talkRatio?: number | null
  durationSec: number | null
}): Promise<CallRating | null> {
  try {
    if ((args.durationSec ?? 0) < MIN_RATE_SEC) return null
    const sb = getLeadsClient()
    const ctx = await gatherRelationshipContext(sb, args.relationshipId)
    if (ctx.category === "Personal") return null
    const prompt = `CALL: ${args.kind === "outbound" ? "Ryan called this contact from the Relationships card" : "This contact called Ryan's line and he answered"}. This is a RELATIONSHIP call (${ctx.category || "network contact"}), not a seller lead. Duration ${args.durationSec ?? "?"}s. Transcript is ${args.separated ? "speaker-separated" : "ONE MIXED BLOCK (both voices together)"}.

WHO THEY ARE
${describeRelationshipContext(ctx)}

No script was shown for this call.

TRANSCRIPT
${clipTranscript(args.transcript)}

Rate the call.`
    const rating = await rateWithOpus(prompt, { separated: args.separated, talkRatio: args.talkRatio ?? null })
    if (!rating) return null
    await storeRating(sb, "relationship_touches", args.touchId, rating)
    if (rating.callType === "no_contact" || rating.score === 0) return rating
    await sendTelegramAlert(formatRatingTelegram(rating, `${ctx.name}${ctx.category ? ` (${ctx.category})` : ""}`, args.durationSec))
    return rating
  } catch (e) {
    console.error("[coach/rate] relationship call threw:", e instanceof Error ? e.message : String(e))
    return null
  }
}
