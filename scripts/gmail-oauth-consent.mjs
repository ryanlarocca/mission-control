// One-time OAuth consent for the consumer-Gmail campaign sender
// (ryan.lrghomes@gmail.com, 2026-08-21). Prints a consent URL; Ryan opens it
// signed in as that account; Google redirects to a loopback server here and
// we print/store the refresh token.
//
//   node scripts/gmail-oauth-consent.mjs [--write-env] [--code=<code or full redirect URL>]
//
// Client id/secret come from CAMPAIGN_GMAIL_OAUTH_CLIENT_ID/SECRET in
// .env.local, or fall back to gog's stored desktop client
// (~/Library/Application Support/gogcli/credentials.json).
// IMPORTANT: the OAuth consent screen must be External + "In production"
// (unverified is fine) — in "Testing" status Google expires refresh tokens
// after 7 days.
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { google } from "googleapis"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")
const ENV_PATH = path.join(REPO_ROOT, ".env.local")
for (const line of fs.readFileSync(ENV_PATH, "utf-8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line)
  if (!m) continue
  let v = m[2]
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  if (process.env[m[1]] === undefined) process.env[m[1]] = v
}

const args = process.argv.slice(2)
const writeEnv = args.includes("--write-env")
const codeArg = args.find((a) => a.startsWith("--code="))?.slice(7)
const USER = process.env.CAMPAIGN_GMAIL_OAUTH_USER || "ryan.lrghomes@gmail.com"
const PORT = 8765
const REDIRECT = `http://127.0.0.1:${PORT}/oauth/callback`
const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]

let clientId = process.env.CAMPAIGN_GMAIL_OAUTH_CLIENT_ID
let clientSecret = process.env.CAMPAIGN_GMAIL_OAUTH_CLIENT_SECRET
let clientSource = ".env.local"
if (!clientId || !clientSecret) {
  const gogPath = path.join(os.homedir(), "Library/Application Support/gogcli/credentials.json")
  const c = JSON.parse(fs.readFileSync(gogPath, "utf-8"))
  clientId = c.client_id
  clientSecret = c.client_secret
  clientSource = "gog desktop client"
}

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT)

function upsertEnv(vars) {
  let text = fs.readFileSync(ENV_PATH, "utf-8")
  for (const [k, v] of Object.entries(vars)) {
    const line = `${k}='${v}'`
    const re = new RegExp(`^${k}=.*$`, "m")
    text = re.test(text) ? text.replace(re, line) : text.replace(/\n?$/, `\n${line}\n`)
  }
  fs.writeFileSync(ENV_PATH, text)
}

async function finish(code) {
  const { tokens } = await oauth2.getToken(code)
  if (!tokens.refresh_token) {
    console.error("No refresh_token returned (consent was probably granted before — revoke at myaccount.google.com/permissions and retry).")
    process.exit(1)
  }
  oauth2.setCredentials(tokens)
  const gmail = google.gmail({ version: "v1", auth: oauth2 })
  const { data: profile } = await gmail.users.getProfile({ userId: "me" })
  if ((profile.emailAddress || "").toLowerCase() !== USER.toLowerCase()) {
    console.error(`Consent was granted as ${profile.emailAddress}, expected ${USER} — not storing. Sign in as ${USER} and retry.`)
    process.exit(1)
  }
  console.log(`✓ token OK for ${profile.emailAddress} (messagesTotal=${profile.messagesTotal})`)
  const vars = {
    CAMPAIGN_GMAIL_OAUTH_USER: profile.emailAddress,
    CAMPAIGN_GMAIL_OAUTH_CLIENT_ID: clientId,
    CAMPAIGN_GMAIL_OAUTH_CLIENT_SECRET: clientSecret,
    CAMPAIGN_GMAIL_OAUTH_REFRESH_TOKEN: tokens.refresh_token,
  }
  if (writeEnv) {
    upsertEnv(vars)
    console.log(`✓ wrote CAMPAIGN_GMAIL_OAUTH_* to ${ENV_PATH}`)
  } else {
    console.log("Add to .env.local (and Vercel production):")
    for (const [k, v] of Object.entries(vars)) console.log(`${k}='${v}'`)
  }
  process.exit(0)
}

if (codeArg) {
  const code = codeArg.includes("code=") ? new URL(codeArg).searchParams.get("code") : codeArg
  await finish(code)
}

const url = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: SCOPES,
  login_hint: USER,
})
console.log(`OAuth client: ${clientSource} (${clientId})`)
console.log(`\nOpen this URL signed in as ${USER}:\n\n${url}\n`)
console.log(`Waiting on ${REDIRECT} … (if the browser can't reach this machine, rerun with --code=<the full redirected URL>)`)

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, REDIRECT)
    if (u.pathname !== "/oauth/callback") { res.writeHead(404); res.end(); return }
    const err = u.searchParams.get("error")
    const code = u.searchParams.get("code")
    if (err || !code) {
      res.end(`OAuth error: ${err || "no code"}`)
      console.error("consent failed:", err)
      process.exit(1)
    }
    res.end("Consent received — you can close this tab.")
    try { await finish(code) } catch (e) { console.error(e); process.exit(1) }
  })
  .listen(PORT, "127.0.0.1")
