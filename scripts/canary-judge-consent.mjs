#!/usr/bin/env node
/**
 * One-time OAuth consent for the canary JUDGE inbox (CAMPAIGN_CANARY_TO — a
 * consumer gmail.com account, so service-account DWD cannot reach it).
 * Brief: briefs/BRIEF_CANARY_JUDGE_AUTOMATION_2026-10-12.md, Task 1.
 *
 *   node scripts/canary-judge-consent.mjs [--write-env] [--code=<code>]
 *
 * Needs in .env.local (Desktop OAuth client, GCP project lrg-mission-control):
 *   CANARY_JUDGE_OAUTH_CLIENT_ID
 *   CANARY_JUDGE_OAUTH_CLIENT_SECRET
 * Produces:
 *   CANARY_JUDGE_OAUTH_REFRESH_TOKEN   (printed; --write-env upserts it into .env.local)
 *
 * Flow: starts a loopback HTTP server on 127.0.0.1 (random free port), prints
 * the consent URL, waits for Google to redirect the browser back with the
 * code, exchanges it, prints the refresh token. The browser doing the consent
 * runs on the same machine as this script, so the loopback completes on its
 * own. `--code=<code>` skips the server and exchanges a pasted code instead.
 *
 * Scope is gmail.readonly ONLY — the judge is read, never written. Sign in as
 * the judge address when the consent page asks; the script verifies the
 * token's mailbox against CAMPAIGN_CANARY_TO at the end and warns loudly on
 * a mismatch. The client secret is never printed or logged.
 */

import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { google } from "googleapis"
import { JUDGE_SCOPES, upsertEnvLine } from "./canary-judge.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")
const ENV_PATH = path.join(REPO_ROOT, ".env.local")

// ---------- env (same loader as the engine; shell wins over the file) ----------
try {
  for (const line of fs.readFileSync(ENV_PATH, "utf-8").split(/\r?\n/)) {
    const eq = line.indexOf("=")
    if (eq < 0 || line.trim().startsWith("#")) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    if (process.env[key] === undefined) process.env[key] = val
  }
} catch { /* no .env.local — rely on the shell */ }

const args = process.argv.slice(2)
const writeEnv = args.includes("--write-env")
const codeArg = args.find((a) => a.startsWith("--code="))
const pastedCode = codeArg ? codeArg.slice("--code=".length).trim() : null

const clientId = process.env.CANARY_JUDGE_OAUTH_CLIENT_ID
const clientSecret = process.env.CANARY_JUDGE_OAUTH_CLIENT_SECRET
const judgeAddress = String(process.env.CAMPAIGN_CANARY_TO ?? "").trim().toLowerCase()
if (!clientId || !clientSecret) {
  console.error("CANARY_JUDGE_OAUTH_CLIENT_ID and CANARY_JUDGE_OAUTH_CLIENT_SECRET must be set (Desktop OAuth client, GCP project lrg-mission-control).")
  process.exit(2)
}
if (!judgeAddress) console.warn("⚠️  CAMPAIGN_CANARY_TO is unset — the final mailbox check will be skipped. Sign in as the judge inbox.")

async function exchangeWithLoopback() {
  // Loopback redirect: Google's Desktop-client flow allows any http://127.0.0.1:<port> redirect.
  const server = http.createServer()
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve))
  const { port } = server.address()
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri)
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36)
  const url = oauth2.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: JUDGE_SCOPES, state, login_hint: judgeAddress || undefined })
  console.log("\nOpen this URL in a browser ON THIS MACHINE and sign in as the judge inbox" + (judgeAddress ? ` (${judgeAddress})` : "") + ":\n")
  console.log(url)
  console.log(`\nWaiting for the redirect on ${redirectUri} … (Ctrl-C to abort; or rerun with --code=<code> if the browser cannot reach this machine)`)
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out after 10 minutes waiting for the OAuth redirect")), 10 * 60_000)
    server.on("request", (req, res) => {
      const u = new URL(req.url ?? "/", redirectUri)
      if (u.pathname !== "/oauth2callback") { res.statusCode = 404; res.end("not found"); return }
      const err = u.searchParams.get("error")
      const got = u.searchParams.get("code")
      const st = u.searchParams.get("state")
      if (err || !got || st !== state) {
        res.statusCode = 400
        res.setHeader("Content-Type", "text/plain")
        res.end(`Consent failed: ${err ?? (st !== state ? "state mismatch" : "no code")}. Close this tab and rerun the script.`)
        clearTimeout(timer)
        reject(new Error(`consent redirect error: ${err ?? (st !== state ? "state mismatch" : "no code")}`))
        return
      }
      res.statusCode = 200
      res.setHeader("Content-Type", "text/plain")
      res.end("Judge inbox authorized — you can close this tab and go back to the terminal.")
      clearTimeout(timer)
      resolve(got)
    })
  }).finally(() => server.close())
  const { tokens } = await oauth2.getToken(code)
  return { oauth2, tokens }
}

async function exchangePastedCode(code) {
  // A pasted code was minted against whatever redirect the consent URL used;
  // for the Desktop client that is a loopback URI. Try the common ones.
  let lastErr = null
  for (const redirectUri of ["http://127.0.0.1", "http://localhost", "urn:ietf:wg:oauth:2.0:oob"]) {
    try {
      const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri)
      const { tokens } = await oauth2.getToken(code)
      return { oauth2, tokens }
    } catch (e) { lastErr = e }
  }
  throw lastErr ?? new Error("code exchange failed")
}

try {
  const { oauth2, tokens } = pastedCode ? await exchangePastedCode(pastedCode) : await exchangeWithLoopback()
  const refresh = tokens.refresh_token
  if (!refresh) {
    console.error("\n❌ Google returned no refresh token. That happens when this client was already consented without prompt=consent — revoke the app at https://myaccount.google.com/permissions (as the judge account) and rerun.")
    process.exit(1)
  }
  const granted = String(tokens.scope ?? "")
  if (granted && !granted.includes(JUDGE_SCOPES[0])) console.warn(`⚠️  granted scopes do not include gmail.readonly: ${granted}`)

  // Verify: which mailbox does this token belong to?
  oauth2.setCredentials({ refresh_token: refresh })
  const gmail = google.gmail({ version: "v1", auth: oauth2 })
  const profile = await gmail.users.getProfile({ userId: "me" })
  const address = String(profile.data.emailAddress ?? "").toLowerCase()
  console.log(`\n✅ token belongs to ${address} (${profile.data.messagesTotal ?? "?"} messages)`)
  if (judgeAddress && address !== judgeAddress) {
    console.warn(`\n🚨🚨🚨 WRONG MAILBOX: the token is for ${address}, but CAMPAIGN_CANARY_TO is ${judgeAddress}.`)
    console.warn("   The judge pass would read the wrong inbox and never find a canary. Rerun and sign in as the judge account.")
  }

  console.log(`\nCANARY_JUDGE_OAUTH_REFRESH_TOKEN='${refresh}'`)
  if (writeEnv) {
    const current = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf-8") : ""
    fs.writeFileSync(ENV_PATH, upsertEnvLine(current, "CANARY_JUDGE_OAUTH_REFRESH_TOKEN", refresh), { mode: 0o600 })
    console.log(`\n✍️  wrote CANARY_JUDGE_OAUTH_REFRESH_TOKEN to ${ENV_PATH}`)
  } else {
    console.log("\nAdd that line to .env.local (or rerun with --write-env to do it for you).")
  }
  if (judgeAddress && address !== judgeAddress) process.exit(3)
} catch (e) {
  // Never echo the client secret: google's errors can include the request body.
  const msg = String(e?.response?.data?.error_description ?? e?.message ?? e).replaceAll(clientSecret, "[client secret]")
  console.error(`\n❌ consent failed: ${msg}`)
  process.exit(1)
}
