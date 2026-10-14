// Shared CSV parser for the direct-mail scripts (import-mail-records.mjs,
// join-mail-records-v2.mjs). RFC 4180: fields may be quoted, `""` inside a
// quoted field is a literal quote, newlines are allowed inside quotes, CRLF
// and LF both end a row. A leading UTF-8 BOM (the vendor files carry one) is
// stripped so the first header is clean.

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Raw rows — no header handling, no trimming. Empty trailing line is dropped. */
export function parseCsv(input: string): string[][] {
  const text = stripBom(input)
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQ = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQ = false
      } else field += ch
    } else if (ch === '"') inQ = true
    else if (ch === ",") { row.push(field); field = "" }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++
      row.push(field); rows.push(row); row = []; field = ""
    } else field += ch
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row) }
  return rows
}

export interface CsvTable {
  /** Trimmed header cells, in file order. */
  header: string[]
  /** One object per body row, header → verbatim cell (untrimmed). Blank lines are skipped. */
  rows: Record<string, string>[]
}

/**
 * Header + body as objects. Throws when a body row's field count differs from
 * the header's (the message names the first offender), so a truncated or
 * mis-quoted file never silently shifts columns.
 */
export function parseCsvTable(input: string): CsvTable {
  const parsed = parseCsv(input)
  if (!parsed.length) return { header: [], rows: [] }
  const header = parsed[0].map(h => h.trim())
  const body = parsed.slice(1).filter(r => r.length > 1 || (r.length === 1 && r[0] !== ""))
  const bad = body.filter(r => r.length !== header.length)
  if (bad.length) {
    throw new Error(`${bad.length} rows have the wrong field count (expected ${header.length}, first: ${JSON.stringify(bad[0]).slice(0, 200)})`)
  }
  const rows = body.map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])) as Record<string, string>)
  return { header, rows }
}
