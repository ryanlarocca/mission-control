// Reply Planner — the check before Ryan sees a draft. Plain questions the
// structural failures fail: re-pitching after a no, promising what the plan
// doesn't include, contradicting the thread, inventing a figure, copying an
// exemplar line. Flags only (2026-11-03): the draft always comes back
// unchanged. The rewrite used to run blind to Ryan's "Not right" notes and
// undid them — it rewrote 61% of Relationships drafts. The verdict is stored
// on the draft row (critic_json) and the issues surface on the card.

import { completeText, extractJsonObject, SONNET } from "@/lib/llm"
import { describeContact, formatThread, type ReplyContext } from "./context"
import type { Plan } from "./plan"
import { pacificDate } from "@/lib/pacificDate"

export interface CriticVerdict {
  ok: boolean
  issues: string[]
  rewritten: boolean
}

export async function critique(args: {
  ctx: ReplyContext
  plan: Plan
  principles: string | null
  subject: string | null
  body: string
  exemplars: string
  // Coach mode: Ryan's dictated gist. Figures and decisions in it are his,
  // not invented — question 4 must not fail them. Another contact's numbers
  // or phrases (from the register examples) still fail.
  gist?: string | null
}): Promise<{ verdict: CriticVerdict; subject: string | null; body: string }> {
  const { ctx, plan, principles, subject, body } = args
  const gist = args.gist?.trim() || null
  const today = pacificDate()
  const prompt = `TODAY IS ${today}. You are checking a reply before it is shown to Ryan (a cash home buyer in the Bay Area). Answer the questions honestly; most drafts should pass.

THE PLAN this reply must serve:
  moment: ${plan.moment}${plan.temperature ? ` · temperature: ${plan.temperature}` : ""} · next action: ${plan.next_action}
  reason: ${plan.reason || "(none)"}

PRINCIPLES for this moment:
${principles || "(none written yet — judge on the questions below only)"}

CONTACT DETAILS (facts the draft may use)
${describeContact(ctx)}
${gist ? `
RYAN'S GIST FOR THIS REPLY (he dictated it; every number, decision and promise in it is his and counts as a given fact, not an invention)
"${gist}"
` : ""}
CONVERSATION (oldest → newest; a "call transcript" row is a recorded live call with BOTH voices in it)
${formatThread(ctx, Math.max(16, ctx.thread.length))}

RYAN'S PAST REPLIES that were given as register examples (the draft may match their tone but must not copy their lines):
${args.exemplars}

THE DRAFT
${subject ? `Subject: ${subject}\n` : ""}${body}

QUESTIONS (a draft fails only when the answer is clearly yes)
1. If they declined, does the draft re-pitch, argue, reframe their answer, or offer a valuation/number they did not ask for?
2. Does it promise or set up something the plan's next action rules out (a call after close_dead, a quote after a soft no)? Asking for a call is fine when the next action is schedule_call or drip (a drip touch exists to get them on the phone), or when they asked for an offer.
3. Does it contradict something already said in the conversation, or re-ask a question they already answered?
4. Does it assert a figure, date, address detail, or personal fact that appears nowhere in the conversation, the contact details${gist ? ", or Ryan's gist" : ""}? A bracketed placeholder like [OFFER PRICE] is intentional and never a failure.${gist ? " A number from Ryan's gist is a given fact; a number from another contact's register example is a failure." : ""}
5. Does it lift a whole sentence from the register examples word for word? Sharing their tone, shape, or a common phrase is expected and is NOT a failure.
6. Does it clearly break a written principle above?

Respond in JSON only:
{ "ok": true | false, "issues": ["short phrase per failed question, empty if ok"] }
Default to ok:true. Do not rewrite the draft.`

  try {
    const out = await completeText({ model: SONNET, prompt, maxTokens: 1024, thinking: false, tag: "[reply/critic]", lane: "drafts" })
    const parsed = JSON.parse(extractJsonObject(out.text)) as { ok?: unknown; issues?: unknown }
    const issues = Array.isArray(parsed.issues) ? parsed.issues.filter((x): x is string => typeof x === "string") : []
    const ok = parsed.ok !== false || issues.length === 0
    return { verdict: { ok, issues: ok ? [] : issues, rewritten: false }, subject, body }
  } catch (e) {
    console.error("[reply/critic] failed (draft passed through):", e instanceof Error ? e.message : String(e))
    return { verdict: { ok: true, issues: ["critic unavailable"], rewritten: false }, subject, body }
  }
}
