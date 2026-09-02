#!/usr/bin/env node
/**
 * Seed test leads for the Phase 7B drip engine. Inserts one lead per
 * campaign type, back-dated so the next touch is due. Use --cleanup to
 * remove all rows tagged by this script (matches name LIKE '[TEST] %').
 *
 *   node scripts/seed-drip-test-leads.mjs            # seed
 *   node scripts/seed-drip-test-leads.mjs --cleanup  # delete test rows
 *
 * Approval-gate mode (DRIP_AUTO_SEND=false, the default) makes this safe —
 * the engine queues to drip_queue + Telegram, never actually sends until
 * Ryan taps Approve in Mission Control.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")
const ENV_PATH = path.join(REPO_ROOT, ".env.local")

function loadEnvLocal() {
  if (!fs.existsSync(ENV_PATH)) return
  for (const line of fs.readFileSync(ENV_PATH, "utf-8").split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith("#")) continue
    const eq = t.indexOf("=")
    if (eq < 0) continue
    const k = t.slice(0, eq).trim()
    let v = t.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (process.env[k] === undefined) process.env[k] = v
  }
}
loadEnvLocal()

const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
})

const HOUR = 3600 * 1000
const ago = (h) => new Date(Date.now() - h * HOUR).toISOString()

// Each test lead gets a UNIQUE phone + email so the activity check
// doesn't HOLD them on each other (sharing a contact across leads makes
// every sibling row look like recent conversation activity). Approval
// gate (DRIP_AUTO_SEND=false) means none of these actually send unless
// Ryan taps Approve in Mission Control — fake +1555 numbers are safe to
// use because the iMessage send would fail anyway, but the Telegram
// content preview still fires so Ryan can review the generated copy.
const PHONES = {
  form:    "+15551110001",
  call:    "+15551110002",
  sms:     "+15551110003",
}
const EMAILS = {
  form:        "test+gads_form@lrghomes.com",
  email_only:  "test+gads_email@lrghomes.com",
  email:       "test+dm_email@lrghomes.com",
}

const TEST_LEADS = [
  {
    name: "[TEST] Pat google_ads_form",
    description: "Google Ads form lead, touch 1 (30h iMessage) due",
    row: {
      name: "[TEST] Pat google_ads_form",
      email: EMAILS.form,
      caller_phone: PHONES.form,
      property_address: "123 Form Test Way, San Jose, CA",
      source: "Google Ads",
      source_type: "google_ads",
      twilio_number: null,
      lead_type: "form",
      status: "new",
      message: null,
      drip_campaign_type: "google_ads_form",
      drip_touch_number: 0,
      created_at: ago(31),
      last_drip_sent_at: ago(31),
    },
  },
  {
    name: "[TEST] Pat google_ads_email_only",
    description: "Google Ads email-only lead (no phone), touch 1 (30h email) due",
    row: {
      name: "[TEST] Pat google_ads_email_only",
      email: EMAILS.email_only,
      caller_phone: null,
      property_address: null,
      source: "Google Ads",
      source_type: "google_ads",
      twilio_number: "email:ryansvg@lrghomes.com",
      lead_type: "email",
      status: "new",
      message: "Subject: Re: Your inquiry\n\nHey, found you online — interested in a quote.",
      drip_campaign_type: "google_ads_email_only",
      drip_touch_number: 0,
      created_at: ago(31),
      last_drip_sent_at: ago(31),
    },
  },
  {
    name: "[TEST] Pat direct_mail_call (missed)",
    description: "Direct mail missed call (no recording), touch 0 (15-min msg) due",
    row: {
      name: "[TEST] Pat direct_mail_call missed",
      email: null,
      caller_phone: PHONES.call,
      property_address: null,
      source: "MFM-A",
      source_type: "direct_mail",
      twilio_number: "+16504364279",
      lead_type: "call",
      status: "new",
      message: null,
      recording_url: null,
      drip_campaign_type: "direct_mail_call",
      drip_touch_number: 0,
      created_at: ago(0.5),
      last_drip_sent_at: ago(0.5),
    },
  },
  {
    name: "[TEST] Pat direct_mail_sms",
    description: "Direct mail SMS lead, touch 1 (48h iMessage) due",
    row: {
      name: "[TEST] Pat direct_mail_sms",
      email: null,
      caller_phone: PHONES.sms,
      property_address: null,
      source: "MFM-B",
      source_type: "direct_mail",
      twilio_number: "+16506803671",
      lead_type: "sms",
      status: "new",
      message: "got your letter, what's the offer",
      drip_campaign_type: "direct_mail_sms",
      drip_touch_number: 0,
      created_at: ago(49),
      last_drip_sent_at: ago(49),
    },
  },
  {
    name: "[TEST] Pat direct_mail_email",
    description: "Direct mail email lead, touch 1 (48h email) due",
    row: {
      name: "[TEST] Pat direct_mail_email",
      email: EMAILS.email,
      caller_phone: null,
      property_address: "456 Mailer Test Ave, Oakland, CA",
      source: "SVG-A",
      source_type: "direct_mail",
      twilio_number: "email:ryansvg@lrghomes.com",
      lead_type: "email",
      status: "new",
      message: "Subject: Re: Your letter\n\nGot the postcard — what kind of offer are you giving for properties in Oakland?",
      drip_campaign_type: "direct_mail_email",
      drip_touch_number: 0,
      created_at: ago(49),
      last_drip_sent_at: ago(49),
    },
  },
]

async function seed() {
  console.log(`Seeding ${TEST_LEADS.length} test leads...`)
  for (const t of TEST_LEADS) {
    const { data, error } = await sb.from("leads").insert(t.row).select("id, name").single()
    if (error) {
      console.error(`  ✗ ${t.name}: ${error.message}`)
    } else {
      console.log(`  ✓ ${t.name} → ${data.id}`)
      console.log(`     ${t.description}`)
    }
  }
  console.log("\nNow run:  node scripts/drip-engine.js")
  console.log("Or wait for the hourly launchd kick.")
}

async function cleanup() {
  console.log("Cleaning up test leads...")
  const { data: leads, error } = await sb
    .from("leads")
    .select("id, name")
    .like("name", "[TEST]%")
  if (error) {
    console.error("  ✗ select failed:", error.message)
    process.exit(1)
  }
  if (!leads || leads.length === 0) {
    console.log("  (no test leads found)")
    return
  }
  console.log(`  Found ${leads.length} test row(s)`)
  // drip_queue cascade-deletes via ON DELETE CASCADE on lead_id, but
  // outbound drip log rows in the leads table itself don't share an FK.
  // Match them by phone / email / name pattern and delete those too.
  const ids = leads.map((l) => l.id)
  const { error: dqErr } = await sb.from("drip_queue").delete().in("lead_id", ids)
  if (dqErr) console.warn("  drip_queue cleanup warning:", dqErr.message)
  // Drip-sent log rows on the test contacts. We can't easily OR across
  // every test phone/email; instead, drop drip_* rows whose caller_phone
  // matches our +1555111000x prefix or whose email matches the test+ alias.
  await sb.from("leads").delete().like("caller_phone", "+1555111%").like("lead_type", "drip_%")
  await sb.from("leads").delete().like("email", "test+%@lrghomes.com").like("lead_type", "drip_%")
  // Now drop the seed leads themselves.
  const { error: leadErr } = await sb.from("leads").delete().in("id", ids)
  if (leadErr) {
    console.error("  ✗ delete failed:", leadErr.message)
    process.exit(1)
  }
  console.log(`  ✓ deleted ${ids.length} test lead(s) + their drip_queue/drip_* rows`)
}

const cmd = process.argv.includes("--cleanup") ? cleanup : seed
cmd().catch((e) => {
  console.error("fatal:", e)
  process.exit(1)
})
