#!/usr/bin/env node
// Monday Telegram line for the Jackie coin-flip test (Ryan, 2026-10-25/27).
// launchd com.lrghomes.jackie-weekly, Mondays 8:40 am. Logs in with
// MC_PASSWORD (same as lead-status-sweep) and reads the scoreboard from
// /api/campaigns/jackie-test (lib/jackieScoreboard.ts). Quiet when the flip
// is off and no test call exists yet.

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

async function tg(text) {
  const token = process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
  const chat = process.env.TELEGRAM_CHAT_ID
  if (!token || !chat) throw new Error("Telegram not configured")
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text }),
  })
  if (!r.ok) throw new Error(`Telegram ${r.status}`)
}

const pct = (n) => (n === null || n === undefined ? "—" : `${Math.round(n * 100)}%`)

try {
  const pw = process.env.MC_PASSWORD
  if (!pw) throw new Error("MC_PASSWORD not set in .env.local")
  const lr = await fetch(`${prodBase}/api/auth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) })
  const cookie = (lr.headers.get("set-cookie") || "").split(";")[0]
  if (!lr.ok || !cookie) throw new Error(`login failed (HTTP ${lr.status})`)
  const r = await fetch(`${prodBase}/api/campaigns/jackie-test`, { headers: { cookie } })
  const d = await r.json()
  if (!r.ok) throw new Error(d?.error || `scoreboard HTTP ${r.status}`)
  const arm = (k) => d.arms.find((a) => a.arm === k)
  const total = d.arms.reduce((n, a) => n + a.callers, 0)
  if (!d.flip_on && total === 0) {
    console.log("flip off, no test calls — nothing to send")
    process.exit(0)
  }
  const j = arm("jackie"), v = arm("voicemail"), a = arm("answered")
  const line = (label, s) => `${label}: ${s.real}/${s.callers - s.pending} real (${pct(s.real_rate)})${s.pending ? `, ${s.pending} still in their 7 days` : ""}, ${s.dnc} DNC`
  const text = [
    `🤖 Jackie test, week of ${new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" })} — flip ${d.flip_on ? "ON" : "OFF"}`,
    line("Jackie", j),
    line("Your voicemail", v),
    `You answered: ${a.callers} first-time callers`,
    `Jackie's calls: ${j.jackie_hangups_under_15s ?? 0} hung up under 15 s, intake complete ${j.jackie_intake_complete ?? 0} of ${j.callers}, ${j.jackie_failed ?? 0} didn't connect`,
    `Real = you made contact within 7 days and they're not DNC or junk.`,
  ].join("\n")
  await tg(text)
  console.log(text)
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e)
  console.error(msg)
  await tg(`⚠️ Jackie Monday scoreboard failed: ${msg}`).catch(() => {})
  process.exit(1)
}
