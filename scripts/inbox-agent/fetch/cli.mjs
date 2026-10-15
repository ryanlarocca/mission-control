#!/usr/bin/env node
// Manual test for the link fetcher (runs on the Mac mini — needs Google Chrome):
//   node scripts/inbox-agent/fetch/cli.mjs --url "<EmailStart link>" [--code 1234] [--headed] [--out /tmp/dir] [--no-new-link]
// Prints each step, writes every document it pulled into --out (default
// /tmp/inbox-fetch/cli-<ts>/files), and the screenshot paths. No DB, no Drive.
// An expired link makes the flow click SEND NEW LINK (DocuSign emails ryan@ a
// fresh one) and exit with `needs: new_link`; --no-new-link only looks.
//
// f8 photo deliveries (no browser, plain fetch — briefs/BRIEF_INBOX_MEDIA_DELIVERY_2026-10-15.md):
//   node scripts/inbox-agent/fetch/cli.mjs --url "<download-center url>" --out /tmp/halleck-photos
// writes MLS/ and Print/ under --out with the photographer's filenames and prints the counts.
//
// One-time login (Phase 1b — Ryan runs this once on the mini over screen share):
//   node scripts/inbox-agent/fetch/cli.mjs --login --headed
// Opens https://account.docusign.com in the agent's persistent Chrome profile
// (~/.lrg/browser-profiles/inbox-agent, or $INBOX_BROWSER_PROFILE) and waits
// up to 10 min for the URL to leave the login flow, then exits. After that,
// app.docusign.com links open and the expired-link page's LOG IN route works
// for the worker too. Nothing is clicked by the script itself.
import fs from "node:fs"
import path from "node:path"
import { openBrowser, profileDir } from "./browser.mjs"
import { detectProvider, fetchDocuments } from "./index.mjs"

const argv = process.argv.slice(2)
const opt = (n) => {
  const i = argv.indexOf(`--${n}`)
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1]
  const eq = argv.find((a) => a.startsWith(`--${n}=`))
  return eq ? eq.slice(n.length + 3) : null
}
const log = (...a) => console.log(new Date().toISOString(), ...a)

// --login: a human signs in; the script only opens the page and waits.
const LOGIN_URL = "https://account.docusign.com"
const LOGIN_FLOW_RE = /^https?:\/\/(account(-d|-s)?\.docusign\.com|[^/]+\/[^?#]*\b(login|logon|signin|sign-in|oauth|auth|password|mfa|verify)\b)/i
if (argv.includes("--login")) {
  const { page, close } = await openBrowser({ headed: true })
  log(`profile ${profileDir()} · opening ${LOGIN_URL} — log in to DocuSign in the Chrome window; waiting up to 10 min`)
  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 })
    await page.waitForURL((u) => !LOGIN_FLOW_RE.test(u.href), { timeout: 10 * 60_000 })
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {})
    log(`logged in — landed on ${page.url()}; the profile now carries the DocuSign session`)
  } catch (e) {
    log(`gave up: ${e?.message || e} (still on ${page.url()})`)
    await close()
    process.exit(1)
  }
  await close()
  process.exit(0)
}

const url = opt("url")
if (!url) {
  console.error('usage: node scripts/inbox-agent/fetch/cli.mjs --url "<link>" [--code 1234] [--headed] [--out /tmp/dir] [--no-new-link]\n       node scripts/inbox-agent/fetch/cli.mjs --login --headed')
  process.exit(2)
}
const provider = detectProvider(url)
if (!provider) {
  console.error(`no provider recognises ${url}`)
  process.exit(2)
}
const jobId = `cli-${Date.now()}`
const out = opt("out") || path.join("/tmp/inbox-fetch", jobId, "files")
log(`provider ${provider} · job ${jobId} · out ${out}`)
const r = await fetchDocuments({ url, provider, accessCode: opt("code"), jobId, log, headed: argv.includes("--headed"), sendNewLink: !argv.includes("--no-new-link") })
if (!r.ok) {
  log(`FAILED: ${r.error}${r.needs ? ` (needs: ${r.needs})` : ""}`)
  if (r.screenshots?.length) log(`last screenshot: ${r.screenshots.at(-1)}`)
  process.exit(1)
}
fs.mkdirSync(out, { recursive: true })
if (r.sets) {
  // Media provider: one subdir per set, photographer filenames kept.
  for (const s of r.sets) {
    const dir = path.join(out, s.set)
    fs.mkdirSync(dir, { recursive: true })
    let bytes = 0
    for (const f of s.files) {
      fs.writeFileSync(path.join(dir, f.filename.replace(/[\\/:*?"<>|]/g, "-")), f.bytes)
      bytes += f.bytes.length
    }
    log(`  ${s.set}: ${s.files.length} file(s) · ${(bytes / 1024 / 1024).toFixed(1)} MB → ${dir}`)
  }
  log(`done: page says ${r.counts.page} images · MLS ${r.counts.mls} · Print ${r.counts.print} · groups ${r.groups.join(", ")} · steps ${r.steps.join(" → ")}`)
  process.exit(0)
}
for (const f of r.files) {
  const file = path.join(out, f.filename.replace(/[\\/:*?"<>|]/g, "-"))
  fs.writeFileSync(file, f.bytes)
  log(`  ${f.filename} · ${f.mime} · ${f.bytes.length} bytes → ${file}`)
}
log(`done: ${r.files.length} file(s) · steps ${r.steps.join(" → ")}${r.screenshots?.length ? ` · screenshots in ${path.dirname(r.screenshots[0])}` : ""}`)
