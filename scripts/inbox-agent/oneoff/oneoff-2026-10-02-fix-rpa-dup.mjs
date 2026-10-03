#!/usr/bin/env node
// One-off 2026-10-02: the Halleck backfill re-run uploaded the 8/25 RPA a second time as
// "02 Offer RPA 2026-08-25.pdf" (first run's DB row had failed, so the by-name match missed).
// Keep "01 …", trash "02 …", point the inbox_files row at the survivor. Also print both folders.
import { loadEnvLocal, sb } from "../env.mjs"
import { driveClient, findRoot, listChildren, resolvePath } from "../drive.mjs"
loadEnvLocal()
const drive = await driveClient()
const root = await findRoot(drive)
const FOLDER = "application/vnd.google-apps.folder"
const { id: ps } = await resolvePath(drive, root, "Properties/5764 Halleck Dr/Purchase & Sale")
const kids = await listChildren(drive, ps)
const one = kids.find((k) => k.name === "01 Offer RPA 2026-08-25.pdf")
const two = kids.find((k) => k.name === "02 Offer RPA 2026-08-25.pdf")
if (one && two) {
  const { error } = await sb().from("inbox_files").update({ final_name: one.name, drive_file_id: one.id, drive_url: one.webViewLink }).eq("drive_file_id", two.id)
  console.log("db repointed:", error ? error.message : "ok")
  await drive.files.update({ fileId: two.id, requestBody: { trashed: true }, supportsAllDrives: true })
  console.log("trashed duplicate", two.name)
} else console.log("nothing to fix:", kids.map((k) => k.name))
for (const p of ["Properties/5764 Halleck Dr", "Properties/2116 Quito Rd"]) {
  const { id } = await resolvePath(drive, root, p)
  console.log(`\n${p}/`)
  for (const k of await listChildren(drive, id)) {
    console.log("  " + k.name + (k.mimeType === FOLDER ? "/" : ""))
    if (k.mimeType === FOLDER) for (const g of await listChildren(drive, k.id)) console.log("    " + g.name)
  }
}
