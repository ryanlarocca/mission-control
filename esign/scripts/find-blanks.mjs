#!/usr/bin/env node
// Find the blanks on a form someone sent Ryan to sign — the first step of the
// "help me sign this" procedure (.claude/skills/sign-document/SKILL.md).
//
//   node esign/scripts/find-blanks.mjs <file.pdf> [--png <dir>]
//
// Prints JSON: per page its size and the candidate blank lines, in PDF points
// (origin bottom-left, the unit the self-sign `fields` use):
//   { x, lineY, w, label, source }   source = "text" (a run of underscores in
//   the text layer, label = the words before it on the line, or under it) or
//   "drawn" (a horizontal rule found in the page image — drawn lines and
//   scanned forms; label = nearby text when there is a text layer).
// --png writes page-N.png renders so the reader can look at the page.
// Nothing here decides what goes in a blank; the agent reads the form, picks
// the values, and checks the preview before handing Ryan the link.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

const bin = (n) => (fs.existsSync(`/opt/homebrew/bin/${n}`) ? `/opt/homebrew/bin/${n}` : n)
const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith("--"))
const pngDir = args.includes("--png") ? args[args.indexOf("--png") + 1] : null
if (!file) {
  console.error("Usage: node esign/scripts/find-blanks.mjs <file.pdf> [--png <dir>]")
  process.exit(1)
}

// ---------------------------------------------------------------- text layer

function textLayer(pdf) {
  const xml = execFileSync(bin("pdftotext"), ["-bbox-layout", pdf, "-"], { encoding: "utf8", maxBuffer: 64 << 20 })
  const pages = []
  for (const pm of xml.matchAll(/<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g)) {
    const lines = []
    for (const lm of pm[3].matchAll(/<line[^>]*>([\s\S]*?)<\/line>/g)) {
      const words = [...lm[1].matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
        .map((w) => ({ x0: +w[1], y0: +w[2], x1: +w[3], y1: +w[4], t: decode(w[5]) }))
      if (words.length) lines.push(words)
    }
    pages.push({ width: +pm[1], height: +pm[2], lines })
  }
  return pages
}
const decode = (t) => t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")

/** Underscore runs → blanks. A word like "Name:_____" splits into label + run. */
function textBlanks(page) {
  const out = []
  const all = page.lines.flat()
  for (const words of page.lines) {
    for (const [i, w] of words.entries()) {
      const m = /^(.*?)(_{4,})(.*)$/.exec(w.t)
      if (!m) continue
      const per = (w.x1 - w.x0) / w.t.length
      const x0 = w.x0 + m[1].length * per, x1 = x0 + m[2].length * per
      const size = w.y1 - w.y0
      // The underscore stroke sits a little below the baseline, ~18% of the box up from its bottom.
      const lineTop = w.y1 - size * 0.18
      let label = [...words.slice(Math.max(0, i - 4), i).map((x) => x.t), m[1]].join(" ").trim()
      if (!label) label = labelNear(all, x0, x1, lineTop)
      out.push({ x: r1(x0), lineY: r1(page.height - lineTop), w: r1(x1 - x0), label: label || null, source: "text" })
    }
  }
  return out
}

/** Words just under (a caption like "Signature") or just left of a line. */
function labelNear(words, x0, x1, top) {
  const under = words.filter((w) => w.y0 > top && w.y0 - top < 14 && w.x1 > x0 - 4 && w.x0 < x1 + 4 && !/^_+$/.test(w.t))
  if (under.length) return under.map((w) => w.t).join(" ")
  const left = words.filter((w) => Math.abs(w.y1 - top) < 8 && w.x1 <= x0 + 2 && x0 - w.x1 < 160 && !/^_+$/.test(w.t)).sort((a, b) => a.x0 - b.x0)
  return left.slice(-4).map((w) => w.t).join(" ")
}

// ---------------------------------------------------------------- page image

const DPI = 144 // 2 px per point

function render(pdf, dir, fmt) {
  execFileSync(bin("pdftoppm"), ["-r", String(DPI), fmt === "png" ? "-png" : "-gray", pdf, path.join(dir, "page")])
  return fs.readdirSync(dir).filter((f) => f.startsWith("page-")).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0])).map((f) => path.join(dir, f))
}

function readPgm(file) {
  const buf = fs.readFileSync(file)
  // P5\n<w> <h>\n<max>\n<bytes>
  let pos = 0
  const tok = () => {
    while (/\s/.test(String.fromCharCode(buf[pos]))) pos++
    let s = ""
    while (!/\s/.test(String.fromCharCode(buf[pos]))) s += String.fromCharCode(buf[pos++])
    return s
  }
  if (tok() !== "P5") throw new Error("not a P5 pgm")
  const w = +tok(), h = +tok()
  tok()
  pos++
  return { w, h, px: buf.subarray(pos, pos + w * h) }
}

/**
 * Horizontal dark runs ≥ 50pt long and ≤ 3pt thick → drawn blank lines.
 * Scans are grey and speckled: "dark" is < 170 and a run survives gaps of up to 3px.
 */
function drawnLines({ w, h, px }) {
  const minRun = 50 * (DPI / 72), maxGap = 3
  const runs = []
  for (let y = 0; y < h; y++) {
    let start = -1, last = -1
    for (let x = 0; x <= w; x++) {
      const dark = x < w && px[y * w + x] < 170
      if (dark) { if (start < 0) start = x; last = x; continue }
      if (start >= 0 && x - last > maxGap) {
        if (last + 1 - start >= minRun) runs.push({ y, x0: start, x1: last + 1 })
        start = -1
      }
    }
    if (start >= 0 && last + 1 - start >= minRun) runs.push({ y, x0: start, x1: last + 1 })
  }
  // Merge runs on adjacent rows into one line; drop thick bars (boxes, rules ≥ 3pt).
  const lines = []
  for (const r of runs) {
    const hit = lines.find((l) => r.y - l.y1 <= 1 && Math.abs(r.x0 - l.x0) < 6 && Math.abs(r.x1 - l.x1) < 6)
    if (hit) { hit.y1 = r.y; hit.x0 = Math.min(hit.x0, r.x0); hit.x1 = Math.max(hit.x1, r.x1) } else lines.push({ y0: r.y, y1: r.y, x0: r.x0, x1: r.x1 })
  }
  const k = 72 / DPI
  return lines.filter((l) => (l.y1 - l.y0 + 1) * k <= 3).map((l) => ({ x: l.x0 * k, top: ((l.y0 + l.y1) / 2) * k, w: (l.x1 - l.x0) * k }))
}

// ---------------------------------------------------------------- main

const r1 = (n) => Math.round(n * 10) / 10
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blanks-"))
try {
  const text = textLayer(file)
  const pgms = render(file, tmp, "pgm")
  const pages = text.map((p, i) => {
    const blanks = textBlanks(p)
    const img = pgms[i] ? readPgm(pgms[i]) : null
    if (img) {
      for (const l of drawnLines(img)) {
        const lineY = r1(p.height - l.top)
        // An underscore run also shows up as a dark line in the image — keep the text one, at the measured height.
        const twin = blanks.find((b) => b.source === "text" && Math.abs(b.lineY - lineY) < 5 && b.x < l.x + l.w && l.x < b.x + b.w)
        if (twin) { twin.lineY = lineY; continue }
        blanks.push({ x: r1(l.x), lineY, w: r1(l.w), label: labelNear(p.lines.flat(), l.x, l.x + l.w, l.top) || null, source: "drawn" })
      }
    }
    blanks.sort((a, b) => b.lineY - a.lineY || a.x - b.x)
    const words = p.lines.flat().length
    return { page: i + 1, width: p.width, height: p.height, textLayer: words > 0, blanks }
  })
  if (pngDir) {
    fs.mkdirSync(pngDir, { recursive: true })
    for (const f of render(file, pngDir, "png")) fs.renameSync(f, path.join(pngDir, path.basename(f).replace(/page-0*(\d+)/, "page-$1")))
  }
  console.log(JSON.stringify({ file: path.resolve(file), pages }, null, 2))
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
