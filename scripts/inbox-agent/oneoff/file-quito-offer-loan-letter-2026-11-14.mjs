// One-off (2026-11-14): the $1.499M offer on 2116 Quito Rd (gmail 1a1d7431057abeb6).
// The buyer's lender pre-qualification letter was filed as "Proof of Funds" (there
// was no loan_letter doc type yet), and the real proof of funds, a .jpg, was
// skipped as an inline image. This renames the letter and files the photo.
// Usage: node file-quito-offer-loan-letter-2026-11-14.mjs [--apply]
import crypto from "node:crypto"
import { loadEnvLocal, sb } from "../env.mjs"
import { getAttachmentBytes, getMessage, gmailClient } from "../gmail.mjs"
import { driveClient, findFileByName, renameFile, uploadFile } from "../drive.mjs"
import { offerDocName } from "../filing.mjs"

loadEnvLocal()
const APPLY = process.argv.includes("--apply")
const GMAIL_ID = "1a1d7431057abeb6"

const gmail = await gmailClient()
const drive = await driveClient()
const msg = await getMessage(gmail, GMAIL_ID)
const { data: rows, error } = await sb().from("inbox_files").select("*").eq("gmail_id", GMAIL_ID).eq("status", "filed")
if (error) throw error

// 1. The lender letter: right folder, wrong label.
const letter = rows.find((r) => /pre-?qualif/i.test(r.filename))
if (!letter) throw new Error("lender letter row not found")
const letterName = offerDocName({ docType: "loan_letter", filename: letter.filename, receivedAt: msg.internalDate })
console.log("letter:", letter.final_name, "→", letterName, letter.doc_type === "loan_letter" ? "(already done)" : "")

// 2. The proof of funds photo: never filed.
const att = msg.attachments.find((a) => /^POF\b/i.test(a.filename) && /^image\//.test(a.mime))
if (!att) throw new Error("proof of funds image not found on the message")
const bytes = await getAttachmentBytes(gmail, GMAIL_ID, att.attachmentId)
const hash = crypto.createHash("sha256").update(bytes).digest("hex")
const pofName = offerDocName({ docType: "proof_of_funds", filename: att.filename, receivedAt: msg.internalDate })
const pofRow = rows.find((r) => r.sha256 === hash)
console.log("proof of funds:", att.filename, `(${bytes.length} bytes)`, "→", `${letter.final_folder}/${pofName}`, pofRow ? "(already filed)" : "")
if (!APPLY) { console.log("dry run — pass --apply"); process.exit(0) }

if (letter.doc_type !== "loan_letter") {
  await renameFile(drive, letter.drive_file_id, letterName)
  const { error: e1 } = await sb().from("inbox_files").update({ doc_type: "loan_letter", final_name: letterName }).eq("id", letter.id)
  if (e1) throw e1
  console.log("renamed the letter")
}
if (!pofRow) {
  const up = (await findFileByName(drive, letter.drive_folder_id, pofName)) || (await uploadFile(drive, letter.drive_folder_id, pofName, att.mime, bytes))
  const now = new Date().toISOString()
  const { error: e2 } = await sb().from("inbox_files").insert({
    gmail_id: GMAIL_ID, thread_id: msg.threadId, attachment_id: att.attachmentId, part_id: att.partId, filename: att.filename, mime: att.mime, size_bytes: bytes.length, sha256: hash,
    sender: letter.sender, subject: letter.subject, received_at: letter.received_at, property_key: letter.property_key, property_label: letter.property_label, doc_type: "proof_of_funds",
    status: "filed", mode: "backfill", final_folder: letter.final_folder, final_name: pofName, drive_file_id: up.id, drive_folder_id: letter.drive_folder_id, drive_url: up.webViewLink, filed_at: now, resolved_at: now,
  })
  if (e2) throw e2
  console.log("filed the proof of funds:", up.webViewLink || up.id)
}
