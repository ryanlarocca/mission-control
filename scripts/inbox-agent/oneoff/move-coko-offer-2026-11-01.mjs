// One-off (2026-11-01): Coko LLC's $1.5M as-is cash offer on 2116 Quito Rd (Amanda's
// forward, gmail 1a18e6e84306319c) was filed as if it were Ryan's own purchase chain
// ("03 Offer RPA" / "04 Contingency Removal" in Purchase & Sale) and the buyer's
// closing statement landed in a root-level "Offers/Received". Ryan is the SELLER on
// Quito now — inbound offers get their own folder under the property.
// Usage: node move-coko-offer-2026-11-01.mjs [--apply]
import { sb } from "../env.mjs"
import { driveClient, findRoot, resolvePath, moveFile, renameFile, folderPathOf, listChildren } from "../drive.mjs"

const APPLY = process.argv.includes("--apply")
const GMAIL_ID = "1a18e6e84306319c"
const DEST = "Properties/2116 Quito Rd/Offers"
const PREFIX = "Coko LLC $1.5M as-is cash offer 2026-10-30"
const NAMES = {
  purchase_agreement: `${PREFIX} - RPA.pdf`,
  contingency_removal: `${PREFIX} - Buyer Contingency Removal.pdf`,
  closing_statement: `${PREFIX} - Buyer Closing Statement.pdf`,
}

const drive = await driveClient()
const root = await findRoot(drive)
const rootId = root.id || root
const { data: rows, error } = await sb().from("inbox_files").select("id,doc_type,final_folder,final_name,drive_file_id,drive_folder_id").eq("gmail_id", GMAIL_ID).eq("status", "filed")
if (error) throw error
for (const r of rows) console.log("current:", r.doc_type, "|", r.final_folder, "/", r.final_name, "| folder path:", await folderPathOf(drive, r.drive_folder_id, rootId))

const dest = await resolvePath(drive, rootId, DEST, { create: APPLY })
console.log("dest:", DEST, "→", dest.id || `(missing: ${dest.missing})`, dest.created.length ? `created ${dest.created.join("/")}` : "")
if (!APPLY) { console.log("dry run — pass --apply to move"); process.exit(0) }

for (const r of rows) {
  const name = NAMES[r.doc_type]
  if (!name) { console.log("skip (no name rule):", r.doc_type, r.final_name); continue }
  await moveFile(drive, r.drive_file_id, dest.id)
  await renameFile(drive, r.drive_file_id, name)
  const { error: e2 } = await sb().from("inbox_files").update({ final_folder: DEST, final_name: name, drive_folder_id: dest.id }).eq("id", r.id)
  if (e2) throw e2
  console.log("moved:", r.final_name, "→", DEST, "/", name)
}
// Report what is left in the stray root-level Offers/Received (not deleted here).
const stray = rows.find((r) => r.final_folder === "Offers/Received")
if (stray) {
  const kids = await listChildren(drive, stray.drive_folder_id)
  console.log(`stray folder Offers/Received (${stray.drive_folder_id}) now holds ${kids.length} item(s):`, kids.map((k) => k.name).join(", ") || "(empty)")
}
