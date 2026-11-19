// Photo-brain smoke test (2026-11-18): QR decode + link fetch + the Opus
// planner on a local image, printing the plan JSON. Real Anthropic call;
// NOTHING is written — no Relationships insert, no calendar event, no
// Telegram message, no llm_usage row (the Supabase + bot env vars are
// dropped before the libs load).
//
//   npx tsx scripts/photo-brain-smoke.mjs <image.jpg|png> ["optional note"]
//
// Keys come from the main checkout's .env.local unless ENV_FILE points
// elsewhere (or ANTHROPIC_API_KEY is already set).

import { readFileSync, existsSync } from "node:fs"

const DEFAULT_ENV = "/Users/ryanlarocca/Projects/PROJECTS/mission-control/.env.local"
const envFile = process.env.ENV_FILE || DEFAULT_ENV
if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY_BACKGROUND && existsSync(envFile)) {
  process.loadEnvFile(envFile)
}
// Never touch prod from a smoke run.
for (const k of ["LRG_SUPABASE_URL", "LRG_SUPABASE_SERVICE_KEY", "CAMPAIGN_BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "SIDECAR_URL"]) {
  delete process.env[k]
}

const { gatherQr } = await import("../lib/photoQr.ts")
const { planPhoto } = await import("../lib/photoBrain.ts")

const [imagePath, ...noteParts] = process.argv.slice(2)
if (!imagePath) {
  console.error('usage: npx tsx scripts/photo-brain-smoke.mjs <image.jpg|png> ["optional note"]')
  process.exit(1)
}
const note = noteParts.join(" ")
const buf = readFileSync(imagePath)
const mediaType =
  buf[0] === 0x89 && buf[1] === 0x50 ? "image/png"
  : buf[0] === 0x47 && buf[1] === 0x49 ? "image/gif"
  : buf.slice(8, 12).toString() === "WEBP" ? "image/webp"
  : "image/jpeg"

const t0 = Date.now()
const qr = await gatherQr(buf)
const tQr = Date.now() - t0
console.log(`── QR (${tQr} ms): ${qr.findings.length} found`)
for (const f of qr.findings) {
  console.log(JSON.stringify({ kind: f.kind, payload: f.payload.slice(0, 300), finalUrl: f.finalUrl, card: f.card, fetchedChars: f.fetchedText?.length ?? 0, error: f.error }, null, 2))
}
for (const n of qr.notes) console.log(`ℹ️ ${n}`)

const t1 = Date.now()
const { plan, error } = await planPhoto({ image: { base64: buf.toString("base64"), mediaType }, note, qr: qr.findings })
console.log(`── plan (${Date.now() - t1} ms)${note ? ` — note: "${note}"` : ""}`)
if (error) {
  console.error(`❌ ${error}`)
  process.exit(2)
}
console.log(JSON.stringify(plan, null, 2))
