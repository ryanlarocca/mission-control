#!/usr/bin/env node
// Self-sign: Ryan signs a form someone else sent him, on the form's own lines.
// Driven by the "help me sign this" procedure (.claude/skills/sign-document/SKILL.md).
//
//   node esign/scripts/self-sign.mjs prepare <spec.json>   → envelope + signing link + preview images
//   node esign/scripts/self-sign.mjs status <envelopeId>   → where it stands, Drive links once signed
//   node esign/scripts/self-sign.mjs share <envelopeId> <email>  → clean signed copy, view-only, no Google email
//   node esign/scripts/self-sign.mjs void <envelopeId> [reason]
//
// spec.json:
//   { "pdf": "/path/form.pdf" | "driveFileId": "…",
//     "docLabel": "Access Acknowledgment", "street": "5122 Severance Ct",
//     "propertyAddress": "5122 Severance Ct, San Jose, CA", "receivedFrom": "Maryam Norton",
//     "fields": [ { "page": 1, "kind": "text", "value": "Ryan LaRocca", "x": 104.5, "lineY": 341, "w": 142.4, "label": "Name" },
//                 { "page": 1, "kind": "date", … }, { "page": 1, "kind": "signature", … } ] }
// Positions come from esign/scripts/find-blanks.mjs (PDF points, origin bottom-left).
// Runs against the live data dir and the same SQLite file as the server.
import fs from "node:fs"
import path from "node:path"
import { createSelfSign, shareSigned, voidEnvelope, envelopeDir, UserError } from "../lib/envelope.mjs"
import { getEnvelope, getSigners, getEvents } from "../lib/db.mjs"

const [cmd, a1, a2] = process.argv.slice(2)

function pagesOf(id) {
  const dir = path.join(envelopeDir(id), "pages")
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort().map((f) => path.join(dir, f)) : []
}

try {
  if (cmd === "prepare") {
    if (!a1) throw new UserError("prepare needs a spec.json path")
    const spec = JSON.parse(fs.readFileSync(a1, "utf8"))
    const pdfBytes = spec.pdf ? fs.readFileSync(spec.pdf) : null
    const r = await createSelfSign({ ...spec, pdfBytes })
    console.log(JSON.stringify({ ...r, preview: pagesOf(r.id) }, null, 2))
  } else if (cmd === "status") {
    const e = getEnvelope(a1)
    if (!e) throw new UserError("No such envelope")
    const s = getSigners(a1)[0]
    console.log(JSON.stringify({
      id: e.id, title: e.title, status: e.status, signer: s?.status, signedAt: s?.signed_at ?? null,
      folder: e.drive_folder_link, signedCopy: e.drive_signed_link, withCertificate: e.drive_final_link,
      shared: getEvents(a1).filter((x) => x.kind === "shared").map((x) => JSON.parse(x.details).with),
      problems: getEvents(a1).filter((x) => /failed/.test(x.kind)).map((x) => `${x.kind}: ${x.details}`),
    }, null, 2))
  } else if (cmd === "share") {
    console.log(JSON.stringify(await shareSigned(a1, a2), null, 2))
  } else if (cmd === "void") {
    await voidEnvelope(a1, a2 || "voided from self-sign")
    console.log(JSON.stringify({ voided: a1 }))
  } else {
    console.error("Usage: self-sign.mjs prepare <spec.json> | status <id> | share <id> <email> | void <id> [reason]")
    process.exit(1)
  }
} catch (e) {
  console.error(e instanceof UserError ? `✗ ${e.message}` : e)
  process.exit(1)
}
