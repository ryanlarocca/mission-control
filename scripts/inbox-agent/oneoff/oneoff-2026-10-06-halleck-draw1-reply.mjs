#!/usr/bin/env node
// One-off, Ryan 2026-10-06: Halleck Draw 1 — replace the DRF in Drive with the filled
// copy (same file id, so links on the Telegram card keep working) and leave a reply
// draft in ryan@'s Gmail on Kiavi's thread with the DRF attached. Nothing is sent.
//   node oneoff-2026-10-06-halleck-draw1-reply.mjs <filled.xlsx> [--apply]
import fs from "node:fs"
import path from "node:path"
import { google } from "googleapis"
import { loadEnvLocal, sb } from "../env.mjs"
import { gmailClient, getMessage } from "../gmail.mjs"
import { driveClient } from "../drive.mjs"

loadEnvLocal()
const APPLY = process.argv.includes("--apply")
const FILLED = process.argv.find((a) => a.endsWith(".xlsx"))
if (!FILLED || !fs.existsSync(FILLED)) throw new Error("pass the filled .xlsx path")
const DRF_ROW = "7d3147d4-9b8a-4c57-bfa2-66b9e918c944"
const KIAVI_MSG = "1a1129cb24681c43"
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const say = (...a) => console.log(...a)

const { data: row } = await sb().from("inbox_files").select("filename, drive_file_id, drive_url").eq("id", DRF_ROW).single()
say("Drive file:", row.drive_file_id, row.filename)
const gmail = await gmailClient()
const kiavi = await getMessage(gmail, KIAVI_MSG)
say("Replying to:", kiavi.from.email, "|", kiavi.subject, "| Message-ID", kiavi.messageId, "| thread", kiavi.threadId)

const body = [
  "Hi Jackie,",
  "",
  "Attached is the completed draw request form for Draw 1 at 5764 Halleck Drive. We're requesting $15,000 against Division 02 (Demolition) — demo is complete.",
  "",
  "Invoice and unconditional lien waiver for the demo work to follow shortly. Go ahead and order the inspection whenever you're ready.",
  "",
  "Thanks,",
  "Ryan LaRocca",
  "LRG Homes LLC",
  "408-458-5442",
].join("\r\n")

const subject = kiavi.subject.startsWith("Re:") ? kiavi.subject : `Re: ${kiavi.subject}`
const boundary = "lrg-" + Date.now().toString(36)
const attName = path.basename(FILLED) === "filled.xlsx" ? row.filename : path.basename(FILLED)
const raw = [
  `From: Ryan LaRocca <ryan@lrghomes.com>`,
  `To: Kiavi Draws Dept <draws@kiavi.com>`,
  `Subject: ${subject}`,
  `In-Reply-To: ${kiavi.messageId}`,
  `References: ${[kiavi.inReplyTo, kiavi.messageId].filter(Boolean).join(" ")}`,
  `MIME-Version: 1.0`,
  `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ``,
  `--${boundary}`,
  `Content-Type: text/plain; charset="UTF-8"`,
  `Content-Transfer-Encoding: 7bit`,
  ``,
  body,
  ``,
  `--${boundary}`,
  `Content-Type: ${XLSX}; name="${attName}"`,
  `Content-Disposition: attachment; filename="${attName}"`,
  `Content-Transfer-Encoding: base64`,
  ``,
  fs.readFileSync(FILLED).toString("base64").replace(/(.{76})/g, "$1\r\n"),
  `--${boundary}--`,
].join("\r\n")

say("\n--- draft body ---\n" + body + "\n--- attachment: " + attName + ` (${fs.statSync(FILLED).size} bytes) ---`)
if (!APPLY) { say("dry run — nothing written"); process.exit(0) }

// 1. Replace the Drive file contents in place (same id).
const drive = await driveClient()
const up = await drive.files.update({ fileId: row.drive_file_id, media: { mimeType: XLSX, body: fs.createReadStream(FILLED) }, fields: "id, name, webViewLink, modifiedTime", supportsAllDrives: true })
say("Drive replaced:", up.data.name, up.data.modifiedTime, up.data.webViewLink)

// 2. Gmail draft on Kiavi's thread.
const encoded = Buffer.from(raw).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
const draft = await gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw: encoded, threadId: kiavi.threadId } } })
say("Draft created:", draft.data.id, "message", draft.data.message?.id)
