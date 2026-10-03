#!/usr/bin/env node
// One-off, approved by Ryan 2026-10-02 (session "Drive filing cleanup"):
//   - Halleck: fix the "Construction " folder name (trailing space)
//   - Halleck + Quito: standard subfolder set
//   - Move the 2116 Quito Rd RPA (misfiled in 5764 Halleck Dr) into Quito/Purchase & Sale, numbered
//   - Move the 9/29 Halleck buyer statement into Title & Escrow with the dated name
// Idempotent: re-running only reports. Run from the repo root with .env.local present.
import { loadEnvLocal, sb } from "../env.mjs"
import { driveClient, findRoot, listChildren, resolvePath } from "../drive.mjs"

loadEnvLocal()
const drive = await driveClient()
const root = await findRoot(drive)
const FOLDER = "application/vnd.google-apps.folder"
const SUBS = ["Purchase & Sale", "Disclosures", "Inspections", "Title & Escrow", "Loan & Insurance", "Construction", "Photos"]

const HALLECK_CONSTRUCTION_SPACE = "1ObyENQBEgy3vAZv4Aj0isD23YzvqXRb8"
const QUITO_RPA_IN_HALLECK = "13FAWBpiCdmH6lPW_7KAzmDYmfuFrCg--"
const HALLECK_STATEMENT_0929 = "1jfWhduh5JObjUWIkOIrfpyZb0Rq2MpEY"

async function step(label, fn) {
  try {
    const r = await fn()
    console.log("✓", label, r ?? "")
    return r
  } catch (e) {
    console.log("✗", label, e?.response?.data?.error?.message || e.message)
    return null
  }
}
async function relocate(fileId, toFolderId, newName) {
  const { data } = await drive.files.get({ fileId, fields: "parents,name", supportsAllDrives: true })
  if ((data.parents || []).includes(toFolderId) && data.name === newName) return "already there"
  await drive.files.update({ fileId, addParents: toFolderId, removeParents: (data.parents || []).join(","), requestBody: { name: newName }, fields: "id,name,parents", supportsAllDrives: true })
  return `moved (was "${data.name}")`
}

await step("Halleck: 'Construction ' → 'Construction'", async () => {
  const { data } = await drive.files.get({ fileId: HALLECK_CONSTRUCTION_SPACE, fields: "name", supportsAllDrives: true })
  if (data.name === "Construction") return "already clean"
  await drive.files.update({ fileId: HALLECK_CONSTRUCTION_SPACE, requestBody: { name: "Construction" }, supportsAllDrives: true })
  return "renamed"
})

for (const prop of ["5764 Halleck Dr", "2116 Quito Rd"]) {
  for (const s of SUBS) {
    await step(`ensure Properties/${prop}/${s}`, async () => {
      const r = await resolvePath(drive, root, `Properties/${prop}/${s}`, { create: true })
      return r.created.length ? "created" : "exists"
    })
  }
}

const quitoPS = (await resolvePath(drive, root, "Properties/2116 Quito Rd/Purchase & Sale")).id
const halleckTE = (await resolvePath(drive, root, "Properties/5764 Halleck Dr/Title & Escrow")).id

await step("Quito RPA → Properties/2116 Quito Rd/Purchase & Sale/01 Offer RPA 2026-09-24.pdf", () => relocate(QUITO_RPA_IN_HALLECK, quitoPS, "01 Offer RPA 2026-09-24.pdf"))

await step("Halleck buyer statement → Title & Escrow (dated)", async () => {
  const name = "5764 Halleck Dr Buyer Statement 2026-09-29 estimated.pdf"
  const r = await relocate(HALLECK_STATEMENT_0929, halleckTE, name)
  const { error } = await sb().from("inbox_files").update({ final_folder: "Properties/5764 Halleck Dr/Title & Escrow", final_name: name, drive_folder_id: halleckTE }).eq("drive_file_id", HALLECK_STATEMENT_0929)
  return `${r}; db ${error ? "error: " + error.message : "updated"}`
})

for (const p of ["Properties/5764 Halleck Dr", "Properties/2116 Quito Rd", "Properties/Halleck"]) {
  const { id } = await resolvePath(drive, root, p)
  if (!id) {
    console.log(`\n${p}/ (missing)`)
    continue
  }
  console.log(`\n${p}/`)
  for (const k of await listChildren(drive, id)) {
    console.log("  " + k.name + (k.mimeType === FOLDER ? "/" : ""))
    if (k.mimeType === FOLDER) for (const g of await listChildren(drive, k.id)) console.log("    " + g.name)
  }
}
