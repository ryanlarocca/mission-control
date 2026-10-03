#!/usr/bin/env node
// One-off, approved by Ryan 2026-10-02: clear the Telegram backlog without re-approvals.
//   1. Dominic Wooten's three farm lists → Marketing/2026/NOO October2026 (Ryan's folder).
//   2. Every other pending/batch/asked/waiting proposal: duplicate of something now filed → "duplicate";
//      otherwise "skipped" (not on the whitelist, superseded, or Ridgeview — left alone).
//   3. Clear the inline buttons on those cards; close the ❓ interview rows.
//   4. Learned rules: Ridgeview path back to "93 Ridgeview"; buyer statements → Title & Escrow, dated;
//      new manual rule for Dominic's lists.
//   5. Convention v2 (briefs/INBOX_FILING_RULES.md) → inbox_settings.rules (approved).
//   6. inbox_settings.agent.sides — Halleck + Quito are purchases → "buyer" statements.
// Run with --apply to write; without it, prints what it would do.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { REPO_ROOT, getSetting, loadEnvLocal, sb, setSetting } from "../env.mjs"
import { getAttachmentBytes, gmailClient, addLabel } from "../gmail.mjs"
import { driveClient, findExtraRoots, findFileByName, findRoot, resolvePath, uploadFile } from "../drive.mjs"
import { tgClearButtons } from "../telegram.mjs"

loadEnvLocal()
const APPLY = process.argv.includes("--apply")
const now = new Date().toISOString()
const say = (...a) => console.log(...a)

const drive = await driveClient()
const root = await findRoot(drive)
const extra = await findExtraRoots(drive)
say("extra roots:", extra)
if (!extra.marketing) {
  console.error("Marketing folder is not visible to ryan@lrghomes.com yet — share it (Editor) and re-run.")
  process.exit(1)
}

// 1. Dominic's lists
const { data: lists } = await sb().from("inbox_files").select("*").eq("sender", "dominic.wooten@ctt.com").ilike("filename", "%.csv").in("status", ["asked", "pending", "batch", "waiting", "pending_post"])
const gmail = await gmailClient()
const listFolder = "Marketing/2026/NOO October2026"
for (const row of lists || []) {
  say(`list → ${listFolder}/${row.filename}`)
  if (!APPLY) continue
  const { id: folderId } = await resolvePath(drive, root, listFolder, { create: true })
  const bytes = await getAttachmentBytes(gmail, row.gmail_id, row.attachment_id)
  const existing = await findFileByName(drive, folderId, row.filename)
  const up = existing || (await uploadFile(drive, folderId, row.filename, "text/csv", bytes))
  await sb().from("inbox_files").update({ status: "filed", mode: "backfill", doc_type: "marketing_list", final_folder: listFolder, final_name: row.filename, drive_file_id: up.id, drive_folder_id: folderId, drive_url: up.webViewLink, filed_at: now, resolved_at: now, error: null }).eq("id", row.id)
  await addLabel(gmail, row.gmail_id, "MC/Filed")
}

// 2. + 3. the rest of the backlog
const { data: backlog } = await sb().from("inbox_files").select("id, filename, sha256, status, tg_message_id, proposed_folder, sender").in("status", ["pending", "batch", "asked", "waiting", "pending_post", "change_requested", "approved", "changed"])
const cardIds = new Set()
for (const row of backlog || []) {
  const { data: dup } = row.sha256 ? await sb().from("inbox_files").select("id, final_folder, final_name").eq("sha256", row.sha256).eq("status", "filed").limit(1) : { data: [] }
  const next = dup?.length ? { status: "duplicate", final_folder: dup[0].final_folder, final_name: dup[0].final_name, error: null } : { status: "skipped", error: "backlog cleared 2026-10-02 — not on the transaction whitelist, superseded, or left alone (Ridgeview)" }
  say(`${row.status.padEnd(8)} → ${next.status.padEnd(9)} ${row.filename}${dup?.length ? ` (= ${dup[0].final_name})` : ""}`)
  if (row.tg_message_id) cardIds.add(row.tg_message_id)
  if (APPLY) await sb().from("inbox_files").update({ ...next, resolved_at: now }).eq("id", row.id)
}
const { data: asks } = await sb().from("inbox_interview").select("id, tg_message_id").is("seq", null).eq("status", "asked")
for (const iv of asks || []) {
  if (iv.tg_message_id) cardIds.add(iv.tg_message_id)
  if (APPLY) await sb().from("inbox_interview").update({ status: "skipped", answer_kind: "skipped", answered_at: now }).eq("id", iv.id)
}
say(`clearing buttons on ${cardIds.size} cards`)
if (APPLY) for (const mid of cardIds) await tgClearButtons(mid)

// 4. rules
const ruleFixes = [
  { id: "eb8369cc-1f23-4745-92a6-ca23bb388d8e", patch: { folder_template: "Properties/{property}/Purchase & Sale", note: "Ridgeview keeps its folder name (Ryan 2026-10-02)" } },
  { id: "de980ff2-9090-4948-b9b6-8f9ea1fc8f86", patch: { folder_template: "Properties/{property}/Title & Escrow", filename_template: "{property} Buyer Statement {date}.pdf", property_key: null, note: "every statement version kept, dated (Ryan 2026-10-02)" } },
]
for (const r of ruleFixes) {
  say(`rule ${r.id.slice(0, 8)} → ${JSON.stringify(r.patch)}`)
  if (APPLY) await sb().from("inbox_rules").update({ ...r.patch, updated_at: now }).eq("id", r.id)
}
const { data: dom } = await sb().from("inbox_rules").select("id").eq("sender_domain", "ctt.com").eq("doc_type", "marketing_list").limit(1)
if (!dom?.length) {
  say("rule + ctt.com marketing_list → Marketing/{year}/{monthyear} Lists")
  if (APPLY) await sb().from("inbox_rules").insert({ sender_domain: "ctt.com", sender_email: "dominic.wooten@ctt.com", doc_type: "marketing_list", property_key: null, folder_template: "Marketing/{year}/{monthyear} Lists", filename_template: "{original}", approvals_in_row: 1, mode: "manual", source: "correction", note: "Dominic Wooten's farm lists live in Marketing, never Properties (Ryan 2026-10-02)", last_used_at: now })
}

// 5. convention v2
const mdPath = path.join(REPO_ROOT, "briefs", "INBOX_FILING_RULES.md")
const md = fs.readFileSync(mdPath, "utf8").replace(/^<!--[\s\S]*?-->\s*/, "")
const rules = await getSetting("rules")
say(`convention: ${md.length} chars → inbox_settings.rules (version ${(rules.version || 1) + 1}, approved)`)
if (APPLY) await setSetting("rules", { md, status: "approved", approved_at: now, published_at: now, version: (rules.version || 1) + 1, feedback: null, tg_message_id: null })

// 6. sides
say("agent.sides = { 5764halleck: buyer, 2116quito: buyer }")
if (APPLY) await setSetting("agent", { sides: { ...((await getSetting("agent")).sides || {}), "5764halleck": "buyer", "2116quito": "buyer" } })

say(APPLY ? "done" : "(dry run — add --apply)")
void fileURLToPath
