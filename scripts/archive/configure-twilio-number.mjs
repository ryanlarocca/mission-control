#!/usr/bin/env node
// Configure a Twilio inbound number's Voice + SMS webhooks to point at
// Mission Control. Idempotent — re-run safely.
//
// Usage:
//   node scripts/configure-twilio-number.mjs +16506703914
//   DRY_RUN=1 node scripts/configure-twilio-number.mjs +16506703914
//
// Defaults the destination URLs to mission-control-three-chi.vercel.app;
// override with VOICE_URL and SMS_URL env vars if pointing elsewhere.

import { readFileSync } from "node:fs"

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "")
}

const SID = process.env.TWILIO_ACCOUNT_SID
const TOKEN = process.env.TWILIO_AUTH_TOKEN
if (!SID || !TOKEN) {
  console.error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN in .env.local")
  process.exit(1)
}

const phone = process.argv[2]
if (!phone || !phone.startsWith("+")) {
  console.error("Usage: node scripts/configure-twilio-number.mjs +1XXXXXXXXXX")
  process.exit(1)
}

const VOICE_URL = process.env.VOICE_URL || "https://mission-control-three-chi.vercel.app/api/leads/voice"
const SMS_URL   = process.env.SMS_URL   || "https://mission-control-three-chi.vercel.app/api/leads/sms"
const DRY = process.env.DRY_RUN === "1"

const auth = "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64")
const base = `https://api.twilio.com/2010-04-01/Accounts/${SID}/IncomingPhoneNumbers`

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: auth,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body,
  })
  const text = await res.text()
  if (!res.ok) {
    console.error(`Twilio ${method} ${url} → ${res.status}\n${text}`)
    process.exit(1)
  }
  return JSON.parse(text)
}

// 1. Look up PN SID
const list = await api("GET", `${base}.json?PhoneNumber=${encodeURIComponent(phone)}`)
const entry = (list.incoming_phone_numbers || [])[0]
if (!entry) {
  console.error(`No IncomingPhoneNumber found for ${phone}. Buy/port it first.`)
  process.exit(1)
}
console.log(`[twilio] found ${phone} → ${entry.sid} (${entry.friendly_name || "no friendly_name"})`)
console.log(`[twilio] current  VoiceUrl: ${entry.voice_url || "<empty>"}  (${entry.voice_method})`)
console.log(`[twilio] current  SmsUrl:   ${entry.sms_url   || "<empty>"}  (${entry.sms_method})`)

if (DRY) {
  console.log(`[twilio] DRY_RUN=1 — would POST VoiceUrl=${VOICE_URL}, SmsUrl=${SMS_URL}`)
  process.exit(0)
}

// 2. Update webhooks
const body = new URLSearchParams({
  VoiceUrl: VOICE_URL,
  VoiceMethod: "POST",
  SmsUrl: SMS_URL,
  SmsMethod: "POST",
}).toString()
const updated = await api("POST", `${base}/${entry.sid}.json`, body)
console.log(`[twilio] updated → VoiceUrl=${updated.voice_url}, SmsUrl=${updated.sms_url}`)

// 3. Re-fetch to verify (the POST response already echoes the new values,
//    but a fresh GET confirms persistence)
const verify = await api("GET", `${base}/${entry.sid}.json`)
const ok =
  verify.voice_url === VOICE_URL &&
  verify.voice_method === "POST" &&
  verify.sms_url === SMS_URL &&
  verify.sms_method === "POST"
console.log(`[twilio] verify  VoiceUrl: ${verify.voice_url}  (${verify.voice_method})`)
console.log(`[twilio] verify  SmsUrl:   ${verify.sms_url}    (${verify.sms_method})`)
if (!ok) {
  console.error("[twilio] verification mismatch — webhooks did not persist as expected")
  process.exit(1)
}
console.log(`[twilio] ✅ ${phone} (${entry.sid}) wired to Mission Control`)
