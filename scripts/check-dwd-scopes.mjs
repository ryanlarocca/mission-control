#!/usr/bin/env node
/**
 * Verify which Gmail scopes the service account's domain-wide delegation
 * (DWD) grant actually covers, per mailbox — including the September 2026
 * secondary sending domains (lrghomesbuys.com / lrghomesoffers.com).
 *
 *   node scripts/check-dwd-scopes.mjs                       # default mailboxes + scopes
 *   node scripts/check-dwd-scopes.mjs ryan@lrghomesbuys.com # specific mailbox(es)
 *   node scripts/check-dwd-scopes.mjs --scopes=gmail.send,gmail.modify
 *   node scripts/check-dwd-scopes.mjs --json                # machine-readable
 *
 * READ-ONLY. It never sends mail and never mutates a mailbox. For every
 * mailbox × scope it asks Google's token endpoint for an access token (a
 * JWT grant). The response tells us exactly what the Admin-console DWD
 * grant allows:
 *   ✓ token minted            → scope granted for this tenant, mailbox exists
 *   ✗ unauthorized_client     → scope NOT on the DWD client's allowlist
 *   ✗ invalid_grant (user)    → mailbox doesn't exist / isn't in the tenant
 * Then, with the first scope that worked, it calls users.getProfile (read)
 * and users.settings.sendAs.list (read) so we know the mailbox is real and
 * which From: addresses it may use.
 *
 * Background (brief BRIEF_SECONDARY_SENDING_DOMAIN_2026-08-25.md, 8/31 audit):
 * the grant was recorded as gmail.modify-only, gmail.send unauthorized. That
 * is fine for sending — messages.send accepts gmail.modify — but the two new
 * domains had never been exercised through DWD. DWD is granted per Workspace
 * CUSTOMER, so secondary domains inherit it; this script is how we prove it
 * instead of assuming.
 *
 * Exit codes: 0 = every mailbox minted the REQUIRED scope (gmail.modify,
 * what the engine + inbox watcher use); 1 = at least one required failure;
 * 2 = usage / env problem.
 *
 * Required env (in .env.local or shell): GOOGLE_SERVICE_ACCOUNT_KEY
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { google } from "googleapis"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")
const ENV_PATH = path.join(REPO_ROOT, ".env.local")

// Mailboxes the September engine depends on. lrghomes.com stays for
// reply/bounce ingest on the historical sends; the two new domains are the
// workhorse + understudy senders.
export const DEFAULT_MAILBOXES = [
  "info@lrghomes.com",
  "ryan@lrghomesbuys.com",
  "ryan@lrghomesoffers.com",
]

// Short name → full scope URL. gmail.modify is what every existing code
// path uses (send + read + label). gmail.send is the least-privilege
// alternative we'd move a pure sender to if it were ever granted.
const SCOPE_URLS = {
  "gmail.modify": "https://www.googleapis.com/auth/gmail.modify",
  "gmail.send": "https://www.googleapis.com/auth/gmail.send",
  "gmail.readonly": "https://www.googleapis.com/auth/gmail.readonly",
  "gmail.compose": "https://www.googleapis.com/auth/gmail.compose",
  "gmail.settings.basic": "https://www.googleapis.com/auth/gmail.settings.basic",
}
const DEFAULT_SCOPES = ["gmail.modify", "gmail.send", "gmail.readonly"]
const REQUIRED_SCOPE = "gmail.modify"

export function loadEnvLocal(envPath = ENV_PATH) {
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
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

function parseArgs(argv) {
  const out = { mailboxes: [], scopes: DEFAULT_SCOPES, json: false, help: false }
  for (const a of argv) {
    if (a === "--json") out.json = true
    else if (a === "--help" || a === "-h") out.help = true
    else if (a.startsWith("--scopes=")) {
      out.scopes = a.slice("--scopes=".length).split(",").map((s) => s.trim()).filter(Boolean)
    } else if (a.startsWith("--")) {
      throw new Error(`unknown flag ${a}`)
    } else out.mailboxes.push(a.trim().toLowerCase())
  }
  if (out.mailboxes.length === 0) out.mailboxes = DEFAULT_MAILBOXES
  for (const m of out.mailboxes) {
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(m)) throw new Error(`not an email address: ${m}`)
  }
  for (const s of out.scopes) {
    if (!SCOPE_URLS[s] && !/^https:\/\/www\.googleapis\.com\/auth\//.test(s)) {
      throw new Error(`unknown scope "${s}" — use one of ${Object.keys(SCOPE_URLS).join(", ")} or a full URL`)
    }
  }
  return out
}

function scopeUrl(s) {
  return SCOPE_URLS[s] || s
}

// Classify a token-endpoint failure into something a human can act on.
// googleapis surfaces the OAuth error body on e.response.data; fall back to
// the message text (which usually embeds the same `error` string).
export function classifyAuthError(e) {
  const data = e?.response?.data || {}
  const code = String(data.error || "")
  const desc = String(data.error_description || e?.message || "")
  const blob = `${code} ${desc}`
  if (/unauthorized_client/i.test(blob)) {
    return { kind: "scope_not_granted", detail: "unauthorized_client — this scope is not on the DWD client's allowlist (or the client ID isn't delegated at all)" }
  }
  if (/invalid_grant/i.test(blob) && /email|user/i.test(blob)) {
    return { kind: "mailbox_missing", detail: `invalid_grant — Google does not recognise this user in the tenant (${desc.trim()})` }
  }
  if (/invalid_grant/i.test(blob)) {
    return { kind: "invalid_grant", detail: `invalid_grant — ${desc.trim() || "token request rejected"} (clock skew or disabled account?)` }
  }
  if (/invalid_client|invalid_rapt|access_denied/i.test(blob)) {
    return { kind: "client_problem", detail: blob.trim() }
  }
  return { kind: "unknown", detail: blob.trim() || String(e) }
}

async function mintToken(credentials, mailbox, scope) {
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: [scopeUrl(scope)],
    subject: mailbox,
  })
  await auth.authorize()
  return auth
}

async function probeMailbox(auth, mailbox) {
  const gmail = google.gmail({ version: "v1", auth })
  const profile = await gmail.users.getProfile({ userId: "me" })
  let sendAs = null
  try {
    const { data } = await gmail.users.settings.sendAs.list({ userId: "me" })
    sendAs = (data.sendAs || []).map((s) => ({
      email: s.sendAsEmail,
      primary: !!s.isPrimary,
      verified: s.verificationStatus,
      display: s.displayName || null,
    }))
  } catch (e) {
    // settings.sendAs needs gmail.settings.basic OR gmail.modify on the
    // Workspace tenant; a 403 here just means we're on a narrower scope.
    sendAs = { error: classifyAuthError(e).detail || e.message }
  }
  return {
    emailAddress: profile.data.emailAddress,
    messagesTotal: profile.data.messagesTotal ?? null,
    threadsTotal: profile.data.threadsTotal ?? null,
    historyId: profile.data.historyId ?? null,
    sendAs,
  }
}

export async function checkDwd({ credentials, mailboxes, scopes }) {
  const results = []
  for (const mailbox of mailboxes) {
    const row = { mailbox, scopes: {}, profile: null, profileError: null }
    let workingAuth = null
    for (const scope of scopes) {
      try {
        const auth = await mintToken(credentials, mailbox, scope)
        row.scopes[scope] = { ok: true }
        if (!workingAuth) workingAuth = auth
      } catch (e) {
        row.scopes[scope] = { ok: false, ...classifyAuthError(e) }
      }
    }
    if (workingAuth) {
      try {
        row.profile = await probeMailbox(workingAuth, mailbox)
      } catch (e) {
        row.profileError = e?.response?.data?.error?.message || e.message
      }
    }
    results.push(row)
  }
  return results
}

function printDwdFixInstructions(credentials, missingScopes) {
  const urls = [...new Set(missingScopes.map(scopeUrl))]
  console.log("")
  console.log("How to extend the DWD grant (Google Admin, Ryan only — no API for this):")
  console.log("  1. admin.google.com → Security → Access and data control → API controls")
  console.log("     → Manage Domain Wide Delegation")
  console.log(`  2. Find the client with Client ID ${credentials.client_id || "(numeric client_id in the service-account JSON)"}`)
  console.log(`     (service account ${credentials.client_email}) → Edit`)
  console.log("  3. The scope field is ONE comma-separated line. Keep every existing")
  console.log("     scope and append:")
  for (const u of urls) console.log(`       ${u}`)
  console.log("  4. Authorize. Propagation is usually immediate; re-run this script.")
  console.log("  Note: a grant is per Workspace CUSTOMER, not per domain — secondary")
  console.log("  domains (lrghomesbuys.com, lrghomesoffers.com) inherit it automatically.")
}

function printHuman(results, scopes, credentials) {
  console.log(`Service account: ${credentials.client_email}`)
  console.log(`Project:         ${credentials.project_id || "?"}`)
  console.log("")
  const missingRequired = []
  const missingAny = new Set()
  for (const r of results) {
    console.log(`▸ ${r.mailbox}`)
    for (const s of scopes) {
      const v = r.scopes[s]
      const tag = s === REQUIRED_SCOPE ? " (required)" : ""
      if (v.ok) console.log(`    ✓ ${s}${tag}`)
      else {
        console.log(`    ✗ ${s}${tag} — ${v.detail}`)
        if (v.kind === "scope_not_granted") missingAny.add(s)
        if (s === REQUIRED_SCOPE) missingRequired.push(r.mailbox)
      }
    }
    if (r.profile) {
      const p = r.profile
      console.log(`    mailbox ok: ${p.emailAddress} · ${p.messagesTotal ?? "?"} msgs · historyId ${p.historyId ?? "?"}`)
      if (Array.isArray(p.sendAs)) {
        for (const a of p.sendAs) {
          console.log(`    send-as: ${a.email}${a.primary ? " (primary)" : ""}${a.verified ? ` [${a.verified}]` : ""}`)
        }
      } else if (p.sendAs?.error) {
        console.log(`    send-as: (not readable — ${p.sendAs.error})`)
      }
    } else if (r.profileError) {
      console.log(`    profile probe failed: ${r.profileError}`)
    } else {
      console.log("    (no scope minted — mailbox not probed)")
    }
  }
  console.log("")
  if (missingRequired.length === 0) {
    console.log(`✓ ${REQUIRED_SCOPE} minted for every mailbox — engine sends + inbox watch will authenticate.`)
  } else {
    console.log(`✗ ${REQUIRED_SCOPE} FAILED for: ${missingRequired.join(", ")}`)
  }
  const optionalMissing = [...missingAny].filter((s) => s !== REQUIRED_SCOPE)
  if (optionalMissing.length) {
    console.log(`ℹ optional scopes not granted: ${optionalMissing.join(", ")}. messages.send works under gmail.modify,`)
    console.log("  so gmail.send is least-privilege hygiene, not a blocker. Extend only if Ryan wants it.")
  }
  if (missingAny.size) printDwdFixInstructions(credentials, [...missingAny])
  return missingRequired.length === 0
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`✗ ${e.message}`)
    process.exit(2)
  }
  if (args.help) {
    console.log("Usage: node scripts/check-dwd-scopes.mjs [mailbox ...] [--scopes=a,b] [--json]")
    console.log(`Default mailboxes: ${DEFAULT_MAILBOXES.join(", ")}`)
    console.log(`Default scopes:    ${DEFAULT_SCOPES.join(", ")}`)
    process.exit(0)
  }
  loadEnvLocal()
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!keyJson) {
    console.error("✗ GOOGLE_SERVICE_ACCOUNT_KEY is not set (check .env.local)")
    process.exit(2)
  }
  let credentials
  try {
    credentials = JSON.parse(keyJson)
  } catch {
    console.error("✗ GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON")
    process.exit(2)
  }
  const results = await checkDwd({ credentials, mailboxes: args.mailboxes, scopes: args.scopes })
  if (args.json) {
    const allRequiredOk = results.every((r) => r.scopes[REQUIRED_SCOPE]?.ok !== false)
    console.log(JSON.stringify({
      service_account: credentials.client_email,
      project_id: credentials.project_id || null,
      required_scope: REQUIRED_SCOPE,
      all_required_ok: allRequiredOk,
      checked_at: new Date().toISOString(),
      results,
    }, null, 2))
    process.exit(allRequiredOk ? 0 : 1)
  }
  const ok = printHuman(results, args.scopes, credentials)
  process.exit(ok ? 0 : 1)
}

// Only run when invoked directly (the helpers are importable for tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error("check-dwd-scopes failed:", e?.response?.data || e)
    process.exit(2)
  })
}
