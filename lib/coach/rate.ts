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
- 9–10: hook in the person's own words; clear cash-buyer positioning; a number given when one was asked for or promised with a time; a concrete next step or a reason to call back; no hedges; next step set. Nothing to fix.
- 7–8: did most of that; one clear miss.
- 5–6: polite, clear, correct facts, but generic — no hook, no reason to act, soft ask.
- 3–4: hedging, apologetic, wrong positioning, missed an obvious buying signal, or no callback number on a voicemail.
- 1–2: unprepared, wrong facts, talked over them, or left nothing usable.

What to look at:
- VOICEMAIL: hook used their words; reason to call back; cash-buyer line; callback number said clearly, ideally twice; hedge words ("I guess", "just", "checking in", "any interest", "if you were"); length (under ~30 seconds is right).
- CONVERSATION: opening; whether he asked discovery questions (timeline, who decides, condition, what they need); talk ratio; whether a number was given when the person asked or when the moment was there; how objections were handled; buying signals he missed; whether a next step with a date was set; whether he confirmed the number/address.
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

TRANSCRIPT
${args.transcript.slice(0, 16000)}

Rate the call.`
    const rating = await rateWithOpus(prompt, { separated: args.separated, talkRatio: args.talkRatio ?? null })
    if (!rating) return null
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
${args.transcript.slice(0, 16000)}

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
