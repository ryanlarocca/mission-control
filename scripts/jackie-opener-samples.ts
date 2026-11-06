/**
 * Jackie opener samples — record how she actually says each candidate opener,
 * through a real GPT-Live session (same model, voice and script as calls),
 * squeezed to phone quality (done in code; ffmpeg on the mini is broken), so Ryan can compare them by ear on Telegram.
 *
 *   npx tsx --tsconfig ./tsconfig.json scripts/jackie-opener-samples.ts [--send] [--only B,D]
 *
 * Writes /tmp/jackie-openers/<letter>.mp3 (+ .txt with what she said).
 * --send posts each as a MarketingBot voice note captioned with its letter.
 * Touches no phone line, lead or card. (Ryan 2026-11-06: "the opener is where
 * we lose them … she sounds like a recording.")
 */
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import WebSocket from "ws"
import {
  VOICE_TEST_BACKEND_EFFORT, VOICE_TEST_BACKEND_MODEL, VOICE_TEST_INSTRUCTIONS,
  VOICE_TEST_MODEL, VOICE_TEST_VOICE, callbackTimingNote, callerIdNote,
} from "../lib/voiceTest"

const RATE = 24_000
const CHUNK_MS = 100
const CHUNK_BYTES = (RATE * 2 * CHUNK_MS) / 1000
const OUT = "/tmp/jackie-openers"

type Sample = { id: string; label: string; greeting: string; voice?: string }

const verbatim = (line: string) => `Greet the caller now in English. Say: "${line}" Then pause and listen.`
const casual = (line: string) =>
  `Greet the caller now in English. Say: "${line}" Say it like a real person picking up her work cell between tasks: relaxed, friendly, normal speed. Then stop and listen.`

export const SAMPLES: Sample[] = [
  { id: "B", label: "Today's opener, same instruction as live calls", greeting: verbatim("Hey, this is Jackie with LRG Homes, how can I help you?") },
  { id: "C", label: "Today's words, told to say it casually", greeting: casual("Hey, this is Jackie with LRG Homes, how can I help you?") },
  { id: "D", label: "Her own words (no script line)", greeting: "Greet the caller now in English, in your own words: a short, casual hello that says you're Jackie with LRG Homes. One short sentence, the way you'd answer your work cell. Then stop and listen." },
  { id: "E", label: "\"Hi, this is Jackie, Ryan's assistant.\"", greeting: casual("Hi, this is Jackie, Ryan's assistant.") },
  { id: "F", label: "\"Hello, this is Jackie.\"", greeting: casual("Hello, this is Jackie.") },
  { id: "G", label: "\"Hello?\" — like answering a cell", greeting: casual("Hello?") },
  { id: "H", label: "\"Hi there, LRG Homes, Jackie speaking.\"", greeting: casual("Hi there, LRG Homes, Jackie speaking.") },
  { id: "I", label: "Today's opener in a different voice (coral)", greeting: verbatim("Hey, this is Jackie with LRG Homes, how can I help you?"), voice: "coral" },
  { id: "J", label: "Today's opener in a different voice (shimmer)", greeting: verbatim("Hey, this is Jackie with LRG Homes, how can I help you?"), voice: "shimmer" },
]

function loadEnv(): void {
  const here = path.dirname(new URL(import.meta.url).pathname)
  for (const f of [path.resolve(here, "../.env.local"), path.resolve(process.cwd(), ".env.local")]) {
    if (fs.existsSync(f)) { process.loadEnvFile(f); return }
  }
}

/** One GPT-Live session: stream silence, record her greeting, stop when she goes quiet. */
function recordOpener(s: Sample, instructions: string, key: string): Promise<{ pcm: Buffer; said: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("wss://api.openai.com/v1/live/sessions", { headers: { Authorization: `Bearer ${key}` } })
    const audio: Buffer[] = []
    let said = ""
    let lastWordAt = 0
    let started = 0
    let timer: ReturnType<typeof setInterval> | null = null
    let done = false
    const finish = () => {
      if (done) return
      done = true
      if (timer) clearInterval(timer)
      try { ws.send(JSON.stringify({ type: "session.close" })) } catch { /* closed */ }
      setTimeout(() => { try { ws.close() } catch { /* closed */ } }, 300)
      resolve({ pcm: Buffer.concat(audio), said: said.trim() })
    }
    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "session.start",
        session: {
          model: VOICE_TEST_MODEL,
          instructions,
          audio: { format: { type: "audio/pcm", rate: RATE }, output: { voice: s.voice ?? VOICE_TEST_VOICE } },
          delegation: { type: "responses", responses: { model: VOICE_TEST_BACKEND_MODEL, reasoning: { effort: VOICE_TEST_BACKEND_EFFORT } } },
          input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: s.greeting }] }],
        },
      }))
    })
    ws.on("message", raw => {
      let m: Record<string, unknown>
      try { m = JSON.parse(String(raw)) } catch { return }
      if (m.type === "session.started") {
        ws.send(JSON.stringify({ type: "session.commentary.append", delegation_id: null, content: s.greeting }))
        started = Date.now()
        const silence = Buffer.alloc(CHUNK_BYTES).toString("base64")
        let sent = 0
        timer = setInterval(() => {
          while (!done && sent * CHUNK_MS <= Date.now() - started) {
            ws.send(JSON.stringify({ type: "session.input_audio.append", audio: silence }))
            sent++
          }
          const now = Date.now()
          if (lastWordAt && now - lastWordAt > 1800) finish()
          else if (now - started > 12_000) finish()
        }, CHUNK_MS / 4)
      } else if (m.type === "session.output_audio.delta" && typeof m.delta === "string") {
        audio.push(Buffer.from(m.delta, "base64"))
      } else if (m.type === "session.output_transcript.delta" && typeof m.delta === "string") {
        said += m.delta
        if (m.delta.trim()) lastWordAt = Date.now()
      } else if (m.type === "error") {
        console.error(`  [${s.id}] error: ${JSON.stringify(m.error ?? m).slice(0, 300)}`)
      } else if (m.type === "session.closed") {
        finish()
      }
    })
    ws.on("error", e => (done ? undefined : reject(e)))
    ws.on("close", () => finish())
  })
}

// Phone line, done in code (ffmpeg on the mini is broken as of 11-06):
// band-limit to 300–3400 Hz, drop to 8 kHz, μ-law round trip — what a caller
// hears through Twilio — then trim silence and encode MP3 with lame.
function biquad(x: Float64Array, type: "lp" | "hp", f0: number, fs: number): Float64Array {
  const w = (2 * Math.PI * f0) / fs, cos = Math.cos(w), alpha = Math.sin(w) / (2 * Math.SQRT1_2)
  const b0 = type === "lp" ? (1 - cos) / 2 : (1 + cos) / 2
  const b1 = type === "lp" ? 1 - cos : -(1 + cos)
  const b2 = b0, a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha
  const y = new Float64Array(x.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v
  }
  return y
}
function muLaw(v: number): number {
  const MU = 255, s = Math.sign(v), a = Math.min(1, Math.abs(v))
  const q = Math.round(((Math.log(1 + MU * a) / Math.log(1 + MU)) * 127)) / 127
  return (s * (Math.pow(1 + MU, q) - 1)) / MU
}
function toPhoneMp3(pcm: Buffer, out: string): void {
  let x: Float64Array = new Float64Array(pcm.length / 2)
  for (let i = 0; i < x.length; i++) x[i] = pcm.readInt16LE(i * 2) / 32768
  for (const f of [3400, 3400]) x = biquad(x, "lp", f, RATE)
  for (const f of [300, 300]) x = biquad(x, "hp", f, RATE)
  const y: number[] = []
  for (let i = 0; i < x.length; i += 3) y.push(muLaw(x[i]))
  const loud = (v: number) => Math.abs(v) > 0.01
  let a = y.findIndex(loud), b = y.length - 1
  while (b > 0 && !loud(y[b])) b--
  if (a < 0) { a = 0; b = y.length - 1 }
  const pad = new Array(2400).fill(0) // 0.3 s each side
  const body = [...pad, ...y.slice(a, b + 1), ...pad]
  const data = Buffer.alloc(body.length * 2)
  body.forEach((v, i) => data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2))
  const hdr = Buffer.alloc(44)
  hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write("WAVE", 8); hdr.write("fmt ", 12)
  hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(8000, 24)
  hdr.writeUInt32LE(16000, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write("data", 36); hdr.writeUInt32LE(data.length, 40)
  fs.writeFileSync(`${out}.wav`, Buffer.concat([hdr, data]))
  execFileSync("lame", ["--quiet", "-b", "32", `${out}.wav`, `${out}.mp3`])
  fs.rmSync(`${out}.wav`)
}

async function sendVoice(file: string, caption: string): Promise<void> {
  const token = process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) throw new Error("no Telegram bot token / chat id")
  const form = new FormData()
  form.append("chat_id", chatId)
  form.append("voice", new Blob([new Uint8Array(fs.readFileSync(file))], { type: "audio/mpeg" }), path.basename(file))
  form.append("caption", caption)
  const res = await fetch(`https://api.telegram.org/bot${token}/sendVoice`, { method: "POST", body: form })
  if (!res.ok) throw new Error(`sendVoice ${res.status}: ${await res.text()}`)
}

async function main(): Promise<void> {
  loadEnv()
  const key = process.env.OPENAI_VOICE_API_KEY || process.env.OPENAI_API_KEY
  if (!key) throw new Error("OPENAI_VOICE_API_KEY not set")
  const only = (() => { const i = process.argv.indexOf("--only"); return i >= 0 ? process.argv[i + 1].split(",") : null })()
  const send = process.argv.includes("--send")
  fs.mkdirSync(OUT, { recursive: true })
  const instructions = VOICE_TEST_INSTRUCTIONS + callerIdNote("+14085550123") + callbackTimingNote()
  for (const s of SAMPLES.filter(x => !only || only.includes(x.id))) {
    const { pcm, said } = await recordOpener(s, instructions, key)
    const base = path.join(OUT, s.id)
    toPhoneMp3(pcm, base)
    fs.writeFileSync(`${base}.txt`, `${s.label}\n${said}\n`)
    console.log(`${s.id}  ${(pcm.length / (RATE * 2)).toFixed(1)}s raw  "${said}"   — ${s.label}`)
    if (send) await sendVoice(`${base}.mp3`, s.id)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
