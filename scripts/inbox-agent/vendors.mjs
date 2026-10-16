// Inbox Agent — vendor filing rules (briefs/BRIEF_INBOX_VENDOR_FILING_TAPINSPECT_2026-10-16.md, Part A).
//
// Ryan 2026-10-16: invoices on deal threads stay ignored ("a total waste of
// time") — but ITI Direct Mail's invoices, signed proofs, quotes and the
// sales-tax exemption form are the paper trail of a direct-mail campaign and
// belong in that campaign's Drive folder, not a property folder. The carve-out
// is SURGICAL: a vendor rule (inbox_settings.vendors) names the senders, the
// relay senders (PandaDoc on ITI's behalf) and the doc types it unlocks; every
// other sender keeps the transaction whitelist unchanged.
//
// Pure, dependency-free: the worker (index.mjs) and the unit tests agree on
// every verdict, name, rename and diff line. Drive calls live in drive.mjs.

/** Mirrors the migration seed (2026-10-16_campaign_drive_folder.sql); used when inbox_settings.vendors is empty. */
export const DEFAULT_VENDORS = {
  rules: [
    {
      id: "iti",
      name: "ITI Direct Mail",
      senders: ["juan@letterprinting.net", "alan@letterprinting.net"],
      relays: [{ sender: "docs@email.pandadoc.net", subject_re: "iti Direct Mail|Proof.*order #" }],
      doc_types: ["invoice", "proof", "quote", "tax_form"],
      campaign_id: "5b71ff54-14f9-4c83-a14d-8d1eed6325f2",
      subfolder: "3 - MAIL HOUSE",
    },
  ],
}

/** The vendor rules to use: inbox_settings.vendors when it has rules, else the seed. */
export function vendorRules(settings) {
  const rules = Array.isArray(settings?.rules) ? settings.rules.filter((r) => r && r.id) : []
  return rules.length ? rules : DEFAULT_VENDORS.rules
}

function senderOf(msg) {
  return String(msg?.from?.email || msg?.sender || "").trim().toLowerCase()
}
function subjectOf(msg) {
  return String(msg?.subject || "")
}

/**
 * The vendor rule an email belongs to, or null. Sender exact match
 * (case-insensitive) on `senders`, or a relay sender whose subject matches
 * the relay's `subject_re` (case-insensitive). Anything else → null, and the
 * caller keeps the normal whitelist behaviour.
 * @param {{ from?: {email?: string}, sender?: string, subject?: string }} msg
 * @param {{ rules?: Array<any> } | Array<any>} vendors
 */
export function matchVendor(msg, vendors) {
  const rules = Array.isArray(vendors) ? vendors : vendorRules(vendors)
  const sender = senderOf(msg)
  if (!sender) return null
  const subject = subjectOf(msg)
  for (const rule of rules) {
    if ((rule.senders || []).some((s) => String(s).trim().toLowerCase() === sender)) return rule
    for (const relay of rule.relays || []) {
      if (String(relay.sender || "").trim().toLowerCase() !== sender) continue
      let re
      try {
        re = new RegExp(relay.subject_re || "(?!)", "i")
      } catch {
        continue
      }
      if (re.test(subject)) return rule
    }
  }
  return null
}

// ---------------------------------------------------------------- ITI invoice body
const MONEY_RE = /\(?\s*-?\s*\$?\s*(-?[\d,]+(?:\.\d{1,2})?)\s*\)?/
const LINE_LABELS = [
  ["subtotal", /\bsub\s*-?\s*total\b/i],
  ["shipping", /\bshipping(?:\s+charges?)?\b/i],
  ["discount", /\bdiscount\b/i],
  ["tax", /\b(?:sales\s+)?tax\b/i],
  ["total", /\btotal\b/i],
]

function moneyFrom(rest) {
  const r = String(rest).replace(/^\s*[:=]\s*/, "")
  const m = MONEY_RE.exec(r)
  if (!m) return null
  const raw = m[1].replace(/,/g, "")
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  const negative = /^\s*\(|^\s*-|\$\s*-/.test(r) || raw.startsWith("-")
  return negative ? -Math.abs(n) : n
}

/**
 * ITI always puts `Subtotal / Shipping Charges / Discount / Tax / Total` lines
 * in the email body ("Total :$10,385.57"). Each is parsed on its own line;
 * the first hit per label wins; missing lines are null.
 * @param {string|null|undefined} text
 * @returns {{ subtotal: number|null, shipping: number|null, discount: number|null, tax: number|null, total: number|null }}
 */
export function parseItiAmounts(text) {
  const out = { subtotal: null, shipping: null, discount: null, tax: null, total: null }
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim()
    if (!line) continue
    for (const [key, re] of LINE_LABELS) {
      if (out[key] !== null) continue
      const m = re.exec(line)
      if (!m) continue
      // "Subtotal" also contains "total": only the label at the start of the line counts.
      if (m.index > 2) continue
      const value = moneyFrom(line.slice(m.index + m[0].length))
      if (value === null) continue
      out[key] = value
      break
    }
  }
  return out
}

/** "243496_RyanLarocca_LRG-Homes--LLC_2026-10-15-13-11-35.pdf" → "243496"; else the subject's "invoice #243496"; else null. */
export function invoiceNumberFrom(filename, subject = "") {
  const f = /^\s*(\d{4,})/.exec(String(filename || ""))
  if (f) return f[1]
  const s = /invoice\s*(?:#|no\.?|number)?\s*:?\s*(\d{4,})/i.exec(String(subject || ""))
  return s ? s[1] : null
}

/** $10,385.57 (two decimals, thousands separators; negatives as -$500.00). */
export function money(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return null
  const v = Number(n)
  const abs = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${v < 0 ? "-" : ""}$${abs}`
}

// ---------------------------------------------------------------- proofs (PandaDoc relay)
export const PANDADOC_SENDER = "docs@email.pandadoc.net"
const SIGNED_COPY_RE = /signed copy of\s*["“”'](.+)["“”']\s*$/i // greedy: the title may itself carry quotes

/** Ryan 2026-10-16: "only store proofs that have been signed and accepted" — the PandaDoc "Signed copy of …" email is the only proof that files. */
export function isSignedProofRelay(msg) {
  return senderOf(msg) === PANDADOC_SENDER && SIGNED_COPY_RE.test(subjectOf(msg))
}
/** `Signed copy of "RE-Proof3 for order #240069"` → `RE-Proof3 for order #240069`. */
export function proofTitleFrom(subject) {
  const m = SIGNED_COPY_RE.exec(String(subject || ""))
  return m ? m[1].trim() : null
}

/**
 * The vendor doc type of one attachment, after the classifier and
 * refineDocType: proofs come from the relay subject as much as the filename,
 * a vendor's "bid"/"estimate" is a quote, the tax form is matched by name.
 * Returns null when the attachment is not one of the rule's doc types (the
 * caller then runs it through the normal pipeline untouched).
 */
export function vendorDocType(rule, att, msg) {
  const f = String(att?.cleanName || att?.filename || "")
  const subject = subjectOf(msg)
  let t = att?.doc_type || "other"
  if (/exempt|CDTFA|230-?P|1541/i.test(f) || /tax exemption|exemption certificate|CDTFA/i.test(subject)) t = "tax_form"
  else if (/proof/i.test(f) || (senderOf(msg) === PANDADOC_SENDER && /proof/i.test(subject))) t = "proof"
  else if (t === "bid" || t === "insurance_quote" || /\b(quote|estimate)\b/i.test(f)) t = "quote"
  else if (/invoice/i.test(f) || (t === "other" && /\binvoice\b/i.test(subject))) t = "invoice"
  return (rule?.doc_types || []).includes(t) ? t : null
}

/**
 * File it or not? Only the PandaDoc signed copy of a proof files; an unsigned
 * proof (PandaDoc's "sent you Proof … via PandaDoc", or a proof PDF the rep
 * attaches directly) is logged as ignored and its needs-reply handling stays.
 * @returns {{ file: boolean, docType: string|null, why: string }}
 */
export function vendorFilingDecision(rule, att, msg) {
  const docType = vendorDocType(rule, att, msg)
  if (!docType) return { file: false, docType: null, why: "not a vendor document type" }
  if (!/\.pdf$/i.test(String(att?.cleanName || att?.filename || "")) && !/^application\/pdf$/.test(att?.mime || "")) return { file: false, docType, why: `${docType} is not a PDF` }
  if (docType === "proof" && !isSignedProofRelay(msg)) return { file: false, docType, why: "unsigned proof" }
  return { file: true, docType, why: `${rule.name} ${docType}` }
}

// ---------------------------------------------------------------- revisions / paid
export const INVOICE_NAME_RE = /^ITI invoice /i
const PAID_OR_SUPERSEDED_RE = /\s(PAID|SUPERSEDED)(\.[a-z0-9]{1,6})?$/i

/** Append a marker before the extension: "ITI invoice 243481 - … .pdf" → "… SUPERSEDED.pdf". */
export function markedName(name, marker) {
  const s = String(name || "")
  const m = /^(.*?)(\.[a-z0-9]{1,6})?$/i.exec(s)
  return `${m?.[1] || s} ${marker}${m?.[2] || ""}`
}
export function paidName(name) {
  return markedName(name, "PAID")
}

/**
 * ITI issues a new invoice number on every revision (243481 → 243496). Every
 * version is kept; when a new invoice lands, every existing `ITI invoice …`
 * file in the folder that is not already PAID or SUPERSEDED is renamed to
 * `… SUPERSEDED`. `files` = the folder listing ([{id, name}] or names).
 * @param {Array<string|{id?: string, name: string}>} files
 * @param {{ exclude?: string|null }} [opts] the name just uploaded (never superseded)
 * @returns {Array<{ id?: string, from: string, to: string }>}
 */
export function supersedeRenames(files, { exclude = null } = {}) {
  const out = []
  for (const f of files || []) {
    const name = typeof f === "string" ? f : f?.name
    if (!name || !INVOICE_NAME_RE.test(name)) continue
    if (PAID_OR_SUPERSEDED_RE.test(name)) continue
    if (exclude && name.toLowerCase() === String(exclude).toLowerCase()) continue
    out.push({ ...(typeof f === "string" ? {} : { id: f.id }), from: name, to: markedName(name, "SUPERSEDED") })
  }
  return out
}

/**
 * The confirmation card's diff against the most recent previous invoice in the
 * same folder: one line each for Subtotal, Discount, Tax, Total (old → new),
 * then "setup/other line changes: see PDF". `prev` null → [].
 * @param {{subtotal?: number|null, discount?: number|null, tax?: number|null, total?: number|null, invoice_no?: string|null}|null} prev
 * @param {{subtotal?: number|null, discount?: number|null, tax?: number|null, total?: number|null, invoice_no?: string|null}} next
 */
export function invoiceDiffLines(prev, next) {
  if (!prev) return []
  const lines = [`vs invoice ${prev.invoice_no || "(previous)"}:`]
  for (const [key, label] of [["subtotal", "Subtotal"], ["discount", "Discount"], ["tax", "Tax"], ["total", "Total"]]) {
    const a = prev[key] ?? null
    const b = next?.[key] ?? null
    const delta = a !== null && b !== null ? b - a : null
    const change = delta === null ? "" : Math.abs(delta) < 0.005 ? " (same)" : ` (${delta > 0 ? "+" : "-"}${money(Math.abs(delta))})`
    lines.push(`${label}: ${money(a) ?? "—"} → ${money(b) ?? "—"}${change}`)
  }
  lines.push("setup/other line changes: see PDF")
  return lines
}

// ---------------------------------------------------------------- campaign resolution
/** campaigns has no archived/finished flag; a campaign counts as current while its drop_date is in the future or within this many days. */
export const CAMPAIGN_CURRENT_DAYS = 180

/**
 * Where a vendor document goes: (1) the rule's pinned campaign_id → that
 * campaign's drive_folder_id; (2) otherwise exactly one current campaign with
 * a drive_folder_id; (3) otherwise nothing (the caller asks).
 * @typedef {{ id: string, name?: string, drive_folder_id?: string|null, parent_campaign_id?: string|null, drop_date?: string|null, total_cost?: number|null }} Campaign
 * @param {{campaign_id?: string|null}} rule
 * @param {Campaign[]} campaigns
 * @returns {{ campaign: Campaign|null, why: string, candidates: Campaign[] }}
 */
export function pickCampaign(rule, campaigns, now = Date.now()) {
  const rows = Array.isArray(campaigns) ? campaigns : []
  const withFolder = rows.filter((c) => c && c.drive_folder_id)
  if (rule?.campaign_id) {
    const pinned = rows.find((c) => c?.id === rule.campaign_id)
    if (pinned?.drive_folder_id) return { campaign: pinned, why: "pinned on the vendor rule", candidates: withFolder }
    if (pinned) return { campaign: null, why: `campaign ${pinned.name || pinned.id} has no drive_folder_id`, candidates: withFolder }
  }
  const current = withFolder.filter((c) => {
    if (!c.drop_date) return true
    const t = new Date(c.drop_date).getTime()
    return !Number.isFinite(t) || t >= now - CAMPAIGN_CURRENT_DAYS * 86_400_000
  })
  if (current.length === 1) return { campaign: current[0], why: "the only current campaign with a Drive folder", candidates: withFolder }
  return { campaign: null, why: current.length ? `${current.length} current campaigns have a Drive folder` : "no campaign has a Drive folder", candidates: withFolder }
}

/** The parent campaign of a resolved campaign (the one whose total_cost the Paid tap sets), or the campaign itself.
 * @param {Campaign|null|undefined} campaign
 * @param {Campaign[]} campaigns
 * @returns {Campaign|null} */
export function parentCampaignOf(campaign, campaigns) {
  if (!campaign?.parent_campaign_id) return campaign || null
  return (campaigns || []).find((c) => c?.id === campaign.parent_campaign_id) || campaign
}
