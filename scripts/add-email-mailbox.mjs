#!/usr/bin/env node
/**
 * Add a new email mailbox to the lead-capture pipeline.
 *
 *   node scripts/add-email-mailbox.mjs <email> <campaign-label> [--dry-run]
 *
 * Examples:
 *   node scripts/add-email-mailbox.mjs ryansvk@lrghomes.com SVK-C
 *   node scripts/add-email-mailbox.mjs ryan@lrghomesbuys.com AGENT-DRIP-BUYS --dry-run
 *
 * What it does:
 *   1. Validates the email is on one of the Workspace tenant's domains
 *      (ALLOWED_DOMAINS below — DWD is granted per Workspace customer, so
 *      the secondary sending domains added 2026-09-01 qualify; verified
 *      with scripts/check-dwd-scopes.mjs on 2026-09-03).
 *   2. Reads config/email-campaigns.json, adds the new entry, writes it back.
 *   3. Calls gmail.users.watch on the new mailbox against the existing
 *      Pub/Sub topic so Gmail starts publishing INBOX events.
 *   4. Prints a reminder to `vercel deploy --prod` (the route imports the
 *      JSON at build time, so the new entry needs a fresh build to land).
 *
 * --dry-run: validates, mints a DWD token for the mailbox (read-only proof
 *   that impersonation works), and prints the config diff — but writes
 *   nothing and registers no watch.
 *
 * Required env (in .env.local or shell):
 *   GOOGLE_SERVICE_ACCOUNT_KEY   JSON service-account key (DWD on the
 *                                lrghomes Workspace tenant, gmail.modify)
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
// Every domain on the lrghomes Google Workspace tenant. DWD is authorized
// per customer, not per domain, so any mailbox here impersonates fine.
// lrghomesbuys.com = workhorse sender, lrghomesoffers.com = understudy
// (BRIEF_SECONDARY_SENDING_DOMAIN_2026-08-25.md, "Standing architecture").
export const ALLOWED_DOMAINS = ["lrghomes.com", "lrghomesbuys.com", "lrghomesoffers.com"]
const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]

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

export function isAllowedMailbox(email) {
  const at = String(email).lastIndexOf("@")
  if (at < 1) return false
  return ALLOWED_DOMAINS.includes(email.slice(at + 1).toLowerCase())
}

function usage(code) {
  console.error("Usage: node scripts/add-email-mailbox.mjs <email> <campaign-label> [--dry-run]")
  console.error("Example: node scripts/add-email-mailbox.mjs ryansvk@lrghomes.com SVK-C")
  console.error(`Allowed domains: ${ALLOWED_DOMAINS.map((d) => `@${d}`).join(", ")}`)
  process.exit(code)
}

async function main() {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes("--dry-run")
  const positional = argv.filter((a) => !a.startsWith("--"))
  const unknown = argv.filter((a) => a.startsWith("--") && a !== "--dry-run")
  if (unknown.length) die(`unknown flag(s): ${unknown.join(" ")}`, 2)
  const [rawEmail, rawLabel] = positional
  if (!rawEmail || !rawLabel) usage(2)
  const email = rawEmail.trim().toLowerCase()
  const label = rawLabel.trim()
  if (!isAllowedMailbox(email)) {
    die(`Email must be on one of ${ALLOWED_DOMAINS.map((d) => `@${d}`).join(", ")} (the DWD-delegated Workspace tenant). Got: ${email}`)
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

  if (dryRun) console.log("DRY RUN — nothing will be written or registered")

  // 1. Update JSON config. Map values are { source, source_type }.
  const config = JSON.parse(fs.readFileSync(CAMPAIGNS_PATH, "utf-8"))
  const existing = config[email]
  const desired = { source: label, source_type: "direct_mail" }
  const same = existing && existing.source === desired.source && existing.source_type === desired.source_type
  if (same) {
    console.log(`• ${email} already mapped to ${label} in ${path.relative(REPO_ROOT, CAMPAIGNS_PATH)} (no change)`)
  } else if (existing) {
    const prev = typeof existing === "string" ? existing : existing.source
    console.log(`• ${email} was mapped to ${prev}, ${dryRun ? "would update" : "updating"} to ${label}`)
    config[email] = desired
  } else {
    console.log(`• ${dryRun ? "would add" : "adding"} ${email} → ${label} to ${path.relative(REPO_ROOT, CAMPAIGNS_PATH)}`)
    config[email] = desired
  }
  // Sort keys so the JSON diff stays clean across adds.
  const sorted = Object.fromEntries(Object.entries(config).sort(([a], [b]) => a.localeCompare(b)))
  if (dryRun) {
    console.log(`• resulting mailbox list: ${Object.keys(sorted).join(", ")}`)
  } else {
    fs.writeFileSync(CAMPAIGNS_PATH, JSON.stringify(sorted, null, 2) + "\n")
    console.log(`✓ wrote ${path.relative(REPO_ROOT, CAMPAIGNS_PATH)}`)
  }

  // 2. Register the Gmail watch (dry-run: only prove the DWD token mints)
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: GMAIL_SCOPES,
    subject: email,
  })
  const topicPath = `projects/${projectId}/topics/${TOPIC_NAME}`
  if (dryRun) {
    try {
      await auth.authorize()
      console.log(`✓ DWD token minted for ${email} (gmail.modify) — impersonation works`)
      console.log(`• would call gmail.users.watch(${email}) → ${topicPath}`)
    } catch (e) {
      const msg = e.response?.data?.error_description || e.response?.data?.error || e.message
      die(`DWD token for ${email} failed: ${msg}\n   Run node scripts/check-dwd-scopes.mjs ${email} for a full diagnosis.`)
    }
    console.log("")
    console.log("Dry run complete. Re-run without --dry-run to write the config and register the watch.")
    return
  }
  const gmail = google.gmail({ version: "v1", auth })
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
    die(`Gmail watch failed for ${email} (${status}): ${msg}\n   Check that ${email} exists in the Workspace and that DWD covers gmail.modify (node scripts/check-dwd-scopes.mjs ${email}).`)
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

// Only run when invoked directly (isAllowedMailbox is importable for tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error("add-email-mailbox failed:", e)
    process.exit(1)
  })
}
