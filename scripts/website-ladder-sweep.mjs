#!/usr/bin/env node
// Website call-ladder sweep (Ryan 2026-11-02, website leads are call-first).
// Runs every 5 minutes on the Mac mini (launchd com.lrghomes.website-ladder)
// and POSTs the auth-gated /api/leads/website-ladder/sweep route, which does
// the work in prod: next-attempt reminders, the 15-minute "still not called"
// nudge, ending ladders (→ website_followup drip after 3 unanswered calls),
// and the "sorry I missed your call" text on the Website line.
// Logs in with MC_PASSWORD from .env.local (same as lead-status-sweep.mjs).
// A failure posts ⚠️ to Telegram — at most once an hour, so a prod outage
// doesn't page every 5 minutes.
//
//   node scripts/website-ladder-sweep.mjs
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

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
const ALERT_STAMP = join(tmpdir(), "lrg-website-ladder-last-alert")

async function alert(text) {
  try {
    const last = Number(readFileSync(ALERT_STAMP, "utf8")) || 0
    if (Date.now() - last < 60 * 60 * 1000) return
  } catch { /* no stamp yet */ }
  const token = process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
  const chat = process.env.TELEGRAM_CHAT_ID
  if (!token || !chat) return
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text }),
  }).catch(() => {})
  writeFileSync(ALERT_STAMP, String(Date.now()))
}

try {
  const pw = process.env.MC_PASSWORD
  if (!pw) throw new Error("MC_PASSWORD not set in .env.local")
  const lr = await fetch(`${prodBase}/api/auth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) })
  const cookie = (lr.headers.get("set-cookie") || "").split(";")[0]
  if (!lr.ok || !cookie) throw new Error(`login failed (HTTP ${lr.status})`)
  const r = await fetch(`${prodBase}/api/leads/website-ladder/sweep`, { method: "POST", headers: { Cookie: cookie } })
  const body = await r.json().catch(() => ({}))
  if (!r.ok && r.status !== 207) throw new Error(body.error || `HTTP ${r.status}`)
  console.log(new Date().toISOString(), JSON.stringify(body))
  if (r.status === 207) await alert(`⚠️ Website-lead sweep hit errors — ${(body.errors || []).slice(0, 3).join(" · ")}`)
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e)
  console.error(new Date().toISOString(), "website-ladder sweep failed:", msg)
  await alert(`⚠️ Website-lead sweep didn't run — ${msg}. Website-lead call reminders are paused until it does.`)
  process.exit(1)
}
