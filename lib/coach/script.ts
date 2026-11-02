// Pre-call script (Sales Coach, 2026-11-02). Opus reads the whole cluster
// and writes two things Ryan reads off the card while the call rings: the
// voicemail he'll leave if nobody picks up, and the live opener plus the
// three questions and the likely objection if they do. The hook is the
// person's own words from last time — "you called asking what I'd offer"
// — not a generic "any interest in selling". Ryan, after the Rita
// voicemail (2026-11-02): the message gave her no reason to call back.

import { completeText, extractJsonObject, hasLlmKey, OPUS } from "@/lib/llm"
import { formatPhone } from "@/lib/utils"
import { describeLeadContext, type LeadCoachContext } from "./context"

export interface CallScript {
  // One sentence: what they told us last time, in their words.
  hook: string
  // Spoken lines, in order. Under ~25 seconds read aloud.
  voicemail: string[]
  live: {
    opener: string
    questions: string[]
    objection: string
    answer: string
  }
  // One line of what not to do with this person. Optional.
  watchOut: string | null
  // The number the person sees on caller ID, as it should be spoken.
  numberToSay: string
  generatedAt: string
}

const SYSTEM = `You write call scripts for Ryan LaRocca of LRG Homes, a direct cash buyer of houses and small multifamily in the South Bay and Peninsula (Cupertino, San Jose, Santa Clara, Mountain View, Fremont). He sends letters to owners; some call or text back; he calls them back from the Mission Control card. He is reading your script off a phone screen while the call rings, so every line must be short enough to say in one breath.

Rules that come from his own coaching reviews:
- The first sentence after his name is the HOOK: what this person told us last time, in their words. "You called me last August asking what I'd offer on Sunrise Drive." Never open with "any interest in selling" or "just checking in".
- Give them a reason to call back: a number is ready, a question they asked has an answer, something changed. If they ever asked for a price, say he has one.
- Positioning is always "cash buyer" / "I buy directly, no agents, close on your timeline". Not "looking at homes in the area".
- No hedges. Ban: "I guess", "just", "checking in", "if you were", "I was wondering", "any interest".
- The voicemail says the callback number exactly twice: once right after his name, once at the end. Say it as digits with pauses, e.g. "650, 204, 3247". Use the number given below, never another.
- Voicemail length: 4 to 6 spoken lines, 25 seconds max.
- Live: the opener is two sentences at most (name, hook, why he's calling). Three discovery questions that fit THIS person (timeline, who decides, condition, what they'd need to make it work, what happened since last time). The single most likely objection from them given the history, and a one-breath answer to it.
- Use facts only from the context. Never invent prior conversations, letters or offers. If the history is thin, say so in the hook ("we traded messages a while back about Birch Avenue") rather than inventing detail.
- Plain spoken English. No headings, no emoji, no bullet characters inside strings.

Reply with ONLY a JSON object:
{"hook": string, "voicemail": [string, ...], "live": {"opener": string, "questions": [string, string, string], "objection": string, "answer": string}, "watch_out": string | null}`

export async function generateCallScript(ctx: LeadCoachContext, callerId: string): Promise<CallScript | null> {
  if (!hasLlmKey()) return null
  const numberToSay = formatPhone(callerId) ?? callerId
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date())
  const prompt = `Today is ${today}. Ryan is about to call this person. The number they will see on caller ID, and the number the voicemail must say twice, is ${numberToSay}.

CONTEXT
${describeLeadContext(ctx)}

Write the script.`
  try {
    const out = await completeText({ model: OPUS, system: SYSTEM, prompt, maxTokens: 8192, effort: "medium", tag: "[coach/script]" })
    const j = JSON.parse(extractJsonObject(out.text)) as {
      hook?: unknown; voicemail?: unknown; live?: { opener?: unknown; questions?: unknown; objection?: unknown; answer?: unknown }; watch_out?: unknown
    }
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")
    const list = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : [])
    const script: CallScript = {
      hook: str(j.hook),
      voicemail: list(j.voicemail),
      live: {
        opener: str(j.live?.opener),
        questions: list(j.live?.questions).slice(0, 4),
        objection: str(j.live?.objection),
        answer: str(j.live?.answer),
      },
      watchOut: str(j.watch_out) || null,
      numberToSay,
      generatedAt: new Date().toISOString(),
    }
    if (!script.voicemail.length || !script.live.opener) throw new Error("script missing voicemail or opener")
    return script
  } catch (e) {
    console.error("[coach/script] failed:", e instanceof Error ? e.message : String(e))
    return null
  }
}
