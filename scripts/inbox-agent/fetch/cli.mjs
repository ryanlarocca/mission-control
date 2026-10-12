#!/usr/bin/env node
// Manual test for the link fetcher (runs on the Mac mini — needs Google Chrome):
//   node scripts/inbox-agent/fetch/cli.mjs --url "<EmailStart link>" [--code 1234] [--headed] [--out /tmp/dir]
// Prints each step, writes every document it pulled into --out (default
// /tmp/inbox-fetch/cli-<ts>/files), and the screenshot paths. No DB, no Drive.
import fs from "node:fs"
import path from "node:path"
import { detectProvider, fetchDocuments } from "./index.mjs"

const argv = process.argv.slice(2)
const opt = (n) => {
  const i = argv.indexOf(`--${n}`)
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1]
  const eq = argv.find((a) => a.startsWith(`--${n}=`))
  return eq ? eq.slice(n.length + 3) : null
}
const url = opt("url")
if (!url) {
  console.error('usage: node scripts/inbox-agent/fetch/cli.mjs --url "<link>" [--code 1234] [--headed] [--out /tmp/dir]')
  process.exit(2)
}
const provider = detectProvider(url)
if (!provider) {
  console.error(`no provider recognises ${url}`)
  process.exit(2)
}
const jobId = `cli-${Date.now()}`
const out = opt("out") || path.join("/tmp/inbox-fetch", jobId, "files")
const log = (...a) => console.log(new Date().toISOString(), ...a)
log(`provider ${provider} · job ${jobId} · out ${out}`)
const r = await fetchDocuments({ url, provider, accessCode: opt("code"), jobId, log, headed: argv.includes("--headed") })
if (!r.ok) {
  log(`FAILED: ${r.error}${r.needs ? ` (needs: ${r.needs})` : ""}`)
  if (r.screenshots?.length) log(`last screenshot: ${r.screenshots.at(-1)}`)
  process.exit(1)
}
fs.mkdirSync(out, { recursive: true })
for (const f of r.files) {
  const file = path.join(out, f.filename.replace(/[\\/:*?"<>|]/g, "-"))
  fs.writeFileSync(file, f.bytes)
  log(`  ${f.filename} · ${f.mime} · ${f.bytes.length} bytes → ${file}`)
}
log(`done: ${r.files.length} file(s) · steps ${r.steps.join(" → ")}${r.screenshots?.length ? ` · screenshots in ${path.dirname(r.screenshots[0])}` : ""}`)
