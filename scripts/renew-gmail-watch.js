#!/usr/bin/env node
/* eslint-disable */
/**
 * Weekly Gmail watch renewal. Run from the repo root via cron:
 *
 *   node scripts/renew-gmail-watch.js
 *
 * Gmail watches expire 7 days after registration, so this just re-calls
 * `gmail.users.watch` on both mailboxes against the same Pub/Sub topic
 * created by scripts/setup-gmail-watch.js. The topic + subscription
 * themselves don't expire, so we don't touch them here.
 *
 * Required env (in .env.local or shell):
 *   GOOGLE_SERVICE_ACCOUNT_KEY   JSON service-account key (must have DWD
 *                                with the gmail.modify scope on lrghomes.com)
 */

const { google } = require("googleapis")
const fs = require("fs")
const path = require("path")

const TOPIC_NAME = "lrg-gmail-leads"
const CAMPAIGNS_PATH = path.resolve(__dirname, "..", "config", "email-campaigns.json")
const GMAIL_WATCH_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]

function loadMailboxes() {
  const raw = fs.readFileSync(CAMPAIGNS_PATH, "utf-8")
  return Object.keys(JSON.parse(raw))
}

function loadEnvLocal() {
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

function gmailAuth(credentials, subject) {
  return new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: GMAIL_WATCH_SCOPES,
    subject,
  })
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

async function main() {
  loadEnvLocal()
  const credentials = loadServiceAccount()
  const projectId = credentials.project_id
  if (!projectId) throw new Error("Service-account key has no project_id")

  const topicPath = `projects/${projectId}/topics/${TOPIC_NAME}`
  const mailboxes = loadMailboxes()
  console.log(`Renewing Gmail watch on topic: ${topicPath}`)
  console.log(`Mailboxes: ${mailboxes.join(", ")} (from ${path.relative(process.cwd(), CAMPAIGNS_PATH)})`)

  let failed = 0
  for (const mailbox of mailboxes) {
    try {
      const result = await callWatch(credentials, mailbox, topicPath)
      const expiry = result.expiration ? new Date(Number(result.expiration)).toISOString() : "(unknown)"
      console.log(`✓ ${mailbox} — historyId=${result.historyId} expires=${expiry}`)
    } catch (e) {
      const status = e.code || e.response?.status
      const msg = e.errors?.[0]?.message || e.response?.data?.error?.message || e.message
      console.error(`✗ ${mailbox} (${status}): ${msg}`)
      failed++
    }
  }

  if (failed) process.exitCode = 1
}

main().catch((e) => {
  console.error("Renewal failed:", e)
  process.exit(1)
})
