// Inbox Agent — deterministic filing rules (Ryan 2026-10-02).
//
// Shared by the live worker (index.mjs) and the backfill (backfill.mjs) so a
// document lands in the same place whichever path it takes. The model still
// classifies; this module decides whether a document is filed at all, which
// property subfolder it belongs in, and what it is called.
import { sanitizeFilename } from "./env.mjs"
import { PS_LABEL, WHITELIST, subfolderFor } from "./llm.mjs"

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

/** Filename / sender heuristics on top of the classifier. Fixes the cases the model
 *  gets wrong on short attachment names ("Ryan Quito BPA.pdf" is not an RPA). */
export function refineDocType(filename, docType, senderEmail, subject = "") {
  const f = String(filename || "")
  const sender = String(senderEmail || "").toLowerCase()
  const insuranceContext = INSURER_RE.test(sender) || /\b(insurance|policy|dwelling|binder)\b/i.test(String(subject || ""))
  if (DRAW_FILE_RE.test(f)) return "draw_request"
  if (DRAW_SUBJECT_RE.test(String(subject || "")) && !NEVER_DRAW.has(docType) && !/\b(guide|quick start|faq|how to)\b/i.test(f)) return "draw_request"
  if (/\bBPA\b|business purpose/i.test(f)) return "loan_application"
  if (/\bEOI\b|evidence of insurance|binder/i.test(f)) return "evidence_of_insurance"
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
export function destinationFor({ property, docType, filename, subject, receivedAt, stage, seq, side = "buyer" }) {
  const decision = filingDecision(docType, stage)
  if (!decision.file || !decision.sub) return null
  const d = String(receivedAt || "").slice(0, 10)
  const ext = (/\.([a-z0-9]{1,6})$/i.exec(filename || "") || [])[1]?.toLowerCase() || "pdf"
  let name
  switch (docType) {
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

/** "5764 Halleck Dr Buyer Statement 2026-10-02 FINAL.pdf" → same-day second copy gets the time appended. */
export function withTimeSuffix(name, receivedAt) {
  const t = new Date(receivedAt || Date.now()).toISOString().slice(11, 16).replace(":", "")
  return name.replace(/(\.[a-z0-9]+)$/i, ` ${t}$1`)
}
