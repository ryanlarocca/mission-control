// Pre-call script (Sales Coach, 2026-11-02). The model reads the whole cluster
// and writes two things Ryan reads off the card while the call rings: the
// voicemail he'll leave if nobody picks up, and the live opener plus the
// three questions and the likely objection if they do. The hook is the
// person's own words from last time — "you called asking what I'd offer"
// — not a generic "any interest in selling". Ryan, after the Rita
// voicemail (2026-11-02): the message gave her no reason to call back.

import { completeText, extractJsonObject, hasLlmKey, SONNET } from "@/lib/llm"
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
- The first sentence after his name is the HOOK: the reason this call makes sense to THEM. Never open with "any interest in selling" or "just checking in".
  - Recent contact (their last message under about 6 months old): use what they said, in their words. "You called me last August asking what I'd offer on Sunrise Drive."
  - Stale contact (older than that): they will not remember him. The hook is a soft reminder with an out, one fact at most, never their details quoted back at them. "We traded a few texts about a year ago about your duplex on Clearlake, you may not remember." Do NOT say "you texted me on July 11th" or "based on the rents you sent me" — that sounds like reading their file to them.
- Give them a reason to call back: a question they asked has an answer, he can put a number on it, something changed. If they ever asked for a price, say he can give them one.
- Ryan prices on the fly, on the phone. Never tell him to work out a number, run comps or look anything up before dialing, and never write the script as if a number is already computed. "I can give you a number on the call" is the promise; "I have a number ready based on X" is not.
- Say what he does in one plain clause, the way he says it (see his voice samples). No template lines: never "I buy directly, no agents, and close on your timeline" or any sentence that sounds like a sales script. If a sentence would make a stranger think "who talks like that", cut it.
- No hedges. Ban: "I guess", "just", "checking in", "if you were", "I was wondering", "any interest".
- The voicemail says the callback number exactly twice: once right after his name, once at the end. Never write the digits — write the token [NUMBER] where it goes ("this is Ryan with LRG Homes, [NUMBER]"). The code fills in the line he is calling from. If his voice samples below show [NUMBER], that is the same token.
- Voicemail length: 4 to 6 spoken lines, 25 seconds max.
- Live: the opener is two sentences at most (name, hook, why he's calling). Three discovery questions that fit THIS person (timeline, who decides, condition, what they'd need to make it work, what happened since last time). The single most likely objection from them given the history, and a one-breath answer to it.
- Use facts only from the context. Never invent prior conversations, letters or offers. If the history is thin, say so in the hook ("we traded messages a while back about Birch Avenue") rather than inventing detail.
- Write it in Ryan's voice. Below are real voicemails he has left; match his rhythm, his word choices and his level of formality — it is a crib sheet he reads in his own words, not copy. Keep the structure rules above; change the phrasing to sound like him.
- watch_out is for things that would embarrass him on the call (a wrong name, a line that changed, a person on title). It is never a to-do before dialing.
- Plain spoken English. No headings, no emoji, no bullet characters inside strings.

Reply with ONLY a JSON object:
{"hook": string, "voicemail": [string, ...], "live": {"opener": string, "questions": [string, string, string], "objection": string, "answer": string}, "watch_out": string | null}`

// A US phone number however it's written: "650, 204, 3247", "(650) 204-3247",
// "650-204-3247", "+1 650 204 3247", "6502043247".
const PHONE_RE = /(?:\+?1[\s,.-]*)?\(?\b(\d{3})\)?[\s,.-]*(\d{3})[\s,.-]*(\d{4})\b/g

// Every callback number in the script becomes the line Ryan is calling
// from, spoken as digits with pauses ("650, 436, 4279"). Covers the
// [NUMBER] token, any digits the model wrote anyway, and scripts cached
// before this fix — the route runs it on reused copies too. Only Ryan's
// own number ever belongs in what he reads, so every number is his line.
export function pinCallbackNumber(script: CallScript, callerId: string): CallScript {
  const d = callerId.replace(/\D/g, "").slice(-10)
  const spoken = d.length === 10 ? `${d.slice(0, 3)}, ${d.slice(3, 6)}, ${d.slice(6)}` : callerId
  const fix = (t: string) => t.replace(/\[NUMBER\]/gi, spoken).replace(PHONE_RE, spoken)
  return {
    ...script,
    hook: fix(script.hook),
    voicemail: script.voicemail.map(fix),
    live: {
      opener: fix(script.live.opener),
      questions: script.live.questions.map(fix),
      objection: fix(script.live.objection),
      answer: fix(script.live.answer),
    },
    watchOut: script.watchOut ? fix(script.watchOut) : null,
    numberToSay: formatPhone(callerId) ?? callerId,
  }
}

export async function generateCallScript(ctx: LeadCoachContext, callerId: string, voiceSamples: string[] = []): Promise<CallScript | null> {
  if (!hasLlmKey()) return null
  const numberToSay = formatPhone(callerId) ?? callerId
  // Ryan, 2026-11-11 (Russel): the voicemail said 650-204-3247 while he was
  // calling from 436-4279 — the model copied the number from his old
  // voicemails. It now writes [NUMBER] and pinCallbackNumber fills it in;
  // the samples go in with their numbers masked.
  voiceSamples = voiceSamples.map((v) => v.replace(PHONE_RE, "[NUMBER]"))
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date())
  const voice = voiceSamples.length
    ? `RYAN'S VOICE — real voicemails he left recently (match this, don't copy it):\n${voiceSamples.map((v, i) => `${i + 1}. ${v}`).join("\n")}`
    : "RYAN'S VOICE: no samples on file — plain, friendly, direct, first name only, no sales phrasing."
  const prompt = `Today is ${today}. Ryan is about to call this person. Write [NUMBER] wherever the callback number goes.

CONTEXT
${describeLeadContext(ctx)}

${voice}

Write the script.`
  try {
    // Sonnet since 2026-11-07 (API cost audit): prep Ryan skims, not words
    // that go out, and every card open warms one. Thinking stays on.
    const out = await completeText({ model: SONNET, system: SYSTEM, prompt, maxTokens: 8192, tag: "[coach/script]", lane: "drafts" })
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
    return pinCallbackNumber(script, callerId)
  } catch (e) {
    console.error("[coach/script] failed:", e instanceof Error ? e.message : String(e))
    return null
  }
}
