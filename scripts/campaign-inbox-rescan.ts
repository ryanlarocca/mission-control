// One-off / ad-hoc rescan of the campaign sending mailboxes with a custom
// Gmail search, through the SAME pipeline the Pub/Sub path uses
// (lib/campaignInbox.ts): bounces mark the contact, replies get AI triage +
// the Telegram AGENT REPLY alert, matched messages are moved out of Spam.
// Already-processed messages (campaign_events.raw.gmail_id) are skipped, so
// re-running is safe.
//
//   npx tsx scripts/campaign-inbox-rescan.ts "in:spam after:2026/09/30"
//   npx tsx scripts/campaign-inbox-rescan.ts "(in:inbox OR in:spam) newer_than:3d" ryan@lrghomesbuys.com
//
// Written 2026-10-27 to pick up the three messages Gmail had filed in Spam
// before the scanner read that folder.
import { readFileSync } from "node:fs"

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
for (const line of envText.split(/\r?\n/)) {
  const eq = line.indexOf("=")
  if (eq < 0 || line.trim().startsWith("#")) continue
  const key = line.slice(0, eq).trim()
  let val = line.slice(eq + 1).trim()
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
  if (process.env[key] === undefined) process.env[key] = val
}

const query = process.argv[2]
const mailbox = process.argv[3]
if (!query) {
  console.error('usage: npx tsx scripts/campaign-inbox-rescan.ts "<gmail search>" [mailbox]')
  process.exit(1)
}

async function main() {
  const { CAMPAIGN_INBOXES, processCampaignInbox } = await import("@/lib/campaignInbox")
  const boxes = mailbox ? [mailbox] : CAMPAIGN_INBOXES
  for (const box of boxes) {
    console.log(`\n[rescan] ${box} — ${query}`)
    await processCampaignInbox(box, undefined, { query, maxResults: 100 })
  }
  console.log("\n[rescan] done")
}
main().catch((e) => { console.error(e); process.exit(1) })
