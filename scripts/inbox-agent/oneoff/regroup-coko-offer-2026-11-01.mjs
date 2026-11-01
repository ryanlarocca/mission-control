// One-off (2026-11-01, part 2): Ryan wants each offer he receives packaged in its
// own folder — Properties/2116 Quito Rd/Offers/<buyer> <price> offer <date>/ — with
// the proof of funds and the escrow wire sheet in it. Moves the three files
// re-filed earlier today, pulls the two dropped attachments from Gmail, and rewrites
// the inbox_files rows so the worker's dedupe knows them. Names come from the
// same helpers the live rule uses.
// Usage: node regroup-coko-offer-2026-11-01.mjs [--apply]
import { sb } from "../env.mjs"
const isoNow = () => new Date().toISOString()
import { driveClient, findRoot, resolvePath, moveFile, renameFile, listChildren, uploadFile } from "../drive.mjs"
import { gmailClient, getAttachmentBytes } from "../gmail.mjs"
import { offerDocName, offerPackageFolder } from "../filing.mjs"

const APPLY = process.argv.includes("--apply")
const GMAIL_ID = "1a18e6e84306319c"
const RECEIVED = "2026-10-30T20:09:07+00:00"
const OFFER = { buyer: "Coko LLC", price: 1500000 }
const PKG = offerPackageFolder({ ...OFFER, receivedAt: RECEIVED })
const DEST = `Properties/2116 Quito Rd/Offers/${PKG}`
const RETYPE = { "Coko LLC POF - October 2026.pdf": "proof_of_funds", "Sky Escrow ABA.pdf": "escrow_instructions" }

const drive = await driveClient()
const root = await findRoot(drive)
const rootId = root.id || root
const { data: rows, error } = await sb().from("inbox_files").select("id,filename,doc_type,status,final_folder,final_name,drive_file_id,attachment_id,mime").eq("gmail_id", GMAIL_ID).order("created_at")
if (error) throw error
const dest = await resolvePath(drive, rootId, DEST, { create: APPLY })
console.log("package folder:", DEST, "→", dest.id || `(missing: ${dest.missing})`)
for (const r of rows) {
  const docType = RETYPE[r.filename] || r.doc_type
  const name = offerDocName({ docType, filename: r.filename, receivedAt: RECEIVED })
  if (r.status === "filed") console.log(`move   ${r.final_folder}/${r.final_name}  →  ${DEST}/${name}`)
  else if (RETYPE[r.filename]) console.log(`upload ${r.filename} (${docType})  →  ${DEST}/${name}`)
  else { console.log(`leave  ${r.filename} (${r.doc_type}, ${r.status})`); continue }
  if (!APPLY) continue
  if (r.status === "filed") {
    await moveFile(drive, r.drive_file_id, dest.id)
    await renameFile(drive, r.drive_file_id, name)
    const { error: e } = await sb().from("inbox_files").update({ final_folder: DEST, final_name: name, drive_folder_id: dest.id, doc_type: docType }).eq("id", r.id)
    if (e) throw e
  } else {
    const gmail = await gmailClient()
    const bytes = await getAttachmentBytes(gmail, GMAIL_ID, r.attachment_id)
    const up = await uploadFile(drive, dest.id, name, r.mime, bytes)
    const { error: e } = await sb().from("inbox_files").update({ status: "filed", doc_type: docType, property_key: "2116quito", property_label: "2116 Quito Rd", final_folder: DEST, final_name: name, drive_file_id: up.id, drive_folder_id: dest.id, drive_url: up.webViewLink, filed_at: isoNow(), resolved_at: isoNow(), error: null }).eq("id", r.id)
    if (e) throw e
  }
}
if (APPLY) {
  const kids = await listChildren(drive, dest.id)
  console.log(`\n${DEST}:`); for (const k of kids) console.log("   ", k.name)
  const { id: offersId } = await resolvePath(drive, rootId, "Properties/2116 Quito Rd/Offers")
  const left = (await listChildren(drive, offersId)).filter((k) => k.mimeType !== "application/vnd.google-apps.folder")
  console.log(`loose files left directly in Offers/: ${left.length}`)
} else console.log("\ndry run — pass --apply")
