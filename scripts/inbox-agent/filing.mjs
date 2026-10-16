// Inbox Agent — deterministic filing rules (Ryan 2026-10-02).
//
// Shared by the live worker (index.mjs) and the backfill (backfill.mjs) so a
// document lands in the same place whichever path it takes. The model still
// classifies; this module decides whether a document is filed at all, which
// property subfolder it belongs in, and what it is called.
import { ptDate, sanitizeFilename } from "./env.mjs"
import { PS_LABEL, WHITELIST, subfolderFor } from "./llm.mjs"
import { invoiceNumberFrom, money, parseItiAmounts, proofTitleFrom } from "./vendors.mjs"

export const PROPERTY_SUBFOLDERS = ["Purchase & Sale", "Disclosures", "Inspections", "Title & Escrow", "Loan & Insurance", "Construction", "Photos"]
export const INSURER_RE = /goosehead|obieinsurance|foremost|steadily|lemonade|statefarm|allstate|farmers|travelers|hippo/i
export const LENDER_RE = /kiavi|conventus|lendinghome|cvlending|onyxcap|lima ?one|roc ?capital/i
const PS_TYPES = new Set(["purchase_agreement", "counter", "addendum", "contingency_removal"])
// Ryan 2026-10-06: "anything that's ever related to a draw request — each lender has
// them — goes in the Construction folder." Kiavi's Draw 1 email carried the DRF
// spreadsheet as "invoice" and the lien package as "loan_docs"; only the latter filed,
// and to Loan & Insurance. A draw-shaped filename, or any document on a draw email,
// is a draw_request.
export const DRAW_FILE_RE = /\bDRF\b|draw[ _-]?(request|req|schedule|form|\d)|lien[ _-]?(package|waiver|release)|sworn statement|conditional waiver|unconditional waiver/i
export const DRAW_SUBJECT_RE = /\bdraws?\b|\bDRF\b|lien (package|waiver)/i
const NEVER_DRAW = new Set(["photos", "marketing_list", "flyer", "offering_memorandum"])
// Ryan 2026-10-16 (South Bay Termite): after payment the report arrives as a bare
// "Report 674.pdf" with the receipt on the last page, and the model reads the
// "Termite Report & Receipt" subject as an invoice. A termite/WDO email's
// attachment is the inspection unless its own name says invoice/receipt.
export const TERMITE_SUBJECT_RE = /termite|\bWDO\b/i
const TERMITE_NOT_REPORT_RE = /invoice|receipt/i
// Vendor paperwork (ITI Direct Mail): a print proof to approve, the CDTFA-230 /
// Reg 1541.5 sales-tax exemption certificate. "Proof of funds" is not a proof.
export const PROOF_FILE_RE = /proof/i
const PROOF_OF_FUNDS_RE = /proof of\b|\bPOF\b/i // proof of funds / insurance / payment — never a print proof
// "1541" alone would turn "1541 Foo Ave Addendum.pdf" into a tax form; the regulation is cited as 1541.5 / Reg 1541.
export const TAX_FORM_FILE_RE = /exempt|CDTFA|\b230-?P\b|1541\.5|\breg(?:ulation)?\.?\s*1541\b/i

/** Filename / sender heuristics on top of the classifier. Fixes the cases the model
 *  gets wrong on short attachment names ("Ryan Quito BPA.pdf" is not an RPA). */
export function refineDocType(filename, docType, senderEmail, subject = "") {
  const f = String(filename || "")
  const sender = String(senderEmail || "").toLowerCase()
  const insuranceContext = INSURER_RE.test(sender) || /\b(insurance|policy|dwelling|binder)\b/i.test(String(subject || ""))
  if (DRAW_FILE_RE.test(f)) return "draw_request"
  if (DRAW_SUBJECT_RE.test(String(subject || "")) && !NEVER_DRAW.has(docType) && !/\b(guide|quick start|faq|how to)\b/i.test(f)) return "draw_request"
  if (TERMITE_SUBJECT_RE.test(String(subject || "")) && !TERMITE_NOT_REPORT_RE.test(f) && (!docType || docType === "invoice" || docType === "other")) return "inspection"
  if (/\bBPA\b|business purpose/i.test(f)) return "loan_application"
  if (/\bEOI\b|evidence of insurance|binder/i.test(f)) return "evidence_of_insurance"
  if (TAX_FORM_FILE_RE.test(f)) return "tax_form"
  if (PROOF_FILE_RE.test(f) && !PROOF_OF_FUNDS_RE.test(f)) return "proof"
  if (/invoice/i.test(f)) return "invoice"
  if (/\b(quote|RCE|replacement cost|proposal)\b/i.test(f) && INSURER_RE.test(sender + " " + f)) return "insurance_quote"
  if (/natural hazard|\bNHD\b|JCP|disclosure report/i.test(f)) return "nhd"
  // Insurer paperwork around a quote or application (flood/property/privacy
  // "disclosures", concierge offers, summaries) is not a transaction disclosure.
  if (insuranceContext && /disclosure|concierge|privacy|application|summary/i.test(f)) return "insurance_quote"
  if (docType && docType !== "other") return docType
  if (/purchase agreement|\bRPA\b/i.test(f)) return "purchase_agreement"
  if (/counter/i.test(f)) return "counter"
  if (/addendum/i.test(f)) return "addendum"
  if (/contingency removal|\bCR\b/i.test(f)) return "contingency_removal"
  if (/transfer disclosure|\bTDS\b|\bSPQ\b|disclosure/i.test(f)) return "disclosure"
  if (/prelim|title report/i.test(f)) return "title_report"
  if (/\bEMD\b|earnest/i.test(f)) return "emd_receipt"
  if (/(buyer|seller|settlement|closing).*statement|statement.*(buyer|seller)/i.test(f)) return "closing_statement"
  if (/\bEOI\b|evidence of insurance|binder/i.test(f)) return "evidence_of_insurance"
  if (/PolicyIssued|declarations?|dec page/i.test(f)) return "insurance_policy"
  if (/termite|\bWDO\b|inspection report|home inspection/i.test(f)) return "inspection"
  if (/grant deed|deed of trust|recorded/i.test(f)) return "deed"
  return docType || "other"
}

/** final / estimated / bound / signed / quote / application, from the model + the names. */
export function stageOf({ filename, subject, modelStage, verifyStage }) {
  const hay = `${filename || ""} ${subject || ""}`
  if (/\bfinal\b/i.test(hay)) return "final"
  const s = verifyStage || modelStage || null
  if (!s && /\b(estimated|preliminary|revised)\b/i.test(hay)) return "estimated"
  return s
}

/** Is this attachment filed at all? Returns {file: bool, why}. */
export function filingDecision(docType, stage) {
  if (!WHITELIST.has(docType)) return { file: false, why: `${docType} is not a transaction document` }
  if (docType === "marketing_list") return { file: true, why: "marketing list" }
  const sub = subfolderFor(docType, docType === "loan_docs" && stage === "signed" ? "final" : stage)
  if (!sub) return { file: false, why: `${docType} at stage ${stage || "unknown"} (only bound insurance / final loan docs are filed)` }
  return { file: true, sub }
}

/** Next two-digit prefix for Purchase & Sale, looking only at files this convention named. */
export function nextSequence(existingNames) {
  const nums = existingNames.map((n) => Number((/^(\d{2}) (Offer RPA|Counter Offer|Addendum|Contingency Removal)\b/.exec(n) || [])[1])).filter((n) => Number.isFinite(n))
  return (nums.length ? Math.max(...nums) : 0) + 1
}

export function isPurchaseDoc(docType) {
  return PS_TYPES.has(docType)
}

/**
 * Deterministic destination for a whitelisted, property-matched attachment.
 * side = "buyer" | "seller" (which settlement statement Ryan receives on this deal).
 * Returns {folder, name, stage} or null when the document is not filed.
 */
export function destinationFor({ property, docType, filename, subject, receivedAt, stage, seq, side = "buyer", source = "attachment" }) {
  const decision = filingDecision(docType, stage)
  if (!decision.file || !decision.sub) return null
  const d = String(receivedAt || "").slice(0, 10)
  const ext = (/\.([a-z0-9]{1,6})$/i.exec(filename || "") || [])[1]?.toLowerCase() || "pdf"
  let name
  switch (docType) {
    case "inspection":
      // HomeSentry reports come from behind a tapinspect share link, dated so an
      // updated report files as a new version (the sha dedupe skips an unchanged one).
      name = source === "tapinspect" ? `${property} Inspection Report ${ptDate(receivedAt)} (HomeSentry).${ext}` : filename
      break
    case "purchase_agreement": case "counter": case "addendum": case "contingency_removal": {
      const n = (/addendum\s*#?\s*(\d+|[A-Z])\b/i.exec(filename) || [])[1]
      const label = docType === "addendum" && n ? `Addendum ${n}` : PS_LABEL[docType]
      name = `${String(seq || 1).padStart(2, "0")} ${label} ${d}.${ext}`
      break
    }
    case "title_report":
      name = `${property} Prelim ${d}.${ext}`
      break
    case "emd_receipt":
      name = `${property} EMD Receipt ${d}.${ext}`
      break
    case "closing_statement": case "net_sheet":
      name = `${property} ${side === "seller" ? "Seller" : "Buyer"} Statement ${d}${stage === "final" ? " FINAL" : " estimated"}.${ext}`
      break
    case "deed":
      name = `${property} Grant Deed ${d}.${ext}`
      break
    case "insurance_policy":
      name = `${property} Insurance Policy ${d}.${ext}`
      break
    default:
      name = filename // disclosures, inspections, EOIs and loan docs keep the sender's name
  }
  return { folder: `Properties/${property}/${decision.sub}`, name: sanitizeFilename(name), stage: stage || null }
}

/**
 * Deterministic name for a vendor document (Part A3 of the 2026-10-16 brief).
 *   invoice  → `ITI invoice <number> - <YYYY-MM-DD> - $<total>.pdf` (no `- $…` when the body has no Total line)
 *   proof    → `ITI proof <PandaDoc title> - signed - <YYYY-MM-DD>.pdf`
 *   tax_form → `ITI tax exemption form - <YYYY-MM-DD>[ - signed].pdf`
 *   quote    → `ITI quote - <YYYY-MM-DD>.pdf`
 * The prefix is the rule's id in upper case ("ITI"); the date is the email's
 * received date in PT. Returns { name, amounts, invoice_no } — amounts are the
 * parsed Subtotal / Shipping / Discount / Tax / Total for invoices, else null.
 * @param {{ rule: {id?: string, name?: string}, docType: string, filename: string, subject?: string|null, receivedAt?: string|null, bodyText?: string|null, signed?: boolean|null }} args
 * @returns {{ name: string, amounts: {subtotal: number|null, shipping: number|null, discount: number|null, tax: number|null, total: number|null}|null, invoice_no: string|null }}
 */
export function vendorFilename({ rule, docType, filename, subject, receivedAt, bodyText = "", signed = null }) {
  const prefix = String(rule?.id || "vendor").toUpperCase()
  const d = ptDate(receivedAt)
  const ext = (/\.([a-z0-9]{1,6})$/i.exec(filename || "") || [])[1]?.toLowerCase() || "pdf"
  let name
  let amounts = null
  let invoice_no = null
  switch (docType) {
    case "invoice": {
      amounts = parseItiAmounts(bodyText)
      invoice_no = invoiceNumberFrom(filename, subject)
      const total = money(amounts.total)
      name = `${prefix} invoice${invoice_no ? ` ${invoice_no}` : ""} - ${d}${total ? ` - ${total}` : ""}.${ext}`
      break
    }
    case "proof": {
      const title = proofTitleFrom(subject) || String(filename || "proof").replace(/\.[a-z0-9]{1,6}$/i, "")
      name = `${prefix} proof ${title} - signed - ${d}.${ext}`
      break
    }
    case "tax_form": {
      const isSigned = signed === true || /signed|executed/i.test(String(filename || ""))
      name = `${prefix} tax exemption form - ${d}${isSigned ? " - signed" : ""}.${ext}`
      break
    }
    case "quote":
      name = `${prefix} quote - ${d}.${ext}`
      break
    default:
      name = filename
  }
  return { name: sanitizeFilename(name), amounts, invoice_no }
}

/** "5764 Halleck Dr Buyer Statement 2026-10-02 FINAL.pdf" → same-day second copy gets the time appended. */
export function withTimeSuffix(name, receivedAt) {
  const t = new Date(receivedAt || Date.now()).toISOString().slice(11, 16).replace(":", "")
  return name.replace(/(\.[a-z0-9]+)$/i, ` ${t}$1`)
}
