#!/usr/bin/env node
// Inbox Agent — direct backfill of one property's transaction documents from Gmail.
//
// Ryan 2026-10-02: "backfill anything that's missing from before — I'm not going
// to go through Telegram and reapprove everything." So this files straight into
// Drive with no cards, using the transaction whitelist (llm.mjs WHITELIST) and
// the deterministic destinations in filing.mjs. Every upload is recorded in
// inbox_files (status filed, mode backfill) so the live worker's sha256 dedupe
// sees it, and the Gmail message gets the MC/Filed label.
//
//   node scripts/inbox-agent/backfill.mjs --property="5764 Halleck Dr" --query="Halleck" --since=2026/08/01 \
//        [--side=buyer|seller] [--exclude=obieinsurance.com,foo.com] [--limit=N] [--apply]
//
// Without --apply it is a dry run: classifies, verifies against the PDF, prints the plan.
import crypto from "node:crypto"
import { loadEnvLocal, MAILBOX, keysMatch, log, propertyKey, sb, warn } from "./env.mjs"
import { addLabel, getAttachmentBytes, getMessage, gmailClient, listMessageIds } from "./gmail.mjs"
import { downloadFile, driveClient, findFileByName, findRoot, listChildren, resolvePath, uploadFile } from "./drive.mjs"
import { CLASSIFY_SYSTEM, HAIKU, VERIFY_SYSTEM, classifyPrompt, completeJson, verifyPrompt } from "./llm.mjs"
import { destinationFor, filingDecision, isPurchaseDoc, nextSequence, refineDocType, stageOf, withTimeSuffix } from "./filing.mjs"

loadEnvLocal()
const argv = process.argv.slice(2)
const flag = (n) => argv.includes(`--${n}`)
const opt = (n, d) => {
  const a = argv.find((x) => x.startsWith(`--${n}=`))
  return a ? a.slice(n.length + 3) : d
}
const PROPERTY = opt("property", null)
const QUERY = opt("query", null)
const SINCE = opt("since", "2026/08/01")
const SIDE = opt("side", "buyer")
const EXCLUDE = opt("exclude", "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
const APPLY = flag("apply")
const LIMIT = Number(opt("limit", 200))
if (!PROPERTY || !QUERY) {
  console.error('usage: --property="5764 Halleck Dr" --query="Halleck" [--since=YYYY/MM/DD] [--side=buyer] [--exclude=domain,…] [--apply]')
  process.exit(2)
}

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex")
const dateOf = (iso) => String(iso || "").slice(0, 10)
const SKIP_NAME_RE = /^(image\d{3}|~WRD\d+|front-composer-|outlook-)/i
const FOLDER = "application/vnd.google-apps.folder"

const gmail = await gmailClient()
const drive = await driveClient()
const root = await findRoot(drive)
const propKey = propertyKey(PROPERTY)

async function currentSequence() {
  const { id } = await resolvePath(drive, root, `Properties/${PROPERTY}/Purchase & Sale`, { create: APPLY })
  if (!id) return 1
  return nextSequence((await listChildren(drive, id)).filter((k) => k.mimeType !== FOLDER).map((k) => k.name))
}
async function alreadyRecorded(hash) {
  const { data } = await sb().from("inbox_files").select("id, status, final_folder, final_name").eq("sha256", hash).in("status", ["filed", "duplicate"]).limit(1)
  return data?.[0] || null
}

const q = `(${QUERY}) has:attachment after:${SINCE} -in:spam -in:trash`
const ids = (await listMessageIds(gmail, q, LIMIT)).reverse() // oldest first
log(`backfill ${PROPERTY}: ${ids.length} messages match ${q}`)
let seq = await currentSequence()
const seenHash = new Set()
const seenNameSize = new Set() // Ryan forwarding the same PDF to three people is one document
const plan = []
const add = (p) => (plan.push(p), p)

for (const id of ids) {
  let msg
  try {
    msg = await getMessage(gmail, id)
  } catch (e) {
    warn(`get ${id}: ${e.message}`)
    continue
  }
  if (EXCLUDE.some((d) => msg.from.email.endsWith(d))) {
    add({ date: dateOf(msg.internalDate), from: msg.from.email, file: `(${msg.attachments.length} attachments)`, doc_type: "-", action: "ignore", why: `sender excluded (${EXCLUDE.join(", ")})` })
    continue
  }
  const atts = msg.attachments.filter((a) => !(a.inline && /^image\//.test(a.mime)) && !SKIP_NAME_RE.test(a.filename) && /\.(pdf|docx?|xlsx?|csv)$/i.test(a.filename) && (a.size || 0) > 10 * 1024)
  if (!atts.length) continue
  const cls = await completeJson({ model: HAIKU, system: CLASSIFY_SYSTEM, prompt: classifyPrompt({ msg, attachments: atts, hints: { knownSender: true, knowledge: "", senderProperties: [PROPERTY], activeProperties: [PROPERTY], propertyFolders: [PROPERTY] } }), maxTokens: 1800, tag: "[backfill-classify]" })
  const byName = new Map((cls?.attachments || []).map((a) => [a.filename, a]))
  for (const a of atts) {
    const c = byName.get(a.filename) || {}
    const cleanName = a.filename.replace(/^\.+/, "")
    const docType = refineDocType(cleanName, c.doc_type, msg.from.email, msg.subject)
    const line = { date: dateOf(msg.internalDate), from: msg.from.email, file: cleanName, doc_type: docType }
    // Only the bound policy: an EOI superseded by a later EOI/policy from the same insurer is skipped.
    if (/^(evidence_of_insurance|insurance_policy)$/.test(docType)) {
      const dom = msg.from.email.split("@")[1]
      const laterTypes = docType === "insurance_policy" ? ["insurance_policy"] : ["evidence_of_insurance", "insurance_policy"]
      const { data: later } = await sb().from("inbox_files").select("id, final_name").eq("status", "filed").eq("property_key", propKey).in("doc_type", laterTypes).ilike("sender", `%@${dom}`).gt("received_at", msg.internalDate).limit(1)
      if (later?.length) {
        add({ ...line, action: "skip", why: `superseded by ${later[0].final_name}` })
        continue
      }
    }
    const nameKey = `${cleanName.toLowerCase()}|${a.size}`
    const versioned = /^(closing_statement|net_sheet)$/.test(docType) // every statement version is kept: bytes decide, never the name
    if (!versioned && seenNameSize.has(nameKey)) {
      add({ ...line, action: "skip", why: "same file name + size already handled in this run" })
      continue
    }
    const pre = filingDecision(docType, stageOf({ filename: cleanName, subject: msg.subject, modelStage: c.stage }))
    if (!pre.file && !/^(evidence_of_insurance|insurance_policy|loan_docs)$/.test(docType)) {
      add({ ...line, action: "ignore", why: pre.why })
      continue
    }
    const bytes = await getAttachmentBytes(gmail, msg.id, a.attachmentId)
    const hash = sha256(bytes)
    if (seenHash.has(hash)) {
      add({ ...line, action: "skip", why: "identical bytes already handled in this run" })
      continue
    }
    const prior = await alreadyRecorded(hash)
    if (prior) {
      seenHash.add(hash)
      seenNameSize.add(nameKey)
      add({ ...line, action: "skip", why: `already ${prior.status}${prior.final_folder ? ` → ${prior.final_folder}/${prior.final_name}` : ""}` })
      continue
    }
    // Property comes from the document, not the subject line.
    let verify = null
    if (/^application\/pdf$/.test(a.mime)) {
      verify = await completeJson({ model: HAIKU, system: VERIFY_SYSTEM, prompt: verifyPrompt({ filename: cleanName, candidates: [PROPERTY] }), docs: [{ kind: "pdf", data: bytes, mime: a.mime, name: cleanName }], maxTokens: 300, tag: "[backfill-verify]" })
      const vk = propertyKey(verify?.label || verify?.address || "")
      const ok = (verify?.matches && keysMatch(propertyKey(verify.matches), propKey)) || (vk && keysMatch(vk, propKey))
      if (verify?.address && !ok) {
        add({ ...line, action: "skip", why: `PDF names ${verify.label || verify.address}, not ${PROPERTY}` })
        continue
      }
      if (!verify?.address && !(c.property_label && keysMatch(propertyKey(c.property_label), propKey)) && !new RegExp(QUERY, "i").test(msg.subject)) {
        add({ ...line, action: "skip", why: "could not confirm the property from the PDF or the subject" })
        continue
      }
    }
    const stage = stageOf({ filename: cleanName, subject: msg.subject, modelStage: c.stage, verifyStage: verify?.stage })
    const dest = destinationFor({ property: PROPERTY, docType, filename: cleanName, subject: msg.subject, receivedAt: msg.internalDate, stage, seq, side: SIDE })
    if (!dest) {
      add({ ...line, action: "ignore", why: filingDecision(docType, stage).why })
      continue
    }
    seenHash.add(hash)
    seenNameSize.add(nameKey)
    if (isPurchaseDoc(docType)) seq++
    const entry = add({ ...line, action: APPLY ? "file" : "would file", to: `${dest.folder}/${dest.name}` })
    if (!APPLY) continue
    try {
      const { id: folderId } = await resolvePath(drive, root, dest.folder, { create: true })
      let name = dest.name
      let up = null
      let existing = await findFileByName(drive, folderId, name)
      if (!existing && isPurchaseDoc(docType)) {
        // Numbered docs: an earlier run may have filed the same bytes under another prefix.
        const tail = name.replace(/^\d{2} /, "")
        for (const k of (await listChildren(drive, folderId)).filter((k) => k.name.endsWith(tail))) {
          if (sha256(await downloadFile(drive, k.id)) === hash) {
            existing = k
            name = k.name
            seq--
            break
          }
        }
      }
      if (existing) {
        // Same bytes already in Drive (e.g. an earlier run whose DB row failed) → record it, don't re-upload.
        const same = sha256(await downloadFile(drive, existing.id)) === hash
        if (same) up = existing
        else name = withTimeSuffix(name, msg.internalDate)
      }
      if (!up) up = await uploadFile(drive, folderId, name, a.mime, bytes)
      const now = new Date().toISOString()
      // inbox_files.gmail_id → inbox_messages.gmail_id, so the message row goes first.
      await sb().from("inbox_messages").upsert({ gmail_id: msg.id, thread_id: msg.threadId, mailbox: MAILBOX, internal_date: msg.internalDate, sender: msg.from.email, sender_name: msg.from.name || null, subject: msg.subject, kind: cls?.kind || "human", classification: cls || null, attachment_count: atts.length }, { onConflict: "gmail_id" })
      const { error } = await sb().from("inbox_files").insert({
        gmail_id: msg.id, thread_id: msg.threadId, attachment_id: a.attachmentId, part_id: a.partId, filename: a.filename, mime: a.mime, size_bytes: bytes.length, sha256: hash,
        sender: msg.from.email, subject: msg.subject, received_at: msg.internalDate, property_key: propKey, property_label: PROPERTY, doc_type: docType,
        status: "filed", mode: "backfill", final_folder: dest.folder, final_name: name, drive_file_id: up.id, drive_folder_id: folderId, drive_url: up.webViewLink, filed_at: now, resolved_at: now,
      })
      if (error) warn(`inbox_files insert: ${error.message}`)
      await addLabel(gmail, msg.id, "MC/Filed")
      entry.to = `${dest.folder}/${name}${existing && up === existing ? "  (recorded existing upload)" : ""}`
    } catch (e) {
      entry.action = "error"
      entry.why = e?.response?.data?.error?.message || e.message
    }
  }
}
for (const p of plan) console.log(`${p.date} | ${p.action.padEnd(10)} | ${p.from.padEnd(30)} | ${p.file.slice(0, 48).padEnd(48)} | ${p.doc_type.padEnd(21)} | ${p.to || p.why}`)
console.log(`\n${plan.filter((p) => /file/.test(p.action)).length} filed/would file · ${plan.filter((p) => p.action === "skip").length} skipped · ${plan.filter((p) => p.action === "ignore").length} ignored · ${plan.filter((p) => p.action === "error").length} errors${APPLY ? "" : "  (dry run — add --apply)"}`)
