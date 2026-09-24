// Reply Planner — the check before Ryan sees a draft. Plain questions the
// structural failures fail: re-pitching after a no, promising what the plan
// doesn't include, contradicting the thread, inventing a figure, copying an
// exemplar line. Returns the draft unchanged when it passes; rewritten once
// when it doesn't. The verdict is stored on the draft row (critic_json).

import { completeText, extractJsonObject, SONNET } from "@/lib/llm"
import { describeContact, formatThread, type ReplyContext } from "./context"
import type { Plan } from "./plan"

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
}): Promise<{ verdict: CriticVerdict; subject: string | null; body: string }> {
  const { ctx, plan, principles, subject, body } = args
  const prompt = `You are checking a reply before it is shown to Ryan (a cash home buyer in the Bay Area). Answer the questions honestly; most drafts should pass.

THE PLAN this reply must serve:
  moment: ${plan.moment}${plan.temperature ? ` · temperature: ${plan.temperature}` : ""} · next action: ${plan.next_action}
  reason: ${plan.reason || "(none)"}

PRINCIPLES for this moment:
${principles || "(none written yet — judge on the questions below only)"}

CONTACT DETAILS (facts the draft may use)
${describeContact(ctx)}

CONVERSATION (oldest → newest)
${formatThread(ctx, 12)}

RYAN'S PAST REPLIES that were given as register examples (the draft may match their tone but must not copy their lines):
${args.exemplars}

THE DRAFT
${subject ? `Subject: ${subject}\n` : ""}${body}

QUESTIONS (a draft fails only when the answer is clearly yes)
1. If they declined, does the draft re-pitch, argue, reframe their answer, or offer a valuation/number they did not ask for?
2. Does it promise or set up something the plan's next action rules out (a call after close_dead, a quote after a soft no)? Asking for a call when the next action is schedule_call, or when they asked for an offer, is fine.
3. Does it contradict something already said in the conversation, or re-ask a question they already answered?
4. Does it assert a figure, date, address detail, or personal fact that appears nowhere in the conversation or the contact details? A bracketed placeholder like [OFFER PRICE] is intentional and never a failure.
5. Does it lift a whole sentence from the register examples word for word? Sharing their tone, shape, or a common phrase is expected and is NOT a failure.
6. Does it clearly break a written principle above?

Respond in JSON only:
{ "ok": true | false, "issues": ["short phrase per failed question, empty if ok"], "subject": "<rewritten subject or null if unchanged/none>", "body": "<rewritten body if not ok, otherwise the draft unchanged>" }
Default to ok:true. Rewrite minimally: fix only what failed, keep Ryan's register, length, and any placeholders.`

  try {
    const out = await completeText({ model: SONNET, prompt, maxTokens: 4096, thinking: false, tag: "[reply/critic]" })
    const parsed = JSON.parse(extractJsonObject(out.text)) as { ok?: unknown; issues?: unknown; subject?: unknown; body?: unknown }
    const ok = parsed.ok === true
    const issues = Array.isArray(parsed.issues) ? parsed.issues.filter((x): x is string => typeof x === "string") : []
    if (ok || typeof parsed.body !== "string" || !parsed.body.trim()) {
      return { verdict: { ok: true, issues, rewritten: false }, subject, body }
    }
    const newSubject = typeof parsed.subject === "string" && parsed.subject.trim() ? parsed.subject.trim() : subject
    return { verdict: { ok: false, issues, rewritten: true }, subject: newSubject, body: parsed.body.trim() }
  } catch (e) {
    console.error("[reply/critic] failed (draft passed through):", e instanceof Error ? e.message : String(e))
    return { verdict: { ok: true, issues: ["critic unavailable"], rewritten: false }, subject, body }
  }
}
