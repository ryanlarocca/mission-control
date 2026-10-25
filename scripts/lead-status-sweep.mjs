#!/usr/bin/env node
// Daily lead-status pass (Ryan 2026-10-24). Runs 8:05am PT on the Mac mini
// (launchd com.lrghomes.lead-status-sweep) and POSTs the auth-gated
// /api/leads/status-sweep route, which does the work in prod:
//   1. 30-day quiet rule — Active people who never answered Ryan → Nurture.
//      Ryan's personal-cell texts (The Pile, sidecar :5799) count as contact.
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
  // Ryan's personal-cell texts never reach `leads` — read them from The Pile
  // (sidecar on this mini) for every Active person so the 30-day quiet rule
  // sees them. A sidecar outage → send nothing for that phone and alert:
  // the rule then runs on Supabase rows only, like before 10-24.
  const personal = {}
  let pileErr = null
  try {
    const h = { apikey: process.env.LRG_SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.LRG_SUPABASE_SERVICE_KEY}` }
    const ar = await fetch(`${process.env.LRG_SUPABASE_URL}/rest/v1/leads?select=caller_phone&status=eq.active&caller_phone=not.is.null&limit=1000`, { headers: h })
    const phones = [...new Set((await ar.json()).map((r) => String(r.caller_phone).replace(/\D/g, "").slice(-10)).filter((p) => p.length === 10))]
    for (const p of phones) {
      const u = new URL("http://localhost:5799/pile/texts")
      u.searchParams.set("phone", p); u.searchParams.set("limit", "200"); u.searchParams.set("groups", "0")
      const tr = await fetch(u)
      if (!tr.ok) throw new Error(`pile/texts ${tr.status}`)
      const rows = await tr.json()
      personal[p] = { inbound: rows.filter((t) => !t.from_me).map((t) => t.at), outbound: rows.filter((t) => t.from_me).map((t) => t.at) }
    }
  } catch (e) {
    pileErr = e instanceof Error ? e.message : String(e)
    await alert(`⚠️ Lead-status pass couldn't read The Pile (${pileErr}) — today's 30-day quiet check ran without your personal-cell texts.`)
  }
  const r = await fetch(`${prodBase}/api/leads/status-sweep`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ personal }) })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`)
  console.log(new Date().toISOString(), JSON.stringify(body))
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e)
  console.error(new Date().toISOString(), "lead-status sweep failed:", msg)
  await alert(`⚠️ Daily lead-status pass didn't run — ${msg}`)
  process.exit(1)
}
