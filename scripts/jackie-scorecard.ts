// Jackie scorecard (2026-11-25): the same made-up callers against two or more
// of her scripts, several runs each, with the slips counted. One call by ear
// can't separate two scripts (she varies call to call, and a 1-in-5 slip
// hides behind a clean run); this is the count that goes with the listening.
//
// Callers are TTS voices on a clean line (scripts/jackie-rehearsal.ts), so
// this measures what she does, not how human she sounds. That part stays
// with Ryan's ear and real callers. No phone line, lead or drip is touched.
//
//   npx tsx --tsconfig ./tsconfig.json scripts/jackie-scorecard.ts                 # v1 vs v4, 5 runs each
//   … scripts/jackie-scorecard.ts --scripts v1,v3,v4 --runs 3 --only opt-out      # pick scripts / runs / scenarios
//   … scripts/jackie-scorecard.ts --send                                           # summary to the helper bot
//
// Output: /tmp/jackie-scorecard/<label>/ (every transcript + mp3, results.json,
// scorecard.txt). Env: OPENAI_VOICE_API_KEY (or OPENAI_API_KEY), ANTHROPIC_API_KEY.

import fs from "node:fs"
import path from "node:path"
import { JACKIE_LIVE_SCRIPT, type JackieScript } from "../lib/voiceTest"
import { jackieScriptSetup } from "../lib/jackieScriptV3"
import { completeText, extractJsonObject } from "../lib/llm"
import { sendOpsAlert } from "../lib/leads"
import { loadEnv, rehearse, type RehearseOpts, type Scenario } from "./jackie-rehearsal"
import { toPhoneMp3 } from "./jackie-audio"

const CALLER_PHONE = "+14085550142"

// needs: what Ryan needs from this caller (she should have asked for each one
// the caller didn't volunteer). chat: a caller she should get to know.
type Caller = Scenario & { needs: ("name" | "address" | "time")[]; chat: boolean; watch: string }

const CALLERS: Caller[] = [
  {
    id: "open-seller",
    about: "thinking about selling a rental; happy to talk about it",
    needs: ["name", "address", "time"], chat: true,
    watch: "She should get to know the house: at least one open question about it, real reactions, a follow-up or two.",
    lines: [
      "Hello?",
      "Yeah, I got your letter. I've been thinking about selling my rental.",
      "I've had it about twelve years. There's a tenant in it right now.",
      "She's been there five years. She's been great, honestly.",
      "It's in pretty good shape. The roof got done a few years back.",
      "Okay, sounds good.",
      "Thanks. Bye.",
    ],
    answers: { name: "My name's Linda.", address: "It's 1452 Willow Glen Way, in San Jose.", time: "Evenings are best, after six.", number: "Yes, this number is fine." },
  },
  {
    id: "closed-seller",
    about: "wants a number, gives short answers, then wants off the phone",
    needs: ["name", "address"], chat: false,
    watch: "No price. She should stop asking about the house after a short answer, and close in one turn after 'just have him call me'.",
    lines: [
      "Hello?",
      "I got your letter. What would he pay for my house?",
      "It's fine.",
      "A while.",
      "Not sure.",
      "Just have him call me.",
      "Okay. Bye.",
    ],
    answers: { name: "Kevin.", address: "88 Orchard Lane, Sunnyvale.", time: "Whenever.", number: "Yeah." },
  },
  {
    id: "asks-for-ryan",
    about: "opens by asking for Ryan (about one real call in three)",
    needs: ["name", "address", "time"], chat: false,
    watch: "She should keep him on the line: Ryan will call back, and she gets his name and the property.",
    lines: [
      "Hi, is Ryan there?",
      "Yeah, I got his letter. He can call me.",
      "Okay.",
      "Alright, thanks. Bye.",
    ],
    answers: { name: "This is Dennis.", address: "It's 27 Harbor Court, in Redwood City.", time: "Anytime this afternoon.", number: "Yeah, this one." },
  },
  {
    id: "opt-out",
    about: "gives the address up front, not selling, wants off the list, says bye fast",
    needs: [], chat: false,
    watch: "Short. The address was already given, so she shouldn't ask for it. No explanation of the mailing, nothing after the goodbye, no questions about the house.",
    lines: [
      "Hello?",
      "I got your letter for 412 Maple Street in San Jose. I'm not selling. Please take me off your list.",
      "Okay, thanks, bye.",
    ],
  },
  {
    id: "family-story",
    about: "inherited mom's house, brother lives in it, doesn't know what to do",
    needs: ["name", "address", "time"], chat: true,
    watch: "One short, sincere line for the loss. Interested follow-ups on what she's told. No advice about the brother or the estate.",
    lines: [
      "Hello?",
      "Hi. I got your letter. It's my mom's house. She passed last year, and my brother's still living in it.",
      "He's been there since she got sick. He doesn't really want to leave.",
      "I just don't know what to do with the place, honestly.",
      "Yeah, maybe Ryan could call me.",
      "Okay. Thank you. Bye.",
    ],
    answers: { name: "It's Maria.", address: "It's 930 Linden Avenue, in Santa Clara.", time: "Tomorrow morning is good.", number: "Yes, this number." },
  },
  {
    id: "not-selling",
    about: "asks whether we sent the letter, then isn't selling",
    needs: [], chat: false,
    watch: "She should answer the question, agree he doesn't have to sell, offer Ryan's call once at most, and never ask why he'd sell.",
    lines: [
      "Hello?",
      "Did you guys send me a letter about my house in Palo Alto?",
      "Why would I sell it? My family's owned it since 1951.",
      "No, I think I'm good. Thanks anyway.",
    ],
    answers: { name: "Jim.", address: "It's 3514 Emerson Street." },
  },
]

type ScriptSetup = { label: string; instructions: (hidden: boolean) => string; opts: RehearseOpts }
function setup(script: JackieScript): ScriptSetup {
  const label = script === "v1" ? "previous (v1)" : script === JACKIE_LIVE_SCRIPT ? `live (${script})` : script
  const one = jackieScriptSetup(script, CALLER_PHONE)
  return {
    label,
    instructions: (h) => jackieScriptSetup(script, h ? "Anonymous" : CALLER_PHONE).instructions,
    opts: one.newStyle ? { reasonNote: { channel: "thinking", content: one.reasonNote! }, backendInstructions: one.backendInstructions! } : {},
  }
}

// ─── Counting ────────────────────────────────────────────────────────────────

const STOCK: [string, RegExp][] = [
  ["what made you call", /what (made|brought|brings|has) you (decide to )?(call|calling|reach)/i],
  ["great question", /(great|good) question/i],
  ["not qualified", /not (actually )?qualified/i],
  ["pass that along", /pass (that|this|it|your \w+|the \w+) along/i],
  ["business day", /business day/i],
]

type Judged = {
  asked_name: boolean | null
  asked_address: boolean | null
  asked_time: boolean | null
  house_questions: number
  started_house_question: boolean
  reasons_questions: number
  asked_reason_of_non_seller: boolean
  reasked: string[]
  hollow_reactions: number
  specific_reactions: number
  questions_in_a_row: number
  advice_or_price: boolean
  talked_past_goodbye: boolean
  kept_asking_after_short_answers: boolean
  overall: number
}

async function judge(c: Caller, transcript: string): Promise<Judged | null> {
  const prompt = `Below is a phone call between "Jackie" (an AI receptionist for Ryan, a real estate investor who mails letters to homeowners) and a caller. Score what Jackie did. Judge only from the transcript.

The caller: ${c.about}.
The caller's lines were scripted in advance. A few lines (their name, the address, a callback time, "yes, this number") were held back and only said when Jackie asked for them. If the caller ignores one of her questions, that's the script, not her fault: don't count a repeat she made because her question went unanswered.

Return ONLY a JSON object with these keys:
- "asked_name": true if Jackie asked for the caller's name at any point, false if she never did, null if the caller gave it before she could ask.
- "asked_address": same, for the property address.
- "asked_time": same, for when Ryan should call.
- "house_questions": how many questions Jackie asked about the house, who lives there, the tenant or the caller's situation. Don't count the name, address, callback time, callback number, or "how can I help".
- "started_house_question": true if she asked a question about the house or the caller's situation BEFORE the caller had volunteered any detail about it beyond the bare fact of owning it or getting a letter.
- "reasons_questions": how many times she asked why they called, why they're selling, what has them thinking about it, what's going on with the property, or what's on their mind, in any wording.
- "asked_reason_of_non_seller": true if she asked a question like that of a caller who had NOT said they might sell.
- "reasked": list (short strings) of things she asked for again after the caller had already answered or already said them. Empty list if none.
- "hollow_reactions": how many of her replies were generic filler reactions that don't refer to anything specific the caller said ("that's great", "that helps", "that sounds like a lot", "great question", a bare "okay, got it" followed straight by her next question).
- "specific_reactions": how many of her replies referred to a particular thing the caller had just told her (the length of time, the person, the situation).
- "questions_in_a_row": the longest run of consecutive Jackie turns that each ended in a new question with no specific reaction in between.
- "advice_or_price": true if she gave a price, a range or an estimate, said a number was high or low, or advised the caller what to do. Offering that Ryan will call "with a number" is NOT giving a price.
- "talked_past_goodbye": true if, after the caller said goodbye or thanks-bye, she added a new question, an explanation, an apology or a recap (a plain goodbye back doesn't count).
- "kept_asking_after_short_answers": true if the caller gave curt answers like "It's fine", "A while", "Not sure" and she kept asking further questions about the house after the second one.
- "overall": 1 to 5. Would this caller come away feeling they'd talked to an attentive, natural person who got Ryan what he needs without wasting their time? 5 = yes, clearly. 3 = fine but mechanical or with a noticeable slip. 1 = annoying.

What to watch for on this call: ${c.watch}

TRANSCRIPT
${transcript}`
  try {
    const res = await completeText({ prompt, maxTokens: 900, thinking: false, tag: "[jackie-scorecard]" })
    return JSON.parse(extractJsonObject(res.text)) as Judged
  } catch (e) {
    console.error(`  judge failed: ${e instanceof Error ? e.message : e}`)
    return null
  }
}

type Result = {
  script: string; caller: string; run: number; transcript: string
  pickupRanOn: boolean; intros: number; stock: string[]; herWords: number; handoffs: number; slowestS: number | null
  judged: Judged | null
}

function measure(transcript: string): Pick<Result, "pickupRanOn" | "intros" | "stock" | "herWords"> {
  const rows = transcript.split("\n")
  const hers = rows.filter((l) => l.startsWith("Jackie:")).map((l) => l.slice(7).trim())
  // Everything she said before the caller's first word. "Hello?" (or "Hello? Hi.") is a pickup; more is running on.
  const greeting = rows[0]?.startsWith("Jackie:") ? rows[0].slice(7).trim() : ""
  const all = hers.join(" ")
  return {
    pickupRanOn: greeting.split(/\s+/).filter(Boolean).length > 2,
    intros: (all.match(/\b(this is|i'm|i am|it's|my name is|my name's) jackie\b/gi) ?? []).length,
    stock: STOCK.filter(([, re]) => re.test(all)).map(([name]) => name),
    herWords: all.split(/\s+/).filter(Boolean).length,
  }
}

async function pool<T>(jobs: (() => Promise<T>)[], size: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++
      out[i] = await jobs[i]()
    }
  }))
  return out
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] ?? null : null
}

// ─── Scorecard ───────────────────────────────────────────────────────────────

function scorecard(results: Result[], scripts: string[]): string {
  const of = (script: string, f: (r: Result) => boolean = () => true) => results.filter((r) => r.script === script && f(r))
  const frac = (rs: Result[], f: (r: Result) => boolean) => `${rs.filter(f).length}/${rs.length}`
  const avg = (rs: Result[], f: (r: Result) => number) => (rs.length ? (rs.reduce((a, r) => a + f(r), 0) / rs.length).toFixed(1) : "—")
  const judgedOnly = (rs: Result[]) => rs.filter((r) => r.judged)
  const needs = (k: "name" | "address" | "time") => (r: Result) => CALLERS.find((c) => c.id === r.caller)!.needs.includes(k)
  const chatty = (r: Result) => CALLERS.find((c) => c.id === r.caller)!.chat

  const rows: [string, (s: string) => string, string][] = [
    ["Picked up with just \"Hello?\" and waited", (s) => frac(of(s), (r) => !r.pickupRanOn), "higher is better"],
    ["Said her name more than once", (s) => frac(of(s), (r) => r.intros > 1), "lower"],
    ["Asked for the name (callers who needed a callback)", (s) => frac(judgedOnly(of(s, needs("name"))), (r) => r.judged!.asked_name !== false), "higher"],
    ["Asked for the address (same callers)", (s) => frac(judgedOnly(of(s, needs("address"))), (r) => r.judged!.asked_address !== false), "higher"],
    ["Asked for a callback time (same callers)", (s) => frac(judgedOnly(of(s, needs("time"))), (r) => r.judged!.asked_time !== false), "higher"],
    ["Asked about the house (the two chatty callers)", (s) => frac(judgedOnly(of(s, chatty)), (r) => r.judged!.house_questions > 0), "higher"],
    ["…house questions per chatty call", (s) => avg(judgedOnly(of(s, chatty)), (r) => r.judged!.house_questions), "2–4 is the target"],
    ["Asked about the house on the opt-out", (s) => frac(judgedOnly(of(s, (r) => r.caller === "opt-out")), (r) => r.judged!.house_questions > 0), "lower"],
    ["Kept digging after short answers (closed seller)", (s) => frac(judgedOnly(of(s, (r) => r.caller === "closed-seller")), (r) => r.judged!.kept_asking_after_short_answers), "lower"],
    ["Re-asked something already answered", (s) => frac(judgedOnly(of(s)), (r) => r.judged!.reasked.length > 0), "lower"],
    ["Asked why they called / why selling more than once", (s) => frac(judgedOnly(of(s)), (r) => r.judged!.reasons_questions > 1), "lower"],
    ["Asked that of someone who never said they'd sell", (s) => frac(judgedOnly(of(s)), (r) => r.judged!.asked_reason_of_non_seller), "lower"],
    ["Used a stock phrase", (s) => frac(of(s), (r) => r.stock.length > 0), "lower"],
    ["Hollow reactions per call", (s) => avg(judgedOnly(of(s)), (r) => r.judged!.hollow_reactions), "lower"],
    ["Specific reactions per call", (s) => avg(judgedOnly(of(s)), (r) => r.judged!.specific_reactions), "higher"],
    ["Three or more questions in a row", (s) => frac(judgedOnly(of(s)), (r) => r.judged!.questions_in_a_row >= 3), "lower"],
    ["Talked past a goodbye", (s) => frac(judgedOnly(of(s)), (r) => r.judged!.talked_past_goodbye), "lower"],
    ["Gave a price or advice", (s) => frac(judgedOnly(of(s)), (r) => r.judged!.advice_or_price), "must be 0"],
    ["Her words on the opt-out call", (s) => avg(of(s, (r) => r.caller === "opt-out"), (r) => r.herWords), "lower"],
    ["Backend hand-offs (all calls)", (s) => String(of(s).reduce((a, r) => a + r.handoffs, 0)), "lower"],
    ["Slowest reply, average (s)", (s) => avg(of(s, (r) => r.slowestS !== null), (r) => r.slowestS!), "lower"],
    ["Overall, 1–5 (judge's read)", (s) => avg(judgedOnly(of(s)), (r) => r.judged!.overall), "higher"],
  ]
  const w = Math.max(...rows.map((r) => r[0].length))
  const lines = [`${"".padEnd(w)}  ${scripts.map((s) => s.padEnd(14)).join("")}`]
  for (const [name, f, note] of rows) lines.push(`${name.padEnd(w)}  ${scripts.map((s) => f(s).padEnd(14)).join("")}(${note})`)
  lines.push("", "Overall by caller:")
  for (const c of CALLERS) lines.push(`  ${c.id.padEnd(16)}${scripts.map((s) => avg(judgedOnly(of(s, (r) => r.caller === c.id)), (r) => r.judged!.overall).padEnd(14)).join("")}`)
  return lines.join("\n")
}

async function main(): Promise<void> {
  loadEnv()
  const key = process.env.OPENAI_VOICE_API_KEY || process.env.OPENAI_API_KEY
  if (!key) throw new Error("OPENAI_VOICE_API_KEY / OPENAI_API_KEY missing")
  const scripts = (arg("--scripts") ?? "v1,v4").split(",") as JackieScript[]
  const runs = Math.max(1, Math.floor(Number(arg("--runs")) || 5))
  const only = arg("--only")?.split(",")
  const callers = only ? CALLERS.filter((c) => only.includes(c.id)) : CALLERS
  const size = Math.max(1, Math.floor(Number(arg("--concurrency")) || 6))
  const label = (arg("--label") ?? new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")).replace(/[^A-Za-z0-9._-]+/g, "_")
  const outDir = path.join("/tmp/jackie-scorecard", label)
  fs.mkdirSync(outDir, { recursive: true })
  const setups = scripts.map((s) => ({ id: s, ...setup(s) }))
  console.log(`Jackie scorecard — ${setups.map((s) => s.label).join(" vs ")}, ${callers.length} caller(s) × ${runs} run(s), ${size} at a time → ${outDir}\n`)

  const jobs: (() => Promise<Result>)[] = []
  for (const s of setups) for (const c of callers) for (let n = 1; n <= runs; n++) {
    jobs.push(async () => {
      const run = await rehearse(c, s.instructions(!!c.hiddenCallerId), key, s.opts)
      const waits = run.turns.map((t) => t.waitMs).filter((w): w is number => w !== null)
      const judged = await judge(c, run.transcript)
      const file = path.join(outDir, `${s.id}-${c.id}-run${n}`)
      try { toPhoneMp3(run.pcm, file) } catch (e) { console.error(`  mp3 failed: ${e instanceof Error ? e.message : e}`) }
      fs.writeFileSync(`${file}.txt`, `${s.label} · ${c.id} run ${n}: ${c.about}\n\n${run.transcript}\n\n${JSON.stringify(judged)}\n`)
      const r: Result = {
        script: s.label, caller: c.id, run: n, transcript: run.transcript, ...measure(run.transcript),
        handoffs: run.handoffs, slowestS: waits.length ? Math.max(...waits) / 1000 : null, judged,
      }
      console.log(`  done ${s.id} ${c.id} run ${n}: overall ${judged?.overall ?? "?"}${r.pickupRanOn ? " · ran on at pickup" : ""}${r.stock.length ? ` · stock: ${r.stock.join(", ")}` : ""}`)
      return r
    })
  }
  const results = await pool(jobs, size)
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 1))
  const card = scorecard(results, setups.map((s) => s.label))
  fs.writeFileSync(path.join(outDir, "scorecard.txt"), card)
  console.log(`\n${card}\n`)
  if (process.argv.includes("--send")) {
    const safe = card.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    await sendOpsAlert(`🧪 Jackie scorecard — ${setups.map((s) => s.label).join(" vs ")}, ${callers.length} callers × ${runs} runs\n<pre>${safe.slice(0, 3500)}</pre>`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
