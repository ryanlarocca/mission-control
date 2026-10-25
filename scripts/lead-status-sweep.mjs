#!/usr/bin/env node
// Daily lead-status pass (Ryan 2026-10-24). Runs 8:05am PT on the Mac mini
// (launchd com.lrghomes.lead-status-sweep) and POSTs the auth-gated
// /api/leads/status-sweep route, which does the work in prod:
//   1. 30-day quiet rule — Active people who never answered Ryan → Nurture.
//   2. One Telegram summary of every automatic move since yesterday (none on
//      a day nothing moved), each with a ↩️ Undo button.
// Logs in with MC_PASSWORD from .env.local (same as the rescue sweep's
// Phase C). A failure posts ⚠️ to Telegram so it never fails silently.
//
//   node scripts/lead-status-sweep.mjs
import { readFileSync } from "node:fs"

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) {
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    process.env[m[1]] = v
  }
}
const prodBase = "https://mission-control-three-chi.vercel.app"

async function alert(text) {
  const token = process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
  const chat = process.env.TELEGRAM_CHAT_ID
  if (!token || !chat) return
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text }),
  }).catch(() => {})
}

try {
  const pw = process.env.MC_PASSWORD
  if (!pw) throw new Error("MC_PASSWORD not set in .env.local")
  const lr = await fetch(`${prodBase}/api/auth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) })
  const cookie = (lr.headers.get("set-cookie") || "").split(";")[0]
  if (!lr.ok || !cookie) throw new Error(`login failed (HTTP ${lr.status})`)
  const r = await fetch(`${prodBase}/api/leads/status-sweep`, { method: "POST", headers: { Cookie: cookie } })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`)
  console.log(new Date().toISOString(), JSON.stringify(body))
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e)
  console.error(new Date().toISOString(), "lead-status sweep failed:", msg)
  await alert(`⚠️ Daily lead-status pass didn't run — ${msg}`)
  process.exit(1)
}
