// Jackie rehearsal (2026-11-05): scripted callers against a real GPT-Live
// session, no phone involved. GPT-Live has no text mode, so each caller line
// is synthesized with OpenAI TTS and streamed in as microphone audio at real
// time; Jackie's replies come back as transcript events. Each run is graded
// with the same review the real calls get (lib/jackie) and timed on the
// session timeline: caller line ends → her first word. (On this connection
// her audio deltas carry no timestamps; her transcript deltas do, word by
// word, on the same clock as the audio we stream in.)
//
// Touches no phone line, lead, drip or Telegram. Costs a minute or so of
// GPT-Live per scenario.
//
//   npx tsx --tsconfig ./tsconfig.json scripts/jackie-rehearsal.ts            # every scenario, current script
//   … scripts/jackie-rehearsal.ts --only not-selling,opt-out                  # some scenarios
//   … scripts/jackie-rehearsal.ts --script-from <git ref>                     # her script as of a commit (A/B)
//
// Env (from .env.local): OPENAI_VOICE_API_KEY (or OPENAI_API_KEY), and
// ANTHROPIC_API_KEY for the grading pass.

import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import WebSocket from "ws"
import {
  VOICE_TEST_BACKEND_EFFORT, VOICE_TEST_BACKEND_MODEL, VOICE_TEST_GREETING, VOICE_TEST_INSTRUCTIONS,
  VOICE_TEST_MODEL, VOICE_TEST_VOICE, callbackTimingNote, callerIdNote,
} from "../lib/voiceTest"
import { jackieCheckLine, reviewJackieCall } from "../lib/jackie"

type Scenario = { id: string; about: string; lines: string[] }

// Made-up callers shaped like real ones. Lines are fixed (the caller doesn't
// adapt), so each one must make sense whatever Jackie said before it.
const SCENARIOS: Scenario[] = [
  {
    id: "letter-question",
    about: "asks whether we sent the letter, then isn't selling",
    lines: [
      "Hi. Did you guys send me a letter about my house in Palo Alto?",
      "Why would I sell it? My family's owned it since 1951.",
      "No, I think I'm good. Thanks anyway.",
    ],
  },
  {
    id: "opt-out",
    about: "asks to come off the mailing list",
    lines: [
      "Hi, I got a letter from a Ryan LaRocca about my property. I'm not interested in selling. You can take me off the mailing list.",
      "It's 412 Seabright Avenue in Santa Cruz.",
      "Okay. Thank you.",
    ],
  },
  {
    id: "seller-tenant",
    about: "open to selling a rental with a tenant in it",
    lines: [
      "Hi, I got your letter. I've been thinking about selling my rental in San Jose.",
      "It's 1452 Willow Glen Way, San Jose. My name's Linda.",
      "There's a tenant in there right now. Would he buy it with someone living there?",
      "Evenings are best, after six.",
      "Yes, this number is fine.",
    ],
  },
  {
    id: "who-is-ryan",
    about: "asks if Ryan is a realtor, where we're based, what he does with houses",
    lines: [
      "Hi, I got a letter from you guys. Is Ryan a realtor?",
      "Where are you guys based out of?",
      "What does he do with the houses he buys?",
      "Okay. I'm not really selling, I was just curious. Thanks.",
    ],
  },
  {
    id: "how-did-you-get",
    about: "asks how we got their address, not upset",
    lines: [
      "Hi, yeah, how did you get my address?",
      "Huh, okay. I'm not really thinking about selling right now.",
      "No thanks. Bye.",
    ],
  },
]

const RATE = 24_000
const CHUNK_MS = 100
const CHUNK_BYTES = (RATE * 2 * CHUNK_MS) / 1000
const NO_REPLY_GIVE_UP_MS = 9_000 // she never started: move on and log it
// She's finished when no new words have come for this long. Her words
// arrive as she generates them, so a shorter wait cuts her off mid-thought.
// Only decides when the caller speaks next; reply times aren't affected.
const QUIET_AFTER_HER_MS = 2_500
const CALLER_PHONE = "+14085550142"

function arg(name: string): string | null {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] ?? null : null
}

function loadEnv(): void {
  const here = path.dirname(new URL(import.meta.url).pathname)
  for (const f of [path.resolve(here, "../.env.local"), path.resolve(process.cwd(), ".env.local")]) {
    if (fs.existsSync(f)) { process.loadEnvFile(f); return }
  }
}

/** Her script as of a git ref — VOICE_TEST_INSTRUCTIONS read straight from that commit's source. */
function instructionsAt(ref: string): string {
  const src = execFileSync("git", ["show", `${ref}:lib/voiceTest.ts`], { encoding: "utf-8" })
  const m = src.match(/export const VOICE_TEST_INSTRUCTIONS = `([\s\S]*?)`/)
  if (!m) throw new Error(`no VOICE_TEST_INSTRUCTIONS in ${ref}`)
  return m[1]
}

const ttsCache = path.join(process.env.TMPDIR || "/tmp", "jackie-rehearsal-tts")
async function speak(text: string, key: string): Promise<Buffer> {
  fs.mkdirSync(ttsCache, { recursive: true })
  const file = path.join(ttsCache, `${Buffer.from(text).toString("base64url").slice(0, 120)}.pcm`)
  if (fs.existsSync(file)) return fs.readFileSync(file)
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "ash", input: text, response_format: "pcm" }),
  })
  if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const pcm = trimTrailingSilence(Buffer.from(await res.arrayBuffer()))
  fs.writeFileSync(file, pcm)
  return pcm
}

// TTS ends with a stretch of silence; left in, it would count against her
// reply time. Cut 100 ms after the last loud sample.
function trimTrailingSilence(pcm: Buffer): Buffer {
  let last = -1
  for (let i = Math.floor(pcm.length / 2) - 1; i >= 0; i--) {
    if (Math.abs(pcm.readInt16LE(i * 2)) > 800) { last = i; break }
  }
  if (last < 0) return pcm
  return pcm.subarray(0, Math.min(pcm.length, (last + RATE / 10) * 2))
}

type Turn = { line: string; waitMs: number | null }

async function rehearse(sc: Scenario, instructions: string, key: string): Promise<{ transcript: string; turns: Turn[]; greetingMs: number | null; handoffs: number }> {
  const lines = await Promise.all(sc.lines.map(l => speak(l, key)))
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("wss://api.openai.com/v1/live/sessions", { headers: { Authorization: `Bearer ${key}` } })
    let sentMs = 0 // input timeline: ms of audio streamed so far
    let lastLoudEndMs = -1 // session timeline: end of her last word
    let firstLoudStartMs: number | null = null
    let heard = "" // her words since the last caller line
    const script: string[] = []
    const turns: Turn[] = []
    let lineIdx = -1 // -1 = waiting for her greeting
    let playing: Buffer | null = null
    let playPos = 0
    let lineEndMs = 0
    let replyStartMs: number | null = null
    let handoffs = 0
    let done = false
    let timer: ReturnType<typeof setInterval> | null = null

    const finish = () => {
      if (done) return
      done = true
      if (timer) clearInterval(timer)
      if (heard.trim()) script.push(`Jackie: ${heard.trim()}`)
      try { ws.send(JSON.stringify({ type: "session.close" })) } catch { /* closed */ }
      setTimeout(() => { try { ws.close() } catch { /* closed */ } }, 300)
      resolve({ transcript: script.join("\n"), turns, greetingMs: firstLoudStartMs, handoffs })
    }
    const startLine = (i: number) => {
      if (heard.trim()) script.push(`Jackie: ${heard.trim()}`)
      heard = ""
      lineIdx = i
      playing = lines[i]
      playPos = 0
      replyStartMs = null
      script.push(`Caller: ${sc.lines[i]}`)
    }

    let streamStart = 0
    // One 100 ms chunk of "microphone": the caller's line when it's their
    // turn, silence otherwise; then decide whether it's time for the next line.
    const sendChunk = () => {
      if (done) return
      let chunk = Buffer.alloc(CHUNK_BYTES)
      if (playing) {
        chunk = Buffer.concat([playing.subarray(playPos, playPos + CHUNK_BYTES), Buffer.alloc(CHUNK_BYTES)]).subarray(0, CHUNK_BYTES)
        playPos += CHUNK_BYTES
        if (playPos >= playing.length) { playing = null; lineEndMs = sentMs + CHUNK_MS }
      }
      ws.send(JSON.stringify({ type: "session.input_audio.append", audio: chunk.toString("base64") }))
      sentMs += CHUNK_MS
      if (playing) return
      const herQuiet = lastLoudEndMs >= 0 && sentMs - lastLoudEndMs >= QUIET_AFTER_HER_MS
      if (lineIdx === -1) {
        if (herQuiet || sentMs > 12_000) startLine(0)
        return
      }
      const replied = replyStartMs !== null
      if (replied && herQuiet) {
        if (lineIdx + 1 < lines.length) startLine(lineIdx + 1)
        else finish()
      } else if (!replied && sentMs - lineEndMs >= NO_REPLY_GIVE_UP_MS) {
        turns.push({ line: sc.lines[lineIdx], waitMs: null })
        if (lineIdx + 1 < lines.length) startLine(lineIdx + 1)
        else finish()
      }
    }

    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "session.start",
        session: {
          model: VOICE_TEST_MODEL,
          instructions,
          audio: { format: { type: "audio/pcm", rate: RATE }, output: { voice: VOICE_TEST_VOICE } },
          delegation: { type: "responses", responses: { model: VOICE_TEST_BACKEND_MODEL, reasoning: { effort: VOICE_TEST_BACKEND_EFFORT } } },
          input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: VOICE_TEST_GREETING }] }],
        },
      }))
    })
    ws.on("message", raw => {
      let m: Record<string, unknown>
      try { m = JSON.parse(String(raw)) } catch { return }
      switch (m.type) {
        case "session.started":
          ws.send(JSON.stringify({ type: "session.commentary.append", delegation_id: null, content: VOICE_TEST_GREETING }))
          // Stream the "microphone": caller lines when it's their turn, silence
          // otherwise. Paced by the wall clock, not by timer ticks — setInterval
          // runs late, and a stream that falls behind the session's clock makes
          // every reply look slower than the one before.
          streamStart = Date.now()
          timer = setInterval(() => {
            while (!done && sentMs + CHUNK_MS <= Date.now() - streamStart) sendChunk()
          }, CHUNK_MS / 4)
          break
        case "session.output_transcript.delta": {
          if (typeof m.delta === "string") heard += m.delta
          const start = typeof m.start_ms === "number" ? m.start_ms : null
          const end = typeof m.end_ms === "number" ? m.end_ms : null
          if (start === null || end === null || typeof m.delta !== "string" || !m.delta.trim()) break
          if (firstLoudStartMs === null) firstLoudStartMs = start
          lastLoudEndMs = Math.max(lastLoudEndMs, end)
          if (lineIdx >= 0 && !playing && replyStartMs === null && start >= lineEndMs) {
            replyStartMs = start
            turns.push({ line: sc.lines[lineIdx], waitMs: start - lineEndMs })
          }
          break
        }
        case "session.delegation.created":
          handoffs++
          break
        case "error":
          console.error(`  [${sc.id}] error: ${JSON.stringify(m.error ?? m).slice(0, 300)}`)
          break
        case "session.closed":
          finish()
          break
      }
    })
    ws.on("error", e => (done ? undefined : reject(e)))
    ws.on("close", () => finish())
    setTimeout(finish, 150_000)
  })
}

async function main(): Promise<void> {
  loadEnv()
  const key = process.env.OPENAI_VOICE_API_KEY || process.env.OPENAI_API_KEY
  if (!key) throw new Error("OPENAI_VOICE_API_KEY / OPENAI_API_KEY missing")
  const ref = arg("--script-from")
  const base = ref ? instructionsAt(ref) : VOICE_TEST_INSTRUCTIONS
  const instructions = base + callerIdNote(CALLER_PHONE) + callbackTimingNote()
  const only = arg("--only")?.split(",")
  const scenarios = only ? SCENARIOS.filter(s => only.includes(s.id)) : SCENARIOS
  console.log(`Jackie rehearsal — script ${ref ?? "working tree"} (${base.split(/\s+/).length} words), ${scenarios.length} scenario(s)\n`)
  for (const sc of scenarios) {
    const run = await rehearse(sc, instructions, key)
    const waits = run.turns.map(t => (t.waitMs === null ? "no reply" : `${(t.waitMs / 1000).toFixed(1)} s`))
    const review = await reviewJackieCall(run.transcript)
    const slow = run.turns.reduce<{ s: number; i: number } | null>((w, t, i) => (t.waitMs !== null && (!w || t.waitMs / 1000 > w.s) ? { s: t.waitMs / 1000, i } : w), null)
    const check = jackieCheckLine(review?.check, slow ? { slowest_s: slow.s, slowest_at_s: null } : null)
    console.log(`── ${sc.id}: ${sc.about}`)
    console.log(run.transcript.split("\n").map(l => `   ${l}`).join("\n"))
    console.log(`   greeting at ${run.greetingMs === null ? "—" : `${(run.greetingMs / 1000).toFixed(1)} s`} · replies: ${waits.join(", ")} · backend hand-offs: ${run.handoffs}`)
    console.log(`   not_selling=${review?.not_selling ?? "?"} opted_out=${review?.opted_out ?? "?"} intake_complete=${review?.intake_complete ?? "?"}`)
    console.log(`   ${check ?? "🔎 Check: clean"}\n`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
