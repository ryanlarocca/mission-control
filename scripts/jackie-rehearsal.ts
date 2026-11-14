// Jackie rehearsal (2026-11-05): scripted callers against a real GPT-Live
// session, no phone involved. GPT-Live has no text mode, so each caller line
// is synthesized with OpenAI TTS and streamed in as microphone audio at real
// time; Jackie's replies come back as transcript events. Each run is graded
// with the same review the real calls get (lib/jackie) and timed on the
// session timeline: caller line ends → her first word. (On this connection
// her audio deltas carry no timestamps; her transcript deltas do, word by
// word, on the same clock as the audio we stream in.)
//
// Every run is also recorded as ONE mono phone-quality mp3 (caller TTS and
// Jackie on a single timeline) so the owner can judge by ear:
// /tmp/jackie-rehearsal-audio/<label>/<scenario>-run<N>.mp3 + .txt
// (<label> = the --script-from ref, or "working-tree").
//
// Touches no phone line, lead or drip; Telegram only with --send. Costs a
// minute or so of GPT-Live per scenario run.
//
//   npx tsx --tsconfig ./tsconfig.json scripts/jackie-rehearsal.ts            # every scenario, current script
//   … scripts/jackie-rehearsal.ts --only not-selling,opt-out                  # some scenarios
//   … scripts/jackie-rehearsal.ts --script-from <git ref>                     # her script as of a commit (A/B)
//   … scripts/jackie-rehearsal.ts --runs 3                                    # each scenario 3 times (the voice varies)
//   … scripts/jackie-rehearsal.ts --send                                      # post every mp3 to Telegram as a voice note
//   … scripts/jackie-rehearsal.ts --send --send-only terse-owner,opt-out      # …only these scenarios (needs --send)
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
import { REASON_NOTE, asksReason } from "../lib/voiceCallMonitor"
import { sendVoice, toPhoneMp3 } from "./jackie-audio"

// hiddenCallerId: the call comes in blocked, so her script gets the "number is
// hidden, ask for the best number" note instead of a caller number.
type Scenario = { id: string; about: string; lines: string[]; hiddenCallerId?: boolean }

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
  {
    id: "call-my-cell",
    about: "11-10 Cornwallis call: gives the address up front, asks the price, then says to call her cell",
    lines: [
      "Yeah, you send me one letter. My address is 616 Cornwallis Lane, Foster City. Are you the realtor?",
      "How much you want to offer?",
      "Okay, call my cell phone. 650 343 9999. This one is my daughter's office.",
      "So you are the real estate office, or what kind of job?",
      "Okay. Bye.",
    ],
  },
  {
    id: "just-call-me",
    about: "might sell, gives no address, wants off the phone",
    lines: [
      "Hello?",
      "Yeah, I got your letter. I might be interested in selling. Just have Ryan call me.",
      "Okay, thanks. Bye.",
    ],
  },
  {
    id: "terse-owner",
    about: "11-13 call: asks for Ryan, names the property, short answers, asks if she's a computer, then gives his number and leaves",
    hiddenCallerId: true,
    lines: [
      "Speak to Ryan LaRocca, please.",
      "I'm responding to his letter regarding 318 Alder Way in Palo Alto.",
      "Good letter.",
      "I'm the owner, Walter Brandt.",
      "Are you a computer, or are you a person?",
      "He has my address, and he can call me at 650 555 0147, as late as 9 o'clock. Thank you. Have a good day.",
    ],
  },
  {
    id: "one-word-reason",
    about: "gives a one-word reason for calling, then cooperates",
    lines: [
      "Hi, I got a letter from you about my house.",
      "Just curious.",
      "It's 2207 Maple Court in Sunnyvale. I'm Denise.",
      "Mornings are fine, before ten.",
      "Yes, this number is good.",
      "Okay, thanks. Bye.",
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
const QUIET_AFTER_HER_MS = Number(process.env.REHEARSAL_QUIET_MS) || 2_500
const CALLER_PHONE = "+14085550142"
const GUARD = !process.argv.includes("--no-guard")

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
type Rehearsal = { transcript: string; turns: Turn[]; greetingMs: number | null; handoffs: number; pcm: Buffer; audioStats: string }

/**
 * The whole call as one mono track at RATE. The caller's mic stream is the
 * timeline (every chunk we sent, silence included). Her audio deltas carry no
 * timestamps, so each lands where it arrived but never overlaps her own
 * previous chunk. Overlap between the two parties is summed, then clamped.
 */
function mixCall(mic: Buffer[], her: { atMs: number; pcm: Buffer }[]): { pcm: Buffer; stats: string } {
  const bytesAt = (ms: number) => Math.round((ms * RATE) / 1000) * 2
  const placed: { at: number; pcm: Buffer }[] = []
  let cursor = 0
  for (const h of her) {
    const at = Math.max(bytesAt(h.atMs), cursor)
    placed.push({ at, pcm: h.pcm })
    cursor = at + h.pcm.length
  }
  const micPcm = Buffer.concat(mic)
  const total = Math.max(micPcm.length, cursor)
  const callerTrack = new Int32Array(total / 2), herTrack = new Int32Array(total / 2)
  for (let i = 0; i < micPcm.length / 2; i++) callerTrack[i] = micPcm.readInt16LE(i * 2)
  for (const p of placed) for (let i = 0; i < p.pcm.length / 2; i++) herTrack[(p.at + i * 2) / 2] = p.pcm.readInt16LE(i * 2)
  const out = Buffer.alloc(total)
  let clipped = 0
  for (let i = 0; i < total / 2; i++) {
    let v = callerTrack[i] + herTrack[i]
    if (v > 32767) { v = 32767; clipped++ } else if (v < -32768) { v = -32768; clipped++ }
    out.writeInt16LE(v, i * 2)
  }
  // Sanity numbers: RMS per second for each party (caller|Jackie), x100 of full scale.
  const secs = Math.ceil(total / 2 / RATE)
  const rms = (t: Int32Array, s: number) => {
    let sum = 0, n = 0
    for (let i = s * RATE; i < Math.min(t.length, (s + 1) * RATE); i++) { sum += t[i] * t[i]; n++ }
    return n ? Math.sqrt(sum / n) / 327.68 : 0
  }
  const perSec = Array.from({ length: secs }, (_, s) => `${rms(callerTrack, s).toFixed(0)}|${rms(herTrack, s).toFixed(0)}`)
  return { pcm: out, stats: `${(total / 2 / RATE).toFixed(1)} s, clipped samples: ${clipped}\nRMS per second (caller|Jackie, % of full scale): ${perSec.join(" ")}` }
}

async function rehearse(sc: Scenario, instructions: string, key: string): Promise<Rehearsal> {
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
    let reasonNoted = false
    let done = false
    let timer: ReturnType<typeof setInterval> | null = null
    const mic: Buffer[] = [] // everything we streamed in, one entry per chunk
    const herAudio: { atMs: number; pcm: Buffer }[] = []

    const finish = () => {
      if (done) return
      done = true
      if (timer) clearInterval(timer)
      if (heard.trim()) script.push(`Jackie: ${heard.trim()}`)
      try { ws.send(JSON.stringify({ type: "session.close" })) } catch { /* closed */ }
      setTimeout(() => { try { ws.close() } catch { /* closed */ } }, 300)
      const mixed = mixCall(mic, herAudio)
      resolve({ transcript: script.join("\n"), turns, greetingMs: firstLoudStartMs, handoffs, pcm: mixed.pcm, audioStats: mixed.stats })
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
      mic.push(chunk)
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
        case "session.output_audio.delta":
          if (typeof m.delta === "string") herAudio.push({ atMs: streamStart ? Date.now() - streamStart : 0, pcm: Buffer.from(m.delta, "base64") })
          break
        case "session.output_transcript.delta": {
          if (typeof m.delta === "string") heard += m.delta
          // The live watcher's reminder (lib/voiceCallMonitor REASON_NOTE): once
          // she's asked why they called, tell her it's spent. --no-guard = script alone.
          if (GUARD && !reasonNoted && asksReason(heard)) {
            reasonNoted = true
            ws.send(JSON.stringify({ type: "session.commentary.append", delegation_id: null, content: REASON_NOTE }))
          }
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

function oneLine(t: string): string { return t.replace(/\s+/g, " ").trim() }

async function main(): Promise<void> {
  loadEnv()
  const key = process.env.OPENAI_VOICE_API_KEY || process.env.OPENAI_API_KEY
  if (!key) throw new Error("OPENAI_VOICE_API_KEY / OPENAI_API_KEY missing")
  const ref = arg("--script-from")
  const base = ref ? instructionsAt(ref) : VOICE_TEST_INSTRUCTIONS
  const only = arg("--only")?.split(",")
  const scenarios = only ? SCENARIOS.filter(s => only.includes(s.id)) : SCENARIOS
  const runs = Math.max(1, Math.floor(Number(arg("--runs")) || 1))
  const send = process.argv.includes("--send")
  const sendOnly = arg("--send-only")?.split(",") ?? null
  if (sendOnly && !send) console.log("(--send-only only limits --send; nothing will be posted without --send)")
  const label = ref ? ref.replace(/[^A-Za-z0-9._-]+/g, "_") : "working-tree"
  const outDir = path.join("/tmp/jackie-rehearsal-audio", label)
  fs.mkdirSync(outDir, { recursive: true })
  console.log(`Jackie rehearsal — script ${ref ?? "working tree"} (${base.split(/\s+/).length} words), ${scenarios.length} scenario(s) × ${runs} run(s)\n`)

  type Row = { id: string; run: number; jackieTurns: number; handoffs: number; slowest: string; check: string | null; checkJson: string; mp3: string; caption: string }
  const rows: Row[] = []
  for (const sc of scenarios) {
    const instructions = base + callerIdNote(sc.hiddenCallerId ? "Anonymous" : CALLER_PHONE) + callbackTimingNote()
    for (let n = 1; n <= runs; n++) {
      const run = await rehearse(sc, instructions, key)
      const waits = run.turns.map(t => (t.waitMs === null ? "no reply" : `${(t.waitMs / 1000).toFixed(1)} s`))
      const review = await reviewJackieCall(run.transcript)
      const slow = run.turns.reduce<{ s: number; i: number } | null>((w, t, i) => (t.waitMs !== null && (!w || t.waitMs / 1000 > w.s) ? { s: t.waitMs / 1000, i } : w), null)
      const check = jackieCheckLine(review?.check, slow ? { slowest_s: slow.s, slowest_at_s: null } : null)
      console.log(`── ${sc.id} run ${n}/${runs}: ${sc.about}${sc.hiddenCallerId ? " [hidden caller ID]" : ""}`)
      console.log(run.transcript.split("\n").map(l => `   ${l}`).join("\n"))
      console.log(`   greeting at ${run.greetingMs === null ? "—" : `${(run.greetingMs / 1000).toFixed(1)} s`} · replies: ${waits.join(", ")} · backend hand-offs: ${run.handoffs}`)
      console.log(`   not_selling=${review?.not_selling ?? "?"} opted_out=${review?.opted_out ?? "?"} intake_complete=${review?.intake_complete ?? "?"}`)
      console.log(`   ${check ?? "🔎 Check: clean"}`)
      const checkJson = JSON.stringify(review?.check ?? null)
      console.log(`   check: ${checkJson}`)

      const file = path.join(outDir, `${sc.id}-run${n}`)
      toPhoneMp3(run.pcm, file)
      fs.writeFileSync(`${file}.txt`, `${label} · ${sc.id} run ${n}: ${sc.about}\n\n${run.transcript}\n\n${check ?? "Check: clean"}\ncheck: ${checkJson}\n\naudio: ${run.audioStats}\n`)
      console.log(`   audio: ${file}.mp3\n`)
      rows.push({
        id: sc.id, run: n, jackieTurns: run.transcript.split("\n").filter(l => l.startsWith("Jackie:")).length, handoffs: run.handoffs,
        slowest: slow ? `${slow.s.toFixed(1)} s` : "—", check, checkJson, mp3: `${file}.mp3`,
        caption: `${label} · ${sc.id} run ${n}${check ? `\n${check}` : ""}`,
      })
    }
  }

  console.log("── Summary")
  console.log(["scenario", "run", "turns", "hand-offs", "slowest", "check", "mp3"].join("\t"))
  for (const r of rows) console.log([r.id, r.run, r.jackieTurns, r.handoffs, r.slowest, r.check ? oneLine(r.check) : "clean", r.mp3].join("\t"))
  for (const r of rows) console.log(`   ${r.id} run ${r.run} check json: ${r.checkJson}`)
  console.log("Runs with a non-empty check line:")
  for (const sc of scenarios) console.log(`   ${sc.id}: ${rows.filter(r => r.id === sc.id && r.check).length}/${runs}`)

  if (send) {
    for (const r of rows.filter(x => !sendOnly || sendOnly.includes(x.id))) await sendVoice(r.mp3, r.caption)
    console.log("Posted to Telegram.")
  }
}

main().catch(e => { console.error(e); process.exit(1) })
