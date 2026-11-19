// Inbox Agent — deterministic filing rules (Ryan 2026-10-02).
//
// Shared by the live worker (index.mjs) and the backfill (backfill.mjs) so a
// document lands in the same place whichever path it takes. The model still
// classifies; this module decides whether a document is filed at all, which
// property subfolder it belongs in, and what it is called.
import { ptDate, sanitizeFilename } from "./env.mjs"
import { OFFER_PACKAGE_TYPES, PS_LABEL, WHITELIST, subfolderFor } from "./llm.mjs"
import { invoiceNumberFrom, money, paidName, parseItiAmounts, proofTitleFrom, stagingNumberFrom } from "./vendors.mjs"
import { freshbooksAmount } from "./fetch/freshbooks.mjs"

// Ryan 2026-10-17: "Staging" joins the standard set (the Ridgeview staging
// dispute — escrow asked for the agreement and nothing was on file). An
// existing property folder gets Staging/ on first use (resolvePath with
// create), never pre-emptively.
export const PROPERTY_SUBFOLDERS = ["Purchase & Sale", "Disclosures", "Inspections", "Title & Escrow", "Loan & Insurance", "Construction", "Staging", "Photos"]
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
const LOAN_LETTER_RE = /pre-?\s?(?:qualif|approv)|\b(?:loan|lender|mortgage)\s+approval/i // buyer lender letter sent with an offer
const PROOF_OF_FUNDS_RE = /proof of\b|\bPOF\b/i // proof of funds / insurance / payment — never a print proof
// "1541" alone would turn "1541 Foo Ave Addendum.pdf" into a tax form; the regulation is cited as 1541.5 / Reg 1541.
/** An image whose name says it is a buyer's proof of funds or lender letter ("POF - 2116 Quito Rd.jpg") is a document, even when Gmail marks it inline. */
export const isNamedOfferImage = (filename) => /\.(jpe?g|png)$/i.test(filename || "") && ((PROOF_OF_FUNDS_RE.test(filename) && !/insurance|payment/i.test(filename)) || LOAN_LETTER_RE.test(filename))
export const TAX_FORM_FILE_RE = /exempt|CDTFA|\b230-?P\b|1541\.5|\breg(?:ulation)?\.?\s*1541\b/i
export const DOCUSIGN_SUMMARY_RE = /^summary\.pdf$/i

/** Filename / sender heuristics on top of the classifier. Fixes the cases the model
 *  gets wrong on short attachment names ("Ryan Quito BPA.pdf" is not an RPA). */
export function refineDocType(filename, docType, senderEmail, subject = "") {
  const f = String(filename || "")
  const sender = String(senderEmail || "").toLowerCase()
  const insuranceContext = INSURER_RE.test(sender) || /\b(insurance|policy|dwelling|binder)\b/i.test(String(subject || ""))
  if (DOCUSIGN_SUMMARY_RE.test(f) && /docusign|^completed:/i.test(String(subject || ""))) return "other" // DocuSign's certificate of completion rides along with every envelope
  if (PROOF_OF_FUNDS_RE.test(f) && !/insurance|payment/i.test(f)) return "proof_of_funds"
  if (LOAN_LETTER_RE.test(f)) return "loan_letter"
  if (docType === "proof" && !PROOF_FILE_RE.test(f)) docType = "other" // the classifier's "proof" is a print proof; anything else so labelled is just unknown
  if (DRAW_FILE_RE.test(f)) return "draw_request"
  if (DRAW_SUBJECT_RE.test(String(subject || "")) && !NEVER_DRAW.has(docType) && !/\b(guide|quick start|faq|how to)\b/i.test(f)) return "draw_request"
  if (TERMITE_SUBJECT_RE.test(String(subject || "")) && !TERMITE_NOT_REPORT_RE.test(f) && (!docType || docType === "invoice" || docType === "other")) return "inspection"
  if (/\bBPA\b|business purpose/i.test(f)) return "loan_application"
  if (/\bEOI\b|evidence of insurance|binder/i.test(f)) return "evidence_of_insurance"
  // proof / tax_form are vendor doc types and are decided only on a vendor email
  // (vendors.mjs vendorDocType). Applying them here would turn a seller's
  // "Exempt Seller Disclosure" or an "Insurance Proof" PDF into an ignored vendor doc.
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

/** Is this attachment filed at all? Returns {file: bool, why}.
 *  `offer` = the email carries an offer Ryan received on his own listing (see
 *  inboundOfferFrom): the whole package files to Offers/, including the pieces
 *  (POF, escrow wire sheet) that are never filed on his own purchases. */
export function filingDecision(docType, stage, { offer = false } = {}) {
  if (offer && OFFER_PACKAGE_TYPES.has(docType)) return { file: true, sub: OFFERS_SUBFOLDER, why: "offer package" }
  if (!WHITELIST.has(docType)) return { file: false, why: `${docType} is not a transaction document` }
  if (docType === "marketing_list") return { file: true, why: "marketing list" }
  const sub = subfolderFor(docType, docType === "loan_docs" && stage === "signed" ? "final" : stage)
  if (!sub) return { file: false, why: `${docType} at stage ${stage || "unknown"} (only bound insurance / final loan docs are filed)` }
  return { file: true, sub }
}

/** Next two-digit prefix for Purchase & Sale, looking only at files this convention named. */
export function nextSequence(existingNames) {
  const nums = existingNames.map((n) => Number((/^(\d{2}) (Offer RPA|Counter Offer|Addendum|Contingency Removal|(?:Sale|Purchase) – Ratified Contract)\b/.exec(n) || [])[1])).filter((n) => Number.isFinite(n))
  return (nums.length ? Math.max(...nums) : 0) + 1
}

export function isPurchaseDoc(docType) {
  return PS_TYPES.has(docType)
}

// ---- offers Ryan receives (2026-11-01)
export const OFFERS_SUBFOLDER = "Offers"
// Names that make a purchase document Ryan's own deal rather than an offer he
// received: himself, the company, and the Quito/Halleck partnership entity.
// Extend with inbox_settings.agent.our_names.
export const OUR_NAMES_DEFAULT = ["LaRocca", "LRG Homes", "LRG", "Charity Doors"]
const BUYER_NOISE_RE = /,?\s*(a|an)\s+(california|delaware|nevada|wyoming)?\s*(limited liability company|corporation|trust|partnership)\b.*$|\s*and\/or\s+(nominee|assignee)s?\b.*$|\s*\((?:or|and\/or)?\s*assignee\)/i

/** The buyer's name as a folder prefix: "Coko LLC, a California limited liability company and/or assignee" → "Coko LLC". */
export function cleanBuyerName(buyer) {
  const b = String(buyer || "").replace(/\s+/g, " ").replace(BUYER_NOISE_RE, "").replace(/[.,;]+$/, "").trim()
  return b
}

/**
 * Did Ryan receive this offer, or make it? From the verify read of the first page
 * (buyer / seller / price). An offer is inbound when the document names a buyer
 * and none of our names appear in it. null = Ryan's own purchase chain (or the
 * page could not be read), so the existing Purchase & Sale rule applies.
 * @returns {{ buyer: string, price: number|null } | null}
 */
export function inboundOfferFrom(verify, ourNames = OUR_NAMES_DEFAULT) {
  const buyer = cleanBuyerName(verify?.buyer)
  if (!buyer) return null
  const hay = buyer.toLowerCase()
  if ((ourNames || []).some((n) => n && hay.includes(String(n).toLowerCase()))) return null
  const price = Number(verify?.price)
  return { buyer, price: Number.isFinite(price) && price > 0 ? price : null }
}

/** $1,500,000 → "$1.5M"; $1,465,000 → "$1.465M"; $850,000 → "$850k". */
export function shortPrice(price) {
  const n = Number(price)
  if (!Number.isFinite(n) || n <= 0) return null
  if (n >= 1e6) return `$${String(Number((n / 1e6).toFixed(3)))}M`
  if (n >= 1e3) return `$${String(Number((n / 1e3).toFixed(1)))}k`
  return `$${n}`
}

const ENTITY_RE = /\b(LLC|L\.L\.C\.?|Inc\.?|Corp\.?|Corporation|Company|Co\.|LP|LLP|Trust|Homes|Holdings|Investments?|Properties|Capital|Partners|Group|Ventures|Fund|Realty|Development)\b/i
const NAME_SUFFIX_RE = /^(jr|sr|ii|iii|iv)\.?$/i

/** The names a buyer folder is known by: an entity whole ("Coko LLC"), people by surname ("Priya Anand Sharma, Rohan Mehta" → Sharma, Mehta). */
export function buyerSurnames(buyer) {
  const b = cleanBuyerName(buyer)
  if (!b) return []
  if (ENTITY_RE.test(b)) return [b]
  const out = []
  for (const person of b.split(/\s*(?:,|&|\band\b)\s*/i).map((p) => p.trim()).filter(Boolean)) {
    const words = person.split(/\s+/).filter((w) => !NAME_SUFFIX_RE.test(w))
    const last = words.at(-1)
    if (last && !out.some((o) => o.toLowerCase() === last.toLowerCase())) out.push(last)
  }
  return out
}

/** One folder per buyer, dated so the folders sort in order: "2026-11-17 Sharma & Mehta $1.05M" (Ryan 2026-11-18). */
export function offerPackageFolder({ buyer, price, receivedAt }) {
  const p = shortPrice(price)
  const who = buyerSurnames(buyer).join(" & ") || cleanBuyerName(buyer)
  return sanitizeFilename(`${ptDate(receivedAt)} ${who}${p ? ` ${p}` : ""}`)
}

/**
 * A later piece of the same negotiation (counter, revised offer) joins the buyer's existing package folder.
 * Matched on surnames, so "Daniel Tran, Mei-Lin Wong" and "Daniel Tran & Mei-Lin Wong" are one buyer
 * (they had been split into two Halleck folders); old-style names ("Coko LLC $1.5M offer 2026-10-30") still match.
 */
export function offerFolderMatch(existingNames, buyer) {
  const want = buyerSurnames(buyer).map((n) => n.toLowerCase())
  if (!want.length) return null
  const has = (hay, w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(hay)
  const hits = (existingNames || []).filter((n) => n !== OLDER_VERSIONS && want.every((w) => has(String(n), w)))
  return hits.find(isAcceptedFolder) || hits[0] || null
}

// ---- ratified contracts (Ryan 2026-11-18)
// Offers, counters and counters-to-counters fly back and forth while a property
// is negotiated. Only signed copies are kept (a DocuSign "please sign" copy and
// any PDF stamped "In Process" are drafts); each document is named by its form,
// number, date and price; when the other side signs the last counter's
// Acceptance, the chain (RPA → SCO 1 → BCO 1 …) is joined into one PDF in
// Purchase & Sale — the "ratified contract" escrow wants.
export const OLDER_VERSIONS = "Older versions"
const ACCEPTED_SUFFIX = " – ACCEPTED"
export const isAcceptedFolder = (name) => /\s[–-]\sACCEPTED$/i.test(String(name || ""))
export const acceptedFolderName = (name) => (isAcceptedFolder(name) ? name : `${name}${ACCEPTED_SUFFIX}`)

/** $1060000 → "$1,060,000" (whole dollars; contract prices never carry cents worth showing). */
export function dollars(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return null
  return `$${Math.round(v).toLocaleString("en-US")}`
}
const priceNum = (s) => {
  const n = Number(String(s || "").replace(/[$,\s]/g, ""))
  return Number.isFinite(n) && n >= 10000 ? n : null
}

/**
 * What a contract PDF is, from its text (pdftotext -layout): the C.A.R. form and number, the price,
 * DocuSign envelope ids, and whether DocuSign stamped it "In Process" (an unsigned draft).
 * null when there is no text to read.
 * @returns {{ form: "RPA"|"SCO"|"BCO"|"SMCO"|null, number: number|null, price: number|null, envelopeIds: string[], inProcess: boolean } | null}
 */
export function contractFacts(text) {
  const t = String(text || "")
  if (!t.trim()) return null
  const envelopeIds = [...new Set([...t.matchAll(/Envelope ID:\s*([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})/gi)].map((m) => m[1].toUpperCase()))]
  // DocuSign prints a standalone "In Process" stamp on every page of an envelope that is still out for signature.
  const inProcess = envelopeIds.length > 0 && /^\s*In Process\s*$/m.test(t)
  // The form is the title that appears first: a Buyer Counter Offer mentions "Seller Counter Offer No. 1" further down.
  const titles = [
    ["SMCO", /SELLER\s+MULTIPLE\s+COUNTER\s+OFFER\s+No\.?\s*(\d+)/],
    ["SCO", /SELLER\s+COUNTER\s+OFFER\s+No\.?\s*(\d+)/],
    ["BCO", /BUYER\s+COUNTER\s+OFFER\s+No\.?\s*(\d+)/],
    ["RPA", /(?:CALIFORNIA\s+)?RESIDENTIAL\s+PURCHASE\s+AGREEMENT\s+AND\s+JOINT\s+ESCROW|CALIFORNIA\s+RESIDENTIAL\s+PURCHASE\s+AGREEMENT/],
  ]
  let form = null, number = null, at = Infinity
  for (const [f, re] of titles) {
    const m = re.exec(t)
    if (m && m.index < at) {
      at = m.index
      form = f
      number = m[1] ? Number(m[1]) : null
    }
  }
  let price = null
  if (form && form !== "RPA") price = priceNum((/purchase\s+price\s+(?:to\s+be|shall\s+be|is|of)\s*:?\s*(\$?\s*[\d,]{5,}(?:\.\d{2})?)/i.exec(t) || [])[1])
  if (form === "RPA") price = priceNum((/Purchase\s+Price\s+\$\s*([\d,]{5,}(?:\.\d{2})?)/.exec(t) || [])[1])
  return { form, number, price, envelopeIds, inProcess }
}

/**
 * Did the party receiving this form sign its Acceptance, read from the PDF text? A counter's
 * "N. ACCEPTANCE:" paragraph carries a date only once the other side signs it (Halleck: blank on
 * SCO 1, "11/18/2026" on BCO 1). Accepting "subject to" a new counter is a counter, not acceptance;
 * an RPA answered with a Seller Counter Offer was not accepted. null = the text can't tell (scan,
 * odd layout, or an RPA whose seller signature is further down) and the model's read decides.
 * The model alone called SCO 1 accepted because it saw Ryan's own signature, so text wins.
 */
export function acceptanceFromText(text, form) {
  const t = String(text || "")
  if (!t.trim() || !form) return null
  if (form === "RPA") {
    const m = /ACCEPTANCE OF OFFER:([\s\S]{0,1500})/.exec(t)
    if (!m) return null
    if (/^\s*X\s+Seller\s+(?:Multiple\s+)?Counter\s+Offer/m.test(m[1])) return false
    return null
  }
  const m = /^\s*\d+\.\s+ACCEPTANCE:([\s\S]*?)(?=^\s*\d+\.\s+[A-Z]|©)/m.exec(t)
  if (!m) return null
  const block = m[1]
  if (/COUNTER\s+OFFER\s+No\.\s*\d/i.test(block)) return false
  return /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(block)
}

/**
 * Is this signed form the one that ratifies the deal? Counters: the text decides when it can.
 * A Seller Multiple Counter Offer also needs the seller's final acceptance, so the text (buyer
 * signed) AND the model (final acceptance signed) must agree. An RPA: a ticked counter-offer box
 * is a no; otherwise the model's read of the seller's signature.
 * @param {{ form: string|null|undefined, textSays?: boolean|null, modelSays?: boolean|null }} args
 */
export function isRatified({ form, textSays = null, modelSays = null }) {
  if (!form) return false
  if (form === "SMCO") return textSays !== false && modelSays === true
  if (textSays !== null) return textSays === true
  return modelSays === true
}

/** "SCO 1" / "BCO 2" / "RPA" — the label a contract file starts with. */
export function contractLabel(facts) {
  if (!facts?.form) return null
  return facts.form === "RPA" ? "RPA" : `${facts.form}${facts.number ? ` ${facts.number}` : ""}`
}
const LABEL_RE = /^(RPA|SCO \d+|BCO \d+|SMCO \d+)\b/
/** The contract label a filed name starts with ("SCO 1 2026-11-17 $1,075,000.pdf" → "SCO 1"), else null. */
export const labelOfName = (name) => (LABEL_RE.exec(String(name || "")) || [])[1] || null

/**
 * The negotiation chain inside a buyer's folder, in contract order: the RPA, then the counters
 * by number with the seller's counter before the buyer's reply (SCO 1 → BCO 1 → SCO 2 …),
 * one copy of each (the latest). Takes file objects ({name, …}); files that are not contract forms are left out.
 * @template {{ name?: string }} F
 * @param {F[]} files
 * @returns {F[]}
 */
export function contractChain(files) {
  const rank = (label) => {
    if (label === "RPA") return 0
    const [form, n] = label.split(" ")
    return Number(n) * 10 + (form === "BCO" ? 5 : 0)
  }
  // One copy per form: the latest name (names carry the date) wins.
  const byLabel = new Map()
  for (const f of files || []) {
    const label = labelOfName(f?.name)
    if (!label) continue
    const cur = byLabel.get(label)
    if (!cur || String(f.name).localeCompare(String(cur.name)) > 0) byLabel.set(label, f)
  }
  if (!byLabel.has("RPA")) return []
  return [...byLabel.entries()].sort(([a], [b]) => rank(a) - rank(b)).map(([, f]) => f)
}

/**
 * Ryan's own purchase chain in Purchase & Sale ("01 Offer RPA …", "02 Counter Offer …"): the latest
 * Offer RPA and every counter numbered after it, in sequence order.
 * @template {{ name?: string }} F
 * @param {F[]} files
 * @returns {F[]}
 */
export function purchaseChain(files) {
  const seq = (f) => Number((/^(\d{2}) /.exec(String(f?.name || "")) || [])[1])
  const kind = (f) => (/^\d{2} (Offer RPA|Counter Offer)\b/.exec(String(f?.name || "")) || [])[1] || null
  const docs = (files || []).filter((f) => kind(f) && Number.isFinite(seq(f))).sort((a, b) => seq(a) - seq(b))
  const lastRpa = docs.map(kind).lastIndexOf("Offer RPA")
  return lastRpa < 0 ? [] : docs.slice(lastRpa)
}

/** "04 Sale – Ratified Contract 2026-11-18 $1,060,000.pdf" (side = Ryan's side: seller on his listings, buyer on his purchases). */
export function ratifiedContractName({ side = "seller", receivedAt, price, seq = 1 }) {
  const p = dollars(price)
  return sanitizeFilename(`${String(seq).padStart(2, "0")} ${side === "seller" ? "Sale" : "Purchase"} – Ratified Contract ${ptDate(receivedAt)}${p ? ` ${p}` : ""}.pdf`)
}

/**
 * Does the email itself name this property? A DocuSign "Completed" email carries only the file name, and the
 * classifier once guessed 2116 Quito Rd for a Halleck counter whose first page said 5764 Halleck Dr. When the
 * street number and name are nowhere in the subject or body, the PDF's own address decides.
 */
export function emailNamesProperty(text, label) {
  const m = /^\s*(\d+)\s+([A-Za-z][A-Za-z'-]*)/.exec(String(label || ""))
  if (!m) return false
  const hay = String(text || "").toLowerCase()
  return new RegExp(`\\b${m[1]}\\b`).test(hay) && hay.includes(m[2].toLowerCase())
}

const OFFER_DOC_LABEL = {
  purchase_agreement: "Offer RPA", counter: "Counter Offer", addendum: "Addendum", contingency_removal: "Buyer Contingency Removal",
  closing_statement: "Buyer Closing Statement", net_sheet: "Buyer Net Sheet", emd_receipt: "EMD Receipt", proof_of_funds: "Proof of Funds", loan_letter: "Pre-Approval Letter", escrow_instructions: "Escrow Wire Instructions",
}
/** Short, dated names inside the package folder (the folder already says who); a contract form reads
 *  "RPA 2026-11-17 $1,050,000.pdf" / "SCO 1 2026-11-17 $1,075,000.pdf" so the folder tells the negotiation. */
/** @param {{ docType: string, filename: string, receivedAt: string, facts?: { form: string|null, number: number|null, price: number|null } | null }} args */
export function offerDocName({ docType, filename, receivedAt, facts = null }) {
  const ext = (/\.([a-z0-9]{1,6})$/i.exec(filename || "") || [])[1]?.toLowerCase() || "pdf"
  const formLabel = (docType === "purchase_agreement" || docType === "counter") && contractLabel(facts)
  if (formLabel) {
    const p = dollars(facts.price)
    return sanitizeFilename(`${formLabel} ${ptDate(receivedAt)}${p ? ` ${p}` : ""}.${ext}`)
  }
  const n = (/addendum\s*#?\s*(\d+|[A-Z])\b/i.exec(filename || "") || [])[1]
  const label = docType === "addendum" && n ? `Addendum ${n}` : OFFER_DOC_LABEL[docType]
  return sanitizeFilename(label ? `${label} ${String(receivedAt || "").slice(0, 10)}.${ext}` : filename)
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
 *
 * Staging (Part A of the 2026-10-17 brief; prefix = the rule's `name_short`):
 *   staging_proposal → `StyleMe proposal SS01174 - 2026-10-10.pdf`
 *   staging_invoice  → `StyleMe invoice 080223VA - 2026-10-17 - $3,253.75.pdf` (` PAID` before the extension when `paid`)
 * Number from the subject's parentheses or the link's estimateNumber /
 * invoiceNumber; amount from the body ("for $3,253.75") or the fetched page
 * text ("Amount Due (USD) $3,253.75"); `amounts.total` carries it.
 * @param {{ rule: {id?: string, name?: string, name_short?: string}, docType: string, filename: string, subject?: string|null, receivedAt?: string|null, bodyText?: string|null, signed?: boolean|null, url?: string|null, pageText?: string|null, paid?: boolean }} args
 * @returns {{ name: string, amounts: {subtotal: number|null, shipping: number|null, discount: number|null, tax: number|null, total: number|null}|null, invoice_no: string|null }}
 */
export function vendorFilename({ rule, docType, filename, subject, receivedAt, bodyText = "", signed = null, url = null, pageText = null, paid = false }) {
  const prefix = String(rule?.id || "vendor").toUpperCase()
  const d = ptDate(receivedAt)
  const ext = (/\.([a-z0-9]{1,6})$/i.exec(filename || "") || [])[1]?.toLowerCase() || "pdf"
  let name
  let amounts = null
  let invoice_no = null
  switch (docType) {
    case "staging_proposal": case "staging_invoice": {
      const vendor = String(rule?.name_short || rule?.name || prefix)
      const number = stagingNumberFrom(subject, url)
      if (docType === "staging_proposal") {
        name = `${vendor} proposal${number ? ` ${number}` : ""} - ${d}.${ext}`
      } else {
        invoice_no = number
        const total = freshbooksAmount(subject, bodyText, pageText)
        amounts = { subtotal: null, shipping: null, discount: null, tax: null, total }
        name = `${vendor} invoice${number ? ` ${number}` : ""} - ${d}${money(total) ? ` - ${money(total)}` : ""}.${ext}`
        if (paid) name = paidName(name)
      }
      break
    }
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

/**
 * Where a `destination: "property"` vendor document goes:
 * `Properties/<property>/<rule.subfolder || subfolderFor(docType)>` — StyleMe's
 * proposals and invoices → `Properties/2116 Quito Rd/Staging`. null when the
 * doc type has no subfolder (never files).
 * @param {{ rule: {subfolder?: string|null}|null, docType: string, property: string|null|undefined }} args
 */
export function vendorPropertyFolder({ rule, docType, property }) {
  if (!property) return null
  const sub = rule?.subfolder || subfolderFor(docType, null)
  return sub ? `Properties/${property}/${sub}` : null
}

/**
 * Part G (briefs/BRIEF_INBOX_LOOP_HYGIENE_2026-10-17.md): is this attachment
 * already in Drive under another name? Dominic's re-scrubbed CSVs sat as
 * proposals for days while the identical bytes lived in Marketing/2026/… as
 * "v2 2026-10-14 - <name>.csv". `files` = a drive.mjs walkFolder listing;
 * size is the cheap pre-filter, md5Checksum decides. Returns the matching file
 * or null (a same-size file with another md5 is not a duplicate).
 * @param {{ size: number|null|undefined, md5: string|null|undefined }} att
 * @param {Array<{ id?: string, name?: string, size?: number|string|null, md5Checksum?: string|null, webViewLink?: string|null, path?: string }>} files
 */
export function driveDuplicateOf({ size, md5 }, files) {
  const want = String(md5 || "").trim().toLowerCase()
  const n = Number(size)
  if (!want || !Number.isFinite(n) || n <= 0) return null
  for (const f of files || []) {
    if (f?.size == null || Number(f.size) !== n) continue
    if (String(f.md5Checksum || "").toLowerCase() === want) return f
  }
  return null
}

// Ryan 2026-11-01: "sometimes humans make errors, they send them twice etc but we
// should dedupe the disclosures on our end." The Quito disclosure set arrived
// three times: DocuSign's Completed email carried the PDFs as attachments AND the
// link fetcher pulled the same envelope (DocuSign regenerates each PDF, so the
// bytes differ by a few bytes and neither sha256 nor md5 matched), then a second
// envelope re-sent the NHD as "… (1) (1).pdf". Names survive what bytes don't:
// "Market_Conditions_Advisory_-_6_24.pdf" and "Market Conditions Advisory - 624.pdf"
// are the same document, as are "X.pdf" and "X (1).pdf".

/** Filename reduced to what the sender can't vary: letters and digits, no extension, no "(1)" / "copy". */
export function normalizeDocName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,6}$/, "")
    .replace(/\s*[([]\s*\d+\s*[)\]]/g, "")
    .replace(/\b(copy|duplicate)\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
}
export function sameDocName(a, b) {
  const x = normalizeDocName(a)
  return x.length >= 6 && x === normalizeDocName(b)
}

/**
 * A file in the property's Drive subtree with the same (normalized) name.
 * `same` = also the same size within 0.5% (floor 512 bytes) → the same document,
 * regenerated; `same: false` = a namesake with materially different bytes — a new
 * version, to be filed next to the old one under its spelling. null = nothing.
 * @param {{ name: string, size: number|null|undefined }} att
 * @param {Array<{ id?: string, name?: string, size?: number|string|null, path?: string, webViewLink?: string|null }>} files
 * @returns {{ file: { id?: string, name?: string, size?: number|string|null, path?: string, webViewLink?: string|null }, same: boolean } | null}
 */
export function driveNamesakeOf({ name, size }, files, { tolerance = 0.005, floor = 512 } = {}) {
  const want = normalizeDocName(name)
  if (want.length < 6) return null
  const hits = (files || []).filter((f) => normalizeDocName(f?.name) === want)
  if (!hits.length) return null
  const n = Number(size)
  const close = Number.isFinite(n) && n > 0 ? hits.find((f) => f.size != null && Math.abs(Number(f.size) - n) <= Math.max(floor, n * tolerance)) : null
  return close ? { file: close, same: true } : { file: hits[0], same: false }
}

/** "5764 Halleck Dr Buyer Statement 2026-10-02 FINAL.pdf" → same-day second copy gets the time appended. */
export function withTimeSuffix(name, receivedAt) {
  const t = new Date(receivedAt || Date.now()).toISOString().slice(11, 16).replace(":", "")
  return name.replace(/(\.[a-z0-9]+)$/i, ` ${t}$1`)
}
