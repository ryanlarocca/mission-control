// Inbox Agent — PDF text and merging (Ryan 2026-11-18, ratified contracts).
//
// Text comes from poppler's pdftotext on the mini (deterministic, no model
// call): it is how a contract's form, number and price are read and how an
// unsigned DocuSign copy ("In Process" stamp) is spotted. Merging uses
// poppler's pdfunite. DocuSign locks its PDFs against changes (RC4 owner
// password: "Could not merge encrypted files"), and pdf-lib can't open them at
// all ("Expected instance of PDFDict" on the Halleck SCO), so a locked file is
// first re-saved with pdftocairo -pdf (signatures and text survive) — the
// originals stay untouched in the buyer's folder.
import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { warn } from "./env.mjs"

// launchd's PATH has no /opt/homebrew/bin, so the absolute paths go first.
const poppler = (tool) => [`/opt/homebrew/bin/${tool}`, `/usr/local/bin/${tool}`, tool]
const PDFTOTEXT = poppler("pdftotext")
const PDFUNITE = poppler("pdfunite")
const PDFTOCAIRO = poppler("pdftocairo")
let warned = false

function run(bin, args) {
  return new Promise((resolve, reject) => execFile(bin, args, { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 }, (e, out) => (e ? reject(e) : resolve(out))))
}

/** The PDF's text (layout mode), or null when pdftotext is missing or the file can't be read. */
export async function pdfText(bytes) {
  if (!bytes?.length) return null
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-pdftext-"))
  const file = path.join(dir, "doc.pdf")
  try {
    fs.writeFileSync(file, bytes)
    for (const bin of PDFTOTEXT) {
      try {
        return await run(bin, ["-layout", "-q", file, "-"])
      } catch (e) {
        if (e.code === "ENOENT") continue
        warn(`pdftotext failed: ${e.message}`)
        return null
      }
    }
    if (!warned) warn("pdftotext not found — contract forms and DocuSign drafts can't be read")
    warned = true
    return null
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Run the first poppler binary that exists; throws the tool's own error, or ENOENT when none is installed. */
async function poppler1(bins, args) {
  let last = null
  for (const bin of bins) {
    try {
      return await run(bin, args)
    } catch (e) {
      last = e
      if (e.code !== "ENOENT") throw e
    }
  }
  throw last
}

/** Join PDFs in order into one document (the ratified contract: RPA, then each counter). */
export async function mergePdfs(buffers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-pdfunite-"))
  try {
    const files = buffers.map((b, i) => {
      const f = path.join(dir, `${String(i).padStart(2, "0")}.pdf`)
      fs.writeFileSync(f, b)
      return f
    })
    const out = path.join(dir, "merged.pdf")
    try {
      await poppler1(PDFUNITE, [...files, out])
    } catch (e) {
      if (e.code === "ENOENT" || !/encrypt/i.test(`${e.message} ${e.stderr || ""}`)) throw e
      const open = []
      for (const f of files) {
        const o = f.replace(/\.pdf$/, "-open.pdf")
        await poppler1(PDFTOCAIRO, ["-pdf", f, o])
        open.push(o)
      }
      await poppler1(PDFUNITE, [...open, out])
    }
    return fs.readFileSync(out)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
