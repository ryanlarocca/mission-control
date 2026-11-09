// Put a completed purchase agreement on the seller's lead card by hand — for
// envelopes signed before the automatic step existed (2026-11-09), or one
// whose lead-card step failed and you'd rather not "Retry completion".
//
//   node esign/scripts/crm-sync.mjs <envelopeId>            # report it + Telegram card with Undo
//   node esign/scripts/crm-sync.mjs <envelopeId> --dry      # show what would be sent, send nothing
//
// Run from the MAIN checkout (live database).
import { env } from "../lib/env.mjs"
import { getEnvelope, getSigners, addEvent } from "../lib/db.mjs"
import { contractFields, isSellerContract, reportContract } from "../lib/crm.mjs"
import { notify, esc } from "../lib/notify.mjs"

const [id] = process.argv.slice(2).filter((a) => !a.startsWith("--"))
const dry = process.argv.includes("--dry")
if (!id) { console.error("usage: node esign/scripts/crm-sync.mjs <envelopeId> [--dry]"); process.exit(1) }

const envelope = getEnvelope(id)
if (!envelope) { console.error(`no envelope ${id} in ${env.dataDir}`); process.exit(1) }
const signers = getSigners(id)
if (envelope.status !== "completed") { console.error(`envelope ${id} is ${envelope.status}, not completed`); process.exit(1) }
if (!isSellerContract(envelope, signers)) { console.error(`envelope ${id} isn't a seller purchase agreement`); process.exit(1) }

if (dry) {
  console.log({ title: envelope.title, completed_at: envelope.completed_at, drive: envelope.drive_final_link, fields: await contractFields(envelope.original_path), sellers: signers.filter((s) => s.role === "seller").map((s) => ({ name: s.name, email: s.email, phone: s.phone })) })
  process.exit(0)
}

const out = await reportContract("signed", envelope, signers)
addEvent(id, "crm_synced", { details: { status: out.status, leadId: out.leadId || null, closeBy: out.closeBy || null, by: "crm-sync" } })
console.log(out)
if (out.line) await notify(`<b>${esc(envelope.title)}</b>\n${out.line}`, { buttons: out.undo ? [[{ text: "↩️ Undo lead card", data: out.undo }]] : undefined })
