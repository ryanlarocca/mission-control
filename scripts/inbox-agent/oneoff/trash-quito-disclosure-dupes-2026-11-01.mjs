// One-off (2026-11-01): the 2116 Quito Rd disclosure set was filed three times
// (DocuSign attachments + the same envelope fetched behind the link, then a second
// envelope's re-send). Keeps the attachment copies (Ryan's spelling), trashes the
// DocuSign-fetched twins and DocuSign's Summary.pdf, marks the rows duplicate.
// The 10-31 NHD (re-signed, 22 KB bigger) is kept as a version — only its
// fetched twin goes. Usage: node trash-quito-disclosure-dupes-2026-11-01.mjs [--apply]
import { sb } from "../env.mjs"
import { driveClient } from "../drive.mjs"
import { sameDocName } from "../filing.mjs"

const APPLY = process.argv.includes("--apply")
const { data: rows, error } = await sb().from("inbox_files").select("id,gmail_id,filename,final_name,final_folder,drive_file_id,source,size_bytes,doc_type,status").eq("property_key", "2116quito").in("doc_type", ["disclosure", "nhd"]).eq("status", "filed").order("created_at")
if (error) throw error
const keep = rows.filter((r) => r.source === "attachment")
const trash = []
for (const r of rows) {
  if (r.source === "attachment") continue
  if (/^summary\.pdf$/i.test(r.filename)) { trash.push({ r, why: "DocuSign certificate of completion, not a disclosure" }); continue }
  const twin = keep.find((k) => k.gmail_id === r.gmail_id && sameDocName(k.filename, r.filename))
  if (twin) trash.push({ r, why: `same document as attachment "${twin.final_name}" on the same email` })
  else console.log("keep  ", r.source, r.final_name, "(no attachment twin)")
}
for (const k of keep) console.log("keep  ", k.source, k.final_name)
for (const { r, why } of trash) console.log("TRASH ", r.source, r.final_folder + "/" + r.final_name, "—", why)
console.log(`\n${trash.length} to trash, ${keep.length} kept`)
if (!APPLY) { console.log("dry run — pass --apply"); process.exit(0) }
const drive = await driveClient()
for (const { r, why } of trash) {
  await drive.files.update({ fileId: r.drive_file_id, requestBody: { trashed: true }, supportsAllDrives: true })
  const { error: e } = await sb().from("inbox_files").update({ status: "duplicate", error: `trashed 2026-11-01: ${why}`, resolved_at: new Date().toISOString() }).eq("id", r.id)
  if (e) throw e
  console.log("trashed", r.final_name)
}
