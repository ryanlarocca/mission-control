#!/usr/bin/env node
/**
 * One-time setup for the dedicated campaign Telegram bot.
 *
 *   node scripts/setup-campaign-bot.mjs <bot-token-from-BotFather>
 *
 * Does everything: validates the token, generates a webhook secret,
 * registers the webhook to /api/campaign/telegram, writes CAMPAIGN_BOT_TOKEN
 * + CAMPAIGN_TG_SECRET into .env.local AND Vercel production env, and
 * reminds about the redeploy that makes Vercel pick the env up.
 *
 * After this runs (and a redeploy), all campaign alerts come from the new
 * bot with working buttons, and Thadius never sees campaign traffic again.
 */

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")
const ENV_PATH = path.join(REPO_ROOT, ".env.local")

const token = process.argv[2]
if (!token || !/^\d+:[\w-]+$/.test(token)) {
  console.error("usage: node scripts/setup-campaign-bot.mjs <bot-token-from-BotFather>")
  process.exit(1)
}

// 1. Validate the token
const me = await (await fetch(`https://api.telegram.org/bot${token}/getMe`)).json()
if (!me.ok) {
  console.error("✗ Telegram rejected that token:", JSON.stringify(me))
  process.exit(1)
}
console.log(`✓ token valid — bot @${me.result.username}`)

// 2. Register the webhook with a fresh secret
const secret = crypto.randomBytes(24).toString("hex")
const hook = await (
  await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "https://mission-control-three-chi.vercel.app/api/campaign/telegram",
      secret_token: secret,
      allowed_updates: ["message", "callback_query"],
    }),
  })
).json()
if (!hook.ok) {
  console.error("✗ setWebhook failed:", JSON.stringify(hook))
  process.exit(1)
}
console.log("✓ webhook registered → /api/campaign/telegram")

// 3. Local env
let env = fs.readFileSync(ENV_PATH, "utf-8")
env = env
  .split(/\r?\n/)
  .filter((l) => !l.startsWith("CAMPAIGN_BOT_TOKEN=") && !l.startsWith("CAMPAIGN_TG_SECRET="))
  .join("\n")
  .replace(/\n*$/, "\n")
env += `CAMPAIGN_BOT_TOKEN='${token}'\nCAMPAIGN_TG_SECRET='${secret}'\n`
fs.writeFileSync(ENV_PATH, env)
console.log("✓ .env.local updated")

// 4. Vercel production env (idempotent-ish: remove then add)
for (const [name, value] of [
  ["CAMPAIGN_BOT_TOKEN", token],
  ["CAMPAIGN_TG_SECRET", secret],
]) {
  try {
    execSync(`vercel env rm ${name} production --yes`, { cwd: REPO_ROOT, stdio: "pipe" })
  } catch {
    /* didn't exist */
  }
  execSync(`vercel env add ${name} production`, { cwd: REPO_ROOT, input: value, stdio: ["pipe", "pipe", "pipe"] })
  console.log(`✓ Vercel env ${name} set`)
}

console.log(`
DONE. Final step — redeploy so Vercel picks up the env:
  git commit --allow-empty -m "chore: campaign bot env" && git push
Then send a test text to the agents line or tap a button on the next alert.`)
