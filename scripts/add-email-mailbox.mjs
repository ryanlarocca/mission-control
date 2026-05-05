#!/usr/bin/env node
/**
 * Add a new email mailbox to the lead-capture pipeline.
 *
 *   node scripts/add-email-mailbox.mjs <email> <campaign-label>
 *
 * Example:
 *   node scripts/add-email-mailbox.mjs ryansvk@lrghomes.com SVK-C
 *
 * What it does:
 *   1. Validates the email is on the lrghomes.com domain (DWD requirement).
 *   2. Reads config/email-campaigns.json, adds the new entry, writes it back.
 *   3. Calls gmail.users.watch on the new mailbox against the existing
 *      Pub/Sub topic so Gmail starts publishing INBOX events.
 *   4. Prints a reminder to `vercel deploy --prod` (the route imports the
 *      JSON at build time, so the new entry needs a fresh build to land).
 *
 * Required env (in .env.local or shell):
 *   GOOGLE_SERVICE_ACCOUNT_KEY   JSON service-account key (DWD on
 *                                lrghomes.com with gmail.modify scope)
 *
 * Idempotent — re-running with the same email is safe; the JSON entry
 * is upserted and gmail.users.watch is itself idempotent.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { google } from "googleapis"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")
const CAMPAIGNS_PATH = path.join(REPO_ROOT, "config", "email-campaigns.json")
const ENV_PATH = path.join(REPO_ROOT, ".env.local")
const TOPIC_NAME = "lrg-gmail-leads"
const ALLOWED_DOMAIN = "lrghomes.com"

function loadEnvLocal() {
  if (!fs.existsSync(ENV_PATH)) return
  for (const line of fs.readFileSync(ENV_PATH, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}

function die(msg, exitCode = 1) {
  console.error(`✗ ${msg}`)
  process.exit(exitCode)
}

async function main() {
  const [, , rawEmail, rawLabel] = process.argv
  if (!rawEmail || !rawLabel) {
    console.error("Usage: node scripts/add-email-mailbox.mjs <email> <campaign-label>")
    console.error("Example: node scripts/add-email-mailbox.mjs ryansvk@lrghomes.com SVK-C")
    process.exit(2)
  }
  const email = rawEmail.trim().toLowerCase()
  const label = rawLabel.trim()
  if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) {
    die(`Email must be on @${ALLOWED_DOMAIN} (DWD only authorized for that domain). Got: ${email}`)
  }
  if (!/^[A-Z0-9-]+$/i.test(label)) {
    die(`Campaign label must be alphanumeric + dashes (e.g. SVG-A, SVK-C). Got: ${label}`)
  }

  loadEnvLocal()
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!keyJson) die("GOOGLE_SERVICE_ACCOUNT_KEY is not set (check .env.local)")
  const credentials = JSON.parse(keyJson)
  const projectId = credentials.project_id
  if (!projectId) die("Service-account key has no project_id")

  // 1. Update JSON config
  const config = JSON.parse(fs.readFileSync(CAMPAIGNS_PATH, "utf-8"))
  const existingLabel = config[email]
  if (existingLabel === label) {
    console.log(`• ${email} already mapped to ${label} in ${path.relative(REPO_ROOT, CAMPAIGNS_PATH)} (no change)`)
  } else if (existingLabel) {
    console.log(`• ${email} was mapped to ${existingLabel}, updating to ${label}`)
    config[email] = label
  } else {
    console.log(`• adding ${email} → ${label} to ${path.relative(REPO_ROOT, CAMPAIGNS_PATH)}`)
    config[email] = label
  }
  // Sort keys so the JSON diff stays clean across adds.
  const sorted = Object.fromEntries(Object.entries(config).sort(([a], [b]) => a.localeCompare(b)))
  fs.writeFileSync(CAMPAIGNS_PATH, JSON.stringify(sorted, null, 2) + "\n")
  console.log(`✓ wrote ${path.relative(REPO_ROOT, CAMPAIGNS_PATH)}`)

  // 2. Register the Gmail watch
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    subject: email,
  })
  const gmail = google.gmail({ version: "v1", auth })
  const topicPath = `projects/${projectId}/topics/${TOPIC_NAME}`
  try {
    const { data } = await gmail.users.watch({
      userId: email,
      requestBody: {
        topicName: topicPath,
        labelIds: ["INBOX"],
        labelFilterAction: "include",
      },
    })
    const expiry = data.expiration ? new Date(Number(data.expiration)).toISOString() : "(unknown)"
    console.log(`✓ Gmail watch registered for ${email} — historyId=${data.historyId} expires=${expiry}`)
  } catch (e) {
    const status = e.code || e.response?.status
    const msg = e.errors?.[0]?.message || e.response?.data?.error?.message || e.message
    die(`Gmail watch failed for ${email} (${status}): ${msg}\n   Check that ${email} exists in the Workspace and that DWD covers gmail.modify.`)
  }

  console.log("")
  console.log("Next:")
  console.log("  1. Deploy so the route picks up the new mailbox:")
  console.log("       npx vercel deploy --prod")
  console.log("  2. Send a probe email TO this mailbox FROM another address and confirm")
  console.log("     a row appears in the Supabase leads table with source=" + label + ".")
  console.log("  3. The Mac mini renewal cron picks up the new mailbox automatically")
  console.log("     on its next run (config is read from JSON each time).")
}

main().catch((e) => {
  console.error("add-email-mailbox failed:", e)
  process.exit(1)
})
