// Send a designed batch of UNIQUE test emails through the engine's send path
// (same MIME builder + auth as scripts/campaign-engine.mjs) to one of Ryan's
// own inboxes, spaced N minutes apart. Test-inbox protocol (brief
// 2026-08-21): unique bodies only, [Xn] subject tags, never a real agent.
//
//   node scripts/campaign-test-batch.mjs --file=briefs/tests/phaseA-1.json \
//        --from=ryan.lrghomes@gmail.com --to=ryanlarocca44@gmail.com [--gap=2] [--dry-run]
//
// File = JSON array of { tag, subject, body, unsub?: boolean } — the tag is
// prefixed to the subject as "[tag] ". Progress is logged per send.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { gmailClientFor, sendCampaignMessage } from "./campaign-gmail.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")
for (const line of fs.readFileSync(path.join(REPO_ROOT, ".env.local"), "utf-8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line)
  if (!m) continue
  let v = m[2]
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  if (process.env[m[1]] === undefined) process.env[m[1]] = v
}

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const file = arg("file")
const from = arg("from")
const to = arg("to")
const gapMin = Number(arg("gap") ?? 2)
const dryRun = process.argv.includes("--dry-run")
if (!file || !from || !to) {
  console.error("usage: --file=<json> --from=<mailbox> --to=<inbox> [--gap=min] [--dry-run]")
  process.exit(2)
}
// Hard guard: test batches only ever go to Ryan's own inboxes.
const ALLOWED_TO = /^(ryanlarocca\d*@gmail\.com|ryan\.lrghomes@gmail\.com|[a-z0-9.]+@lrghomes\.com)$/i
if (!ALLOWED_TO.test(to)) {
  console.error(`refusing: ${to} is not one of Ryan's inboxes`)
  process.exit(2)
}

const items = JSON.parse(fs.readFileSync(path.resolve(REPO_ROOT, file), "utf-8"))
const seen = new Set()
for (const it of items) {
  if (!it.tag || !it.subject || !it.body) throw new Error(`bad item: ${JSON.stringify(it).slice(0, 80)}`)
  const key = it.body.replace(/\s+/g, " ").trim()
  if (seen.has(key)) throw new Error(`duplicate body in batch: ${it.tag}`)
  seen.add(key)
}

const ts = () => new Date().toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour12: false })
console.log(`${ts()} batch of ${items.length} from ${from} → ${to}, ${gapMin} min apart${dryRun ? " (DRY RUN)" : ""}`)
const gmail = dryRun ? null : await gmailClientFor(from)
for (let i = 0; i < items.length; i++) {
  const it = items[i]
  const subject = `[${it.tag}] ${it.subject}`
  if (dryRun) {
    console.log(`${ts()} would send ${subject} (${it.body.length} chars${it.unsub ? ", +List-Unsubscribe" : ""})`)
  } else {
    try {
      const msg = await sendCampaignMessage(gmail, {
        from,
        to,
        subject,
        body: it.body,
        contactId: it.unsub ? "00000000-0000-0000-0000-00000000test" : null,
        unsubHeaders: !!it.unsub,
      })
      console.log(`${ts()} sent ${subject} → gmail id ${msg.id}`)
    } catch (e) {
      console.error(`${ts()} FAILED ${subject}: ${e?.message ?? e}`)
      process.exit(1)
    }
  }
  if (i < items.length - 1) await new Promise((r) => setTimeout(r, gapMin * 60_000))
}
console.log(`${ts()} batch done`)
