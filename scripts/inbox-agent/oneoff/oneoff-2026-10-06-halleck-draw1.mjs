#!/usr/bin/env node
// One-off, Ryan 2026-10-06: Kiavi's "Draw 1 - 5764 Halleck Drive" email carried three
// attachments; only the lien package filed (to Loan & Insurance) and the DRF spreadsheet
// was dropped as an "invoice". Ryan: "I really need the DRF… anything related to a draw
// request goes in the Construction folder."
//   1. File the DRF xlsx → Properties/5764 Halleck Dr/Construction (as draw_request).
//   2. Move the already-filed lien package into Construction too.
//   3. Post one corrected confirmation card.
// Run with --apply to write; without it, prints what it would do.
import { loadEnvLocal, sb } from "../env.mjs"
const isoNow = () => new Date().toISOString()
import { addLabel, getAttachmentBytes, gmailClient } from "../gmail.mjs"
import { driveClient, findFileByName, findRoot, moveFile, resolvePath, uploadFile } from "../drive.mjs"
import { esc, tgSend } from "../telegram.mjs"

loadEnvLocal()
const APPLY = process.argv.includes("--apply")
const DRF_ID = "7d3147d4-9b8a-4c57-bfa2-66b9e918c944"
const LIEN_ID = "28d7ceac-0f67-4da6-817b-8936f0c2c2ce"
const FOLDER = "Properties/5764 Halleck Dr/Construction"
const say = (...a) => console.log(...a)

const { data: drf } = await sb().from("inbox_files").select("*").eq("id", DRF_ID).single()
const { data: lien } = await sb().from("inbox_files").select("*").eq("id", LIEN_ID).single()
say("DRF row:", drf.status, drf.filename)
say("Lien row:", lien.status, lien.final_folder, lien.drive_file_id)

const drive = await driveClient()
const root = await findRoot(drive)
const { id: folderId, created } = await resolvePath(drive, root, FOLDER, { create: APPLY })
say("Construction folder:", folderId || "(would create)", created?.length ? `created ${created.join("/")}` : "")
if (!APPLY) { say("dry run — nothing written"); process.exit(0) }

const gmail = await gmailClient()
const filed = []

// 1. DRF
let drfUrl = drf.drive_url
const existing = await findFileByName(drive, folderId, drf.filename)
if (existing) { say("DRF already in Construction:", existing.webViewLink); drfUrl = existing.webViewLink }
else {
  const bytes = await getAttachmentBytes(gmail, drf.gmail_id, drf.attachment_id)
  const up = await uploadFile(drive, folderId, drf.filename, drf.mime, bytes)
  drfUrl = up.webViewLink
  await sb().from("inbox_files").update({ status: "filed", mode: "backfill", doc_type: "draw_request", final_folder: FOLDER, final_name: drf.filename, drive_file_id: up.id, drive_folder_id: folderId, drive_url: up.webViewLink, filed_at: isoNow(), resolved_at: isoNow(), error: null }).eq("id", DRF_ID)
  await addLabel(gmail, drf.gmail_id, "MC/Filed")
  say("filed DRF →", up.webViewLink)
}
filed.push({ id: DRF_ID, name: drf.filename, url: drfUrl })

// 2. Lien package → Construction
if (lien.drive_file_id && lien.final_folder !== FOLDER) {
  await moveFile(drive, lien.drive_file_id, folderId)
  await sb().from("inbox_files").update({ doc_type: "draw_request", final_folder: FOLDER, drive_folder_id: folderId }).eq("id", LIEN_ID)
  say("moved lien package → Construction")
}
filed.push({ id: LIEN_ID, name: lien.final_name, url: lien.drive_url })

// 3. Corrected card
const lines = [
  `🗂 <b>Corrected — Draw 1, 5764 Halleck Dr</b> (Kiavi Draws Dept · Oct 6)`,
  `The email had 3 attachments; only the lien package filed and the DRF was dropped as an "invoice". Fixed:`,
  ...filed.map((f) => `• <a href="${f.url}">5764 Halleck Dr/Construction/${esc(f.name)}</a>`),
  `• Standard Quick Start Guide.pdf — generic Kiavi guide, not filed (same PDF as Oct 5)`,
  `From now on, draw paperwork from any lender (DRF, lien package/waivers, draw schedules, approvals) files straight to Construction.`,
]
const mid = await tgSend(lines.join("\n"), { rows: filed.map((f) => [{ text: `↩️ Undo ${f.name.slice(0, 28)}`, data: `ix:fu:${f.id}` }]) })
if (mid) await sb().from("inbox_files").update({ tg_message_id: mid }).in("id", filed.map((f) => f.id))
say("card posted", mid)
