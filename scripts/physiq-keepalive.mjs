#!/usr/bin/env node
/**
 * Physiq Supabase keep-alive.
 *
 * The Physiq project (msmlqdrfsieixudgsced) is on Supabase's free tier, which
 * auto-pauses a project after ~7 days without API traffic. When that happens
 * the PWA silently falls back to its local cache and the Gym tab never appears
 * (it's revealed after a live load). This script runs every 2 days via launchd
 * (infrastructure/launchd/com.lrghomes.physiq-keepalive.plist):
 *
 *   1. Pings PostgREST with the anon key (counts as activity; RLS returns []).
 *   2. If the ping fails, checks project status via the Management API and
 *      restores it when INACTIVE — and alerts Telegram either way, because a
 *      pause means Ryan's app is stale and nobody would otherwise notice.
 *
 * Env (from .env.local in WorkingDirectory):
 *   NEXT_PUBLIC_PHYSIQ_SUPABASE_URL, NEXT_PUBLIC_PHYSIQ_SUPABASE_ANON_KEY,
 *   PHYSIQ_SUPABASE_PAT, PHYSIQ_SUPABASE_PROJECT_REF,
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (optional, for alerts)
 */
import fs from "node:fs"
import path from "node:path"

function loadEnv() {
  const p = path.resolve(process.cwd(), ".env.local")
  if (!fs.existsSync(p)) return
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m || process.env[m[1]]) continue
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    process.env[m[1]] = v
  }
}
loadEnv()

const URL_ = process.env.NEXT_PUBLIC_PHYSIQ_SUPABASE_URL
const ANON = process.env.NEXT_PUBLIC_PHYSIQ_SUPABASE_ANON_KEY
const PAT = process.env.PHYSIQ_SUPABASE_PAT
const REF = process.env.PHYSIQ_SUPABASE_PROJECT_REF || "msmlqdrfsieixudgsced"
const stamp = () => new Date().toISOString()

async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) return
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
  } catch {}
}

async function ping() {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000)
  try {
    const res = await fetch(`${URL_}/rest/v1/weight_entries?select=id&limit=1`, {
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}` }, signal: ctl.signal,
    })
    return { ok: res.ok, status: res.status }
  } catch (e) {
    return { ok: false, status: 0, err: e?.message ?? String(e) }
  } finally { clearTimeout(t) }
}

async function mgmt(method, pathname) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}${pathname}`, {
    method, headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
  })
  const text = await res.text()
  let json = null; try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text }
}

async function main() {
  if (!URL_ || !ANON) throw new Error("NEXT_PUBLIC_PHYSIQ_SUPABASE_URL / ANON_KEY missing (check .env.local)")
  const first = await ping()
  if (first.ok) { console.log(`${stamp()} ok — PostgREST ${first.status}`); return }
  console.log(`${stamp()} ping failed — HTTP ${first.status} ${first.err ?? ""}`)

  if (!PAT) throw new Error(`ping failed (HTTP ${first.status}) and PHYSIQ_SUPABASE_PAT missing — cannot check status`)
  const proj = await mgmt("GET", "")
  const status = proj.json?.status ?? `HTTP ${proj.status}`
  console.log(`${stamp()} project status: ${status}`)

  if (status === "INACTIVE") {
    const r = await mgmt("POST", "/restore")
    console.log(`${stamp()} restore → HTTP ${r.status} ${r.text.slice(0, 200)}`)
    await telegram(`🏋️ Physiq: Supabase had auto-paused (free tier). Keep-alive sent a restore (HTTP ${r.status}); app should be live again in ~2 min. If this keeps happening the ping cadence is too slow.`)
    return
  }
  await telegram(`⚠️ Physiq keep-alive: PostgREST ping failed (HTTP ${first.status}) and project status is ${status}. Check status.supabase.com, then \`node scripts/sb.mjs "select 1"\` in physiq-app.`)
  process.exit(1)
}

main().catch(async (e) => {
  console.error(`${stamp()} keep-alive crashed:`, e)
  await telegram(`🔥 Physiq keep-alive crashed: ${e?.message ?? e}`)
  process.exit(1)
})
