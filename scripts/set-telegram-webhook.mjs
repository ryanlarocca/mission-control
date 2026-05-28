#!/usr/bin/env node
/**
 * Register (or clear) the Telegram bot webhook so lead-alert replies route to
 * /api/telegram/webhook.
 *
 *   node scripts/set-telegram-webhook.mjs            # set, base URL from env
 *   node scripts/set-telegram-webhook.mjs <base-url> # set, explicit base URL
 *   node scripts/set-telegram-webhook.mjs --info     # show current webhook
 *   node scripts/set-telegram-webhook.mjs --delete   # remove the webhook
 *
 * Env (from .env.local or the shell):
 *   TELEGRAM_BOT_TOKEN       required
 *   TELEGRAM_WEBHOOK_SECRET  required to set — echoed back by Telegram in the
 *                            X-Telegram-Bot-Api-Secret-Token header and checked
 *                            by the route. Must match the Vercel env var.
 *   TELEGRAM_WEBHOOK_BASE_URL  e.g. https://mission-control-three-chi.vercel.app
 *                              (used when no base-url arg is passed)
 *
 * Telegram only delivers updates to ONE webhook per bot; setting this replaces
 * any previous webhook. Setting a webhook also disables getUpdates polling.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")
const ENV_PATH = path.join(REPO_ROOT, ".env.local")

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

function die(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

async function tg(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  })
  return res.json()
}

async function main() {
  loadEnvLocal()
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) die("TELEGRAM_BOT_TOKEN must be set (.env.local or shell)")

  const arg = process.argv[2]

  if (arg === "--info") {
    console.log(JSON.stringify(await tg(token, "getWebhookInfo"), null, 2))
    return
  }

  if (arg === "--delete") {
    const out = await tg(token, "deleteWebhook", { drop_pending_updates: true })
    console.log(out.ok ? "✓ webhook deleted" : `✗ ${JSON.stringify(out)}`)
    return
  }

  const base = (arg || process.env.TELEGRAM_WEBHOOK_BASE_URL || "").replace(/\/$/, "")
  if (!base) die("Pass a base URL or set TELEGRAM_WEBHOOK_BASE_URL")
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (!secret) die("TELEGRAM_WEBHOOK_SECRET must be set (and match Vercel)")

  const url = `${base}/api/telegram/webhook`
  const out = await tg(token, "setWebhook", {
    url,
    secret_token: secret,
    // Only the message updates we care about — keeps callbacks/edits out.
    allowed_updates: ["message"],
    drop_pending_updates: true,
  })
  if (out.ok) {
    console.log(`✓ webhook set → ${url}`)
  } else {
    die(`setWebhook failed: ${JSON.stringify(out)}`)
  }
}

main().catch((e) => die(e?.message || String(e)))
