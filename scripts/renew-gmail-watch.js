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
 *                                with the gmail.modify scope on the lrghomes
 *                                Workspace tenant — covers lrghomes.com and
 *                                the lrghomesbuys.com / lrghomesoffers.com
 *                                secondary domains; verify with
 *                                scripts/check-dwd-scopes.mjs)
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

// Consumer-Gmail campaign sender (2026-08-21): OAuth refresh token instead of
// DWD. Same topic — Gmail's push service account publishes to it regardless
// of which account owns the watch.
function oauthMailbox() {
  const u = (process.env.CAMPAIGN_GMAIL_OAUTH_USER || "").toLowerCase()
  return u && process.env.CAMPAIGN_GMAIL_OAUTH_REFRESH_TOKEN ? u : null
}
function oauthAuth() {
  const auth = new google.auth.OAuth2(process.env.CAMPAIGN_GMAIL_OAUTH_CLIENT_ID, process.env.CAMPAIGN_GMAIL_OAUTH_CLIENT_SECRET)
  auth.setCredentials({ refresh_token: process.env.CAMPAIGN_GMAIL_OAUTH_REFRESH_TOKEN })
  return auth
}

async function callWatch(credentials, mailbox, topicPath) {
  const auth = mailbox === oauthMailbox() ? oauthAuth() : gmailAuth(credentials, mailbox)
  const gmail = google.gmail({ version: "v1", auth })
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
  if (oauthMailbox()) mailboxes.push(oauthMailbox())
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

  if (failed) {
    // A lapsed watch silently stops inbound lead-email ingest 7 days later.
    // The Aug-29 invalid_grant failures sat unseen in the err log for 2.5
    // days — alert loudly instead (2026-09-01).
    await telegram(`⚠️ Gmail watch renewal: ${failed}/${mailboxes.length} mailbox(es) failed — inbound email ingest lapses when the watch expires. See /tmp/lrg-gmail-watch-renewal-err.log`)
    process.exitCode = 1
  }
}

// Best-effort Telegram alert (same env the campaign engine uses).
async function telegram(text) {
  const token = process.env.CAMPAIGN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) return
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
  } catch {}
}

main().catch(async (e) => {
  console.error("Renewal failed:", e)
  await telegram(`🔥 Gmail watch renewal crashed: ${e?.message ?? e}`)
  process.exit(1)
})
