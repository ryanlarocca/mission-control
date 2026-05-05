#!/usr/bin/env node
/* eslint-disable */
/**
 * One-time Gmail Push setup. Run from the repo root:
 *
 *   node scripts/setup-gmail-watch.js
 *
 * What it does, in order:
 *   1. Creates the Pub/Sub topic `lrg-gmail-leads` on the GCP project
 *      tied to the service account in GOOGLE_SERVICE_ACCOUNT_KEY.
 *   2. Grants `gmail-api-push@system.gserviceaccount.com` publisher
 *      rights on that topic — Gmail's push backend uses this identity
 *      to publish notifications.
 *   3. Creates an HTTPS push subscription pointing at our Mission
 *      Control webhook (PUSH_ENDPOINT).
 *   4. Calls `gmail.users.watch` for both `ryansvg@lrghomes.com` and
 *      `ryansvj@lrghomes.com` so Gmail starts publishing INBOX events
 *      to the topic. Returns the historyId + expiration for each.
 *
 * Auth model:
 *   - Pub/Sub admin operations (1–3) use the service account directly.
 *   - The Gmail watch call (4) impersonates each mailbox via Workspace
 *     domain-wide delegation. If DWD isn't set up yet, step 4 fails with
 *     a 401/403 and we print exactly what to do in Google Admin.
 *
 * Required env (in .env.local or shell):
 *   GOOGLE_SERVICE_ACCOUNT_KEY   JSON service-account key
 *   PUSH_ENDPOINT (optional)     Override the push URL (defaults to
 *                                production Mission Control)
 *
 * Idempotent — re-running is safe; existing topics/subscriptions are
 * detected and skipped.
 */

const { google } = require("googleapis")
const fs = require("fs")
const path = require("path")

const TOPIC_NAME = "lrg-gmail-leads"
const SUBSCRIPTION_NAME = "lrg-gmail-leads-push"
const DEFAULT_PUSH_ENDPOINT = "https://mission-control-three-chi.vercel.app/api/leads/email"
const CAMPAIGNS_PATH = path.resolve(__dirname, "..", "config", "email-campaigns.json")
const GMAIL_PUSH_PRINCIPAL = "serviceAccount:gmail-api-push@system.gserviceaccount.com"

function loadMailboxes() {
  const raw = fs.readFileSync(CAMPAIGNS_PATH, "utf-8")
  return Object.keys(JSON.parse(raw))
}

const GMAIL_WATCH_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
]
const PUBSUB_SCOPES = [
  "https://www.googleapis.com/auth/pubsub",
]

function loadEnvLocal() {
  // Lightweight .env.local loader — avoid taking on dotenv as a dep just
  // for two scripts. Variables already set in the shell take precedence.
  const envPath = path.resolve(process.cwd(), ".env.local")
  if (!fs.existsSync(envPath)) return
  const raw = fs.readFileSync(envPath, "utf-8")
  for (const line of raw.split(/\r?\n/)) {
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

function loadServiceAccount() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!keyJson) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not set (check .env.local)")
  }
  return JSON.parse(keyJson)
}

function pubsubAuth(credentials) {
  return new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: PUBSUB_SCOPES,
  })
}

function gmailAuth(credentials, subject) {
  return new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: GMAIL_WATCH_SCOPES,
    subject,
  })
}

async function ensureTopic(pubsub, projectId) {
  const topicPath = `projects/${projectId}/topics/${TOPIC_NAME}`
  try {
    await pubsub.projects.topics.get({ topic: topicPath })
    console.log(`✓ Topic exists: ${topicPath}`)
  } catch (e) {
    if (e.code === 404 || e.response?.status === 404) {
      await pubsub.projects.topics.create({ name: topicPath, requestBody: {} })
      console.log(`✓ Created topic: ${topicPath}`)
    } else {
      throw e
    }
  }
  return topicPath
}

async function grantGmailPublisher(pubsub, topicPath) {
  const { data: policy } = await pubsub.projects.topics.getIamPolicy({
    resource: topicPath,
  })
  const bindings = policy.bindings || []
  const pubBinding = bindings.find((b) => b.role === "roles/pubsub.publisher")
  if (pubBinding && (pubBinding.members || []).includes(GMAIL_PUSH_PRINCIPAL)) {
    console.log(`✓ Gmail push principal already has publisher on ${topicPath}`)
    return
  }
  if (pubBinding) {
    pubBinding.members = [...(pubBinding.members || []), GMAIL_PUSH_PRINCIPAL]
  } else {
    bindings.push({ role: "roles/pubsub.publisher", members: [GMAIL_PUSH_PRINCIPAL] })
  }
  await pubsub.projects.topics.setIamPolicy({
    resource: topicPath,
    requestBody: { policy: { ...policy, bindings } },
  })
  console.log(`✓ Granted ${GMAIL_PUSH_PRINCIPAL} pubsub.publisher on ${topicPath}`)
}

async function ensureSubscription(pubsub, projectId, topicPath, pushEndpoint) {
  const subPath = `projects/${projectId}/subscriptions/${SUBSCRIPTION_NAME}`
  try {
    const { data: existing } = await pubsub.projects.subscriptions.get({ subscription: subPath })
    const currentEndpoint = existing.pushConfig?.pushEndpoint
    if (currentEndpoint !== pushEndpoint) {
      await pubsub.projects.subscriptions.modifyPushConfig({
        subscription: subPath,
        requestBody: { pushConfig: { pushEndpoint } },
      })
      console.log(`✓ Updated push endpoint on ${subPath} → ${pushEndpoint}`)
    } else {
      console.log(`✓ Subscription exists with correct endpoint: ${subPath}`)
    }
    return subPath
  } catch (e) {
    if (e.code !== 404 && e.response?.status !== 404) throw e
  }
  await pubsub.projects.subscriptions.create({
    name: subPath,
    requestBody: {
      topic: topicPath,
      pushConfig: { pushEndpoint },
      ackDeadlineSeconds: 60,
    },
  })
  console.log(`✓ Created push subscription: ${subPath} → ${pushEndpoint}`)
  return subPath
}

async function callWatch(credentials, mailbox, topicPath) {
  const gmail = google.gmail({ version: "v1", auth: gmailAuth(credentials, mailbox) })
  const { data } = await gmail.users.watch({
    userId: mailbox,
    requestBody: {
      topicName: topicPath,
      labelIds: ["INBOX"],
      labelFilterAction: "include",
    },
  })
  return data
}

function printDwdInstructions(serviceAccountEmail) {
  console.log("")
  console.log("⚠️  Gmail watch failed. The most likely cause is that the service")
  console.log("    account doesn't have domain-wide delegation enabled for the")
  console.log("    Gmail scope. To fix:")
  console.log("")
  console.log("    1. Open Google Admin → Security → Access and data control")
  console.log("       → API controls → Manage Domain Wide Delegation")
  console.log(`    2. Add a new client with Client ID = the numeric "client_id" in your`)
  console.log("       service-account JSON (NOT the email).")
  console.log("    3. Add this scope (comma-separated, exact):")
  console.log("       https://www.googleapis.com/auth/gmail.modify")
  console.log("    4. Save, then re-run this script.")
  console.log("")
  console.log(`    Service account: ${serviceAccountEmail}`)
  console.log("")
  console.log("    Alternative: if you don't want to grant DWD, run an OAuth2")
  console.log("    consent flow per mailbox and call gmail.users.watch with the")
  console.log("    resulting refresh token. That's a larger change — DWD is the")
  console.log("    expected path for Workspace.")
  console.log("")
}

async function main() {
  loadEnvLocal()
  const credentials = loadServiceAccount()
  const projectId = credentials.project_id
  if (!projectId) throw new Error("Service-account key has no project_id")

  const pushEndpoint = process.env.PUSH_ENDPOINT || DEFAULT_PUSH_ENDPOINT
  const mailboxes = loadMailboxes()
  console.log(`Project:        ${projectId}`)
  console.log(`Push endpoint:  ${pushEndpoint}`)
  console.log(`Mailboxes:      ${mailboxes.join(", ")} (from ${path.relative(process.cwd(), CAMPAIGNS_PATH)})`)
  console.log("")

  const pubsub = google.pubsub({ version: "v1", auth: pubsubAuth(credentials) })

  // 1 + 2: topic + IAM
  const topicPath = await ensureTopic(pubsub, projectId)
  await grantGmailPublisher(pubsub, topicPath)

  // 3: push subscription
  await ensureSubscription(pubsub, projectId, topicPath, pushEndpoint)

  // 4: watch each mailbox
  const failures = []
  for (const mailbox of mailboxes) {
    try {
      const result = await callWatch(credentials, mailbox, topicPath)
      const expiry = result.expiration ? new Date(Number(result.expiration)).toISOString() : "(unknown)"
      console.log(`✓ Watching ${mailbox} — historyId=${result.historyId} expires=${expiry}`)
    } catch (e) {
      const status = e.code || e.response?.status
      const msg = e.errors?.[0]?.message || e.response?.data?.error?.message || e.message
      console.error(`✗ Failed to watch ${mailbox} (${status}): ${msg}`)
      failures.push({ mailbox, status, msg })
    }
  }

  if (failures.length) {
    printDwdInstructions(credentials.client_email)
    console.log("Next steps after fixing DWD:")
    console.log("  1. Re-run this script (idempotent — won't duplicate topics/subs).")
    console.log("  2. Send a test email to one of the mailboxes and confirm it")
    console.log("     lands in the Mission Control Leads tab as an email lead.")
    console.log("  3. Set up a weekly cron for scripts/renew-gmail-watch.js.")
    process.exitCode = 1
    return
  }

  console.log("")
  console.log("✓ Setup complete.")
  console.log("Next steps:")
  console.log("  1. Send a test email to one of the mailboxes and confirm it")
  console.log("     lands in the Mission Control Leads tab as an email lead.")
  console.log("  2. Set up a weekly cron for scripts/renew-gmail-watch.js")
  console.log("     (Gmail watches expire in 7 days).")
}

main().catch((e) => {
  console.error("Setup failed:", e)
  process.exit(1)
})
