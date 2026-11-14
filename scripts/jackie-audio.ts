// Shared by scripts/jackie-rehearsal.ts: phone-quality mp3 encode + Telegram
// voice note. Same code as scripts/jackie-opener-samples.ts (copied, not
// imported — that script runs main() on import).
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"

const RATE = 24_000

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
export function toPhoneMp3(pcm: Buffer, out: string): void {
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

export async function sendVoice(file: string, caption: string): Promise<void> {
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
