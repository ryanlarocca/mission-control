// Offer bot dry run (briefs/OFFER_BOT.md) — exercise the live pieces one at
// a time from the Mac mini after merge. Reads .env.local like the other
// scripts. Nothing here touches the draft in inbox_settings.
//
//   npx tsx scripts/offer-dry-run.ts parse "1234 Main St San Jose 95125, seller John Smith, 1.2M, 10k EMD, 30 day close"
//       → Sonnet parse + the normalised fields / missing / unclear (no Telegram, no Drive)
//   npx tsx scripts/offer-dry-run.ts fill [out.pdf]
//       → download the real template, fill it with sample terms, write the PDF locally
//   npx tsx scripts/offer-dry-run.ts drive
//       → resolve Business Operations/Offers/<sample street> (creates the folders), upload nothing
//   npx tsx scripts/offer-dry-run.ts telegram [out.pdf]
//       → sendDocument the local PDF to TELEGRAM_CHAT_ID (the only recipient there is)
//   npx tsx scripts/offer-dry-run.ts initdata
//       → print a signed initData for curl-testing /api/offer with the real bot token

import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const ENV_PATH = path.join(process.cwd(), ".env.local")
try {
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!m || process.env[m[1]] !== undefined) continue
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    process.env[m[1]] = v
  }
} catch {
  /* no .env.local — rely on the environment */
}

async function main() {
  const [cmd, arg] = process.argv.slice(2)
  const { fillOfferPdf, offerFilename, parseOfferTerms, blankFields, OFFER_TEMPLATE_FILE_ID, OFFER_DRIVE_ROOT_ID, offerDriveRelPath } = await import("@/lib/offerContract")
  const sample = {
    ...blankFields(),
    seller_name: "John and Mary Smith",
    property_address: "1234 Main St, San Jose, CA 95125",
    purchase_price: 1_200_000,
    earnest_money: 10_000,
    closing_days: 30,
    special_stipulations: ["Seller may leave the furniture in the property."],
    seller_signer_name: "John and Mary Smith",
    seller_tel: "(408) 555-1234",
  }

  if (cmd === "parse") {
    if (!arg) throw new Error('usage: parse "<terms>"')
    const out = await parseOfferTerms(arg)
    console.log(JSON.stringify(out, null, 2))
    return
  }
  if (cmd === "fill") {
    const { driveClient, downloadDriveFile } = await import("@/lib/drive")
    const drive = await driveClient()
    const template = await downloadDriveFile(drive, OFFER_TEMPLATE_FILE_ID)
    console.log(`template: ${template.length} bytes`)
    const out = await fillOfferPdf(template, sample)
    const file = arg || offerFilename(sample)
    writeFileSync(file, out.bytes)
    console.log(`filled: ${out.filled.join(", ")}`)
    if (out.absent.length) console.log(`ABSENT in template: ${out.absent.join(", ")}`)
    console.log(`wrote ${file} (${out.bytes.length} bytes)`)
    return
  }
  if (cmd === "drive") {
    const { driveClient, resolveDrivePath } = await import("@/lib/drive")
    const drive = await driveClient()
    const rel = offerDriveRelPath(sample)
    const folder = await resolveDrivePath(drive, OFFER_DRIVE_ROOT_ID, rel, { create: true })
    console.log(`${rel} → ${folder.id} (created: ${folder.created.join(", ") || "nothing"})`)
    return
  }
  if (cmd === "telegram") {
    const { sendOfferDocument, offerChatId } = await import("@/lib/offerBot")
    const chatId = offerChatId()
    if (chatId === null) throw new Error("TELEGRAM_CHAT_ID not set")
    const file = arg || offerFilename(sample)
    const bytes = readFileSync(file)
    const id = await sendOfferDocument(chatId, { filename: path.basename(file), bytes }, `📄 ${path.basename(file)} (dry run)`)
    console.log(`sent as message ${id}`)
    return
  }
  if (cmd === "initdata") {
    const { signTelegramInitData } = await import("@/lib/telegramWebApp")
    const token = process.env.CAMPAIGN_BOT_TOKEN
    const chat = process.env.TELEGRAM_CHAT_ID
    if (!token || !chat) throw new Error("CAMPAIGN_BOT_TOKEN / TELEGRAM_CHAT_ID not set")
    const initData = signTelegramInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: Number(chat), first_name: "Ryan" }) }, token)
    console.log(initData)
    console.log(`\ncurl "https://mission-control-three-chi.vercel.app/api/offer?initData=$(node -p 'encodeURIComponent(process.argv[1])' "${initData}")"`)
    return
  }
  console.log("usage: parse <terms> | fill [out.pdf] | drive | telegram [file.pdf] | initdata")
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e)
  process.exit(1)
})
