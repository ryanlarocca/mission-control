#!/usr/bin/env node
/**
 * Agents line (650) 910-4007 — deterministic actions for any agent/human.
 *
 *   node scripts/agents-line.mjs call <number>              # relay call
 *   node scripts/agents-line.mjs text <number> <message...> # send SMS
 *
 * call: Twilio rings RYAN'S CELL from the agents line; when he answers it
 *   announces who it's connecting and dials them, showing the agents line
 *   as caller ID (same relay pattern as Mission Control's lead Call button).
 * text: sends an SMS from the agents line — suppression-guarded (STOP/DNC
 *   refuses), logged to the contact timeline.
 *
 * Built for the Telegram/OpenClaw agent: run these EXACTLY, never improvise
 * campaign actions another way. Numbers accept any format with 10+ digits.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")
for (const line of fs.readFileSync(path.join(REPO_ROOT, ".env.local"), "utf-8").split(/\r?\n/)) {
  const eq = line.indexOf("=")
  if (eq < 0 || line.trim().startsWith("#")) continue
  const key = line.slice(0, eq).trim()
  let val = line.slice(eq + 1).trim()
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
  if (process.env[key] === undefined) process.env[key] = val
}

const AGENTS_LINE = "+16509104007"
const RYAN_CELL = "+14085006293"
const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
})
const sid = process.env.TWILIO_ACCOUNT_SID
const token = process.env.TWILIO_AUTH_TOKEN
const twAuth = "Basic " + Buffer.from(`${sid}:${token}`).toString("base64")

const [cmd, numArg, ...rest] = process.argv.slice(2)
const digits = String(numArg ?? "").replace(/\D/g, "").slice(-10)
if (!cmd || !/^\d{10}$/.test(digits)) {
  console.error('usage: agents-line.mjs call <number> | text <number> <message...>')
  process.exit(1)
}
const fmt = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`

const { data: contacts } = await sb
  .from("campaign_contacts")
  .select("id, name")
  .or(`phone.eq.${digits},alt_phones.cs.{${digits}}`)
  .limit(1)
const contact = contacts?.[0] ?? null
const label = contact?.name ? `${contact.name} ${fmt}` : fmt

if (cmd === "call") {
  const twiml = `<Response><Dial callerId="${AGENTS_LINE}"><Number>+1${digits}</Number></Dial></Response>`
  // identity goes to Telegram instead of a spoken announcement (Ryan 2026-07-23)
  const tgToken = process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
  if (tgToken && process.env.TELEGRAM_CHAT_ID) {
    await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: `📞 Connecting you to ${label} — answer your cell (ringing now)` }),
    }).catch(() => {})
  }
  const form = new URLSearchParams({ To: RYAN_CELL, From: AGENTS_LINE, Twiml: twiml })
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: "POST",
    headers: { Authorization: twAuth, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  })
  if (!res.ok) {
    console.error(`FAILED: Twilio ${res.status}: ${(await res.text()).slice(0, 200)}`)
    process.exit(1)
  }
  await sb.from("campaign_events").insert({
    contact_id: contact?.id ?? null,
    kind: "note",
    caller_number: digits,
    body: `relay call started to ${label} (Ryan's cell rings first, then connects)`,
  })
  console.log(`✅ Calling Ryan's cell now — answer it and you'll be connected to ${label}. Their caller ID shows the agents line.`)
} else if (cmd === "text") {
  const body = rest.join(" ").trim()
  if (!body) {
    console.error("usage: agents-line.mjs text <number> <message...>")
    process.exit(1)
  }
  const { data: supp } = await sb
    .from("suppression")
    .select("id")
    .eq("phone", digits)
    .in("channel", ["sms", "all"])
    .limit(1)
  if ((supp ?? []).length > 0) {
    console.error(`REFUSED: ${label} is on the DNC / texted STOP — not sending.`)
    process.exit(1)
  }
  const form = new URLSearchParams({ To: `+1${digits}`, From: AGENTS_LINE, Body: body })
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: twAuth, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  })
  if (!res.ok) {
    console.error(`FAILED: Twilio ${res.status}: ${(await res.text()).slice(0, 200)}`)
    process.exit(1)
  }
  await sb.from("campaign_events").insert({
    contact_id: contact?.id ?? null,
    kind: "sms_out",
    caller_number: digits,
    body: body.slice(0, 1000),
    raw: { via: "agents-line-cli", from: AGENTS_LINE },
  })
  console.log(`✅ Texted ${label} from the agents line.`)
} else {
  console.error(`unknown command: ${cmd} (use call | text)`)
  process.exit(1)
}
