// Inbox Agent — model calls. Anthropic SDK only (lib/llm.ts policy). Haiku for
// per-email classification and filing proposals, Sonnet for the rules doc and
// deal screens. PDFs go to the model as document blocks (no local PDF parser
// in the repo), capped by MAX_PDF_TO_MODEL_BYTES.
import Anthropic from "@anthropic-ai/sdk"
import { MAX_PDF_TO_MODEL_BYTES, warn } from "./env.mjs"

export const HAIKU = "claude-haiku-4-5"
export const SONNET = "claude-sonnet-5"

let client = null
function anthropic() {
  if (!client) client = new Anthropic()
  return client
}

function extractJson(text) {
  const cleaned = String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim()
  const s = cleaned.indexOf("{")
  const e = cleaned.lastIndexOf("}")
  return s >= 0 && e > s ? cleaned.slice(s, e + 1) : cleaned
}

/** One user turn. `docs` = [{kind:"pdf"|"image", data:Buffer, mime, name}]. */
export async function complete({ model = HAIKU, system, prompt, docs = [], maxTokens = 1500, tag = "[llm]", thinking = true }) {
  const content = []
  for (const d of docs) {
    if (!d?.data) continue
    if (d.kind === "pdf") {
      if (d.data.length > MAX_PDF_TO_MODEL_BYTES) {
        content.push({ type: "text", text: `(attachment ${d.name} is ${(d.data.length / 1e6).toFixed(1)} MB — too large to include)` })
        continue
      }
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: d.data.toString("base64") }, title: d.name })
    } else if (d.kind === "image" && /^image\/(png|jpe?g|webp|gif)$/.test(d.mime || "")) {
      if (d.data.length > 5 * 1024 * 1024) continue
      content.push({ type: "image", source: { type: "base64", media_type: d.mime, data: d.data.toString("base64") } })
    }
  }
  content.push({ type: "text", text: prompt })
  const run = async (max_tokens) => {
    const res = await anthropic().messages.create({
      model,
      max_tokens,
      ...(system ? { system } : {}),
      ...(model === SONNET && thinking === false ? { thinking: { type: "disabled" } } : {}),
      messages: [{ role: "user", content }],
    })
    if (res.stop_reason === "refusal") throw new Error(`${tag} model declined`)
    const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim()
    return { text, stop: res.stop_reason }
  }
  let out = await run(maxTokens)
  if (out.stop === "max_tokens") {
    warn(`${tag} hit max_tokens=${maxTokens}; retrying ×3`)
    out = await run(maxTokens * 3)
  }
  return out.text
}

export async function completeJson(args) {
  const text = await complete(args)
  try {
    return JSON.parse(extractJson(text))
  } catch (e) {
    warn(`${args.tag || "[llm]"} unparseable JSON:`, text.slice(0, 300))
    return null
  }
}

// ---------------------------------------------------------------- prompts

export const DOC_TYPES = [
  "purchase_agreement", "counter", "addendum", "contingency_removal", "disclosure", "nhd", "inspection", "appraisal",
  "title_report", "escrow_instructions", "emd_receipt", "net_sheet", "closing_statement", "deed",
  "evidence_of_insurance", "insurance_policy", "insurance_quote", "loan_docs", "loan_application",
  "invoice", "bid", "offering_memorandum", "flyer", "marketing_list", "tax_doc", "lease", "photos", "other",
]

// Ryan 2026-10-02 — the transaction whitelist. Only these document types are
// ever filed; everything else on a transaction thread is logged and ignored
// (no card). Insurance files only when bound; loan docs only when final;
// settlement statements are kept in every version (dated, never overwritten).
export const WHITELIST = new Set([
  "purchase_agreement", "counter", "addendum", "contingency_removal", "disclosure", "nhd", "inspection", "appraisal",
  "title_report", "emd_receipt", "net_sheet", "closing_statement", "deed", "evidence_of_insurance", "insurance_policy",
  "loan_docs", "marketing_list",
])

/** Which property subfolder a whitelisted doc type lives in (null = not filed). */
export function subfolderFor(docType, stage) {
  switch (docType) {
    case "purchase_agreement": case "counter": case "addendum": case "contingency_removal":
      return "Purchase & Sale"
    case "disclosure": case "nhd":
      return "Disclosures"
    case "inspection": case "appraisal":
      return "Inspections"
    case "title_report": case "emd_receipt": case "net_sheet": case "closing_statement": case "deed":
      return "Title & Escrow"
    case "evidence_of_insurance": case "insurance_policy":
      return stage === "bound" || stage === "final" ? "Loan & Insurance" : null
    case "loan_docs":
      return stage === "final" || stage === "bound" ? "Loan & Insurance" : null
    default:
      return null
  }
}
/** Human label used in Purchase & Sale file names. */
export const PS_LABEL = { purchase_agreement: "Offer RPA", counter: "Counter Offer", addendum: "Addendum", contingency_removal: "Contingency Removal" }

export const VERIFY_SYSTEM = `You read the first pages of a real-estate document and report which property it is about. Be literal: copy the street address exactly as printed; if there is an Assessor's Parcel Number, copy it. If no property is named, say null. Output strict JSON.`
export function verifyPrompt({ filename, candidates }) {
  return `DOCUMENT: ${filename}
Ryan's active properties: ${candidates.join("; ") || "(none listed)"}

Which property is this document about? Look at the first page(s): the "Property" line of a purchase agreement, the property address on a settlement statement, prelim, disclosure, insurance binder, loan document, or report.
Return JSON only: {"address": "2116 Quito Rd, San Jose, CA 95130" | null, "label": "2116 Quito Rd" | null, "apn": "403-29-017" | null, "matches": "<one of Ryan's active properties above, exactly as listed, or null>", "stage": "quote"|"application"|"estimated"|"final"|"bound"|"signed"|null, "confidence": 0.0-1.0}
"label" = number + street name only. "stage": final/FINAL in a title → final; "estimated"/"preliminary" → estimated; an insurance binder, declarations page or evidence of insurance naming a lender → bound; an insurance quote or proposal → quote; a loan application → application; a fully executed contract → signed.`
}

export const CLASSIFY_SYSTEM = `You are the inbox triage layer for Ryan LaRocca, a real-estate investor (LRG Homes, San Jose CA). He flips houses and buys small multifamily, sells his own flips through listing agents, and works with escrow officers (Chicago Title), lenders (Kiavi, Conventus), insurance (Obie), contractors, and agents who send him deals.
You read ONE inbound email and return strict JSON. Be literal and conservative: never invent an address; if a property cannot be identified say null. Ignore email signatures, disclaimers and marketing footers when judging what the sender wants.`

export function classifyPrompt({ msg, attachments, hints }) {
  const att = attachments.map((a, i) => `${i + 1}. ${a.filename} (${a.mime}, ${Math.round((a.size || 0) / 1024)} KB)`).join("\n") || "(none)"
  return `TODAY: ${new Date().toISOString().slice(0, 10)}
FROM: ${msg.from.name ? `${msg.from.name} <${msg.from.email}>` : msg.from.email}
TO: ${msg.to}
CC: ${msg.cc || "-"}
DELIVERY: ${/ryan@lrghomes\.com/i.test(`${msg.to} ${msg.cc}`) ? "Ryan is a named recipient" : "Ryan is NOT in To/Cc (BCC or list blast) — treat a property pitch as a broker_blast, not a direct lead"}
DATE: ${msg.internalDate}
SUBJECT: ${msg.subject}

ATTACHMENTS (non-inline):
${att}

KNOWN CONTEXT (may be empty):
- Is the sender someone Ryan has done business with (in his CRM or prior deals)? ${hints.knownSender ? "YES" : "no record"}
- Things Ryan has told the agent (answers to earlier questions): ${hints.knowledge || "none"}
- Sender's previous properties with Ryan: ${hints.senderProperties.join("; ") || "none"}
- Ryan's active / recent properties: ${hints.activeProperties.join("; ") || "none"}
- Drive property folders: ${hints.propertyFolders.join("; ") || "none"}

BODY (truncated):
"""
${msg.text.slice(0, 6000)}
"""

Return JSON only:
{
  "is_human": true|false,                      // a person writing to Ryan (or a service acting for one: DocuSign, Zix, Authentisign count as true), vs newsletters/receipts/notifications/DMARC
  "kind": "human"|"automated"|"newsletter"|"docusign_request"|"docusign_completed"|"esign_completed"|"zix"|"deal_lead"|"broker_blast"|"skip",
  "property": {"label": "93 Ridgeview", "address": "93 Ridgeview Ave, San Jose, CA 95127"} | null,   // label = number + street name only
  "attachments": [ {"filename": "...", "relevant": true|false, "doc_type": "<one of: ${DOC_TYPES.join(", ")}>", "property_label": "..."|null, "signed": true|false|null, "stage": "quote"|"application"|"estimated"|"final"|"bound"|null, "description": "6-12 words"} ],
  // doc_type notes: counter = counter offer (SCO/BCO); contingency_removal = CR form; nhd = natural hazard disclosure report; emd_receipt = earnest-money wire/deposit receipt from escrow; closing_statement = buyer/seller settlement statement (any version); deed = grant deed / recorded docs; evidence_of_insurance = EOI/binder; insurance_policy = declarations page / policy; insurance_quote = quotes, proposals, RCE, applications not yet bound; loan_application = applications, affidavits, disclosures, guides from a lender; loan_docs = final executed loan documents (note, deed of trust, closing disclosure); marketing_list = CSV/XLSX owner or farm lists from a title rep. stage: "final" when the sender calls it final; "estimated" for estimated/preliminary statements; "bound" for an insurance binder/EOI/dec page; "quote"/"application" otherwise for insurance and loan paperwork.
  "solicitation": true|false,                  // the sender is marketing TO Ryan — a listing/flyer/open house, a financing or service pitch, a rate sheet, a bid-list invite, a newsletter — rather than responding to something Ryan started or working a deal he is in. A solicitation never needs a reply from Ryan even if it says "RSVP" or "call me".
  "needs_reply": true|false,                   // does the sender need something from Ryan (an answer, a signature, a document, a decision, a signing time)? Always false when solicitation is true.
  "ask": "one sentence: what they need from Ryan" | null,
  "due_on": "YYYY-MM-DD" | null,               // only if a date/deadline is stated or clearly implied (e.g. 'tomorrow', 'by Friday')
  "priority": "high"|"normal"|"low",           // high = money/closing/signature/deadline within ~3 days or a direct deal from a person
  "category": "escrow"|"lender"|"agent"|"contractor"|"tax"|"insurance"|"vendor"|"signature"|"personal"|"other",
  "counterparty": "Lisa Nunes (Chicago Title)",
  "deal": null | {"tier": "direct"|"blast", "address": "...", "property_type": "sfr"|"multifamily"|"condo_townhome"|"land"|"commercial"|"other", "units": 6|null, "asking": 2150000|null, "off_market": true|false, "seller_motivated": true|false, "is_open_house_invite": true|false, "is_retail_listing": true|false, "notes": "..."},   // direct = a person emailing Ryan about a specific property they want him to buy; blast = mass marketing flyer/OM. off_market = not on MLS / pocket / pre-market; seller_motivated = probate, divorce, deferred maintenance, price reduced, must sell, tenant trouble, out-of-state owner etc.; is_retail_listing = an ordinary MLS-style marketing email with no angle
  "summary": "one line, ≤ 20 words, plain"
}`
}

export const FILING_SYSTEM = `You file real-estate documents into Ryan LaRocca's Google Drive exactly the way he does. You get his folder tree, his written filing convention, and structured rules learned from his corrections. Follow the convention and rules over your own taste. Output strict JSON.`

export function filingPrompt({ rulesMd, rules, tree, file, propertyFolder }) {
  const ruleLines = rules.map((r) => `- [${r.id.slice(0, 8)}] when ${r.sender_domain ? `sender ~ ${r.sender_domain}` : "any sender"} and doc_type=${r.doc_type || "any"} and property=${r.property_key || "any"} → folder "${r.folder_template}", name "${r.filename_template}" (${r.mode}, ${r.approvals_in_row} approvals in a row)`).join("\n") || "(none yet)"
  return `RYAN'S FILING CONVENTION (approved by him):
"""
${rulesMd || "(not written yet — use the folder tree and sensible defaults: Properties/<number street name>/<clear descriptive name>.ext)"}
"""

LEARNED RULES (from his corrections and approvals):
${ruleLines}

DRIVE TREE (paths are relative to the shared "Business Operations" root):
${tree}

THINGS RYAN HAS TOLD THE AGENT:
${file.knowledge || "(nothing yet)"}

DOCUMENT:
- original filename: ${file.filename}
- doc_type: ${file.doc_type}
- description: ${file.description || "-"}
- property: ${file.property_label || "unknown"} ${file.property_address ? `(${file.property_address})` : ""}
- existing Drive folder for this property: ${propertyFolder ? propertyFolder.path : "none — a new folder may be needed"}
- from: ${file.sender} · subject: ${file.subject} · received: ${file.received_at?.slice(0, 10)}
- signed: ${file.signed ?? "unknown"}

Return JSON only:
{"folder": "Properties/93 Ridgeview", "name": "Addendum A 93 Ridgeview.pdf", "rule_id": "<8-char id of the rule you applied, or null>", "confidence": 0.0-1.0, "reason": "≤ 15 words", "question": null | "ONE specific question for Ryan when the convention does not cover this (new property? which folder for this doc type? is X the same property as Y?)"}
If you would be guessing, set confidence below 0.6 and ask the question instead of inventing a folder.
Rules: keep the original extension; never put the root name in "folder"; when the property is unknown propose "Properties/_Unsorted"; when the convention says to reuse the original filename, keep it verbatim.`
}

export function changePrompt({ changeText, proposedFolder, proposedName, tree, filename }) {
  return `Ryan was shown this filing proposal and replied with a correction. Turn his reply into a concrete folder + filename.

PROPOSED: folder "${proposedFolder}", name "${proposedName}" (original attachment name: ${filename})
RYAN'S REPLY: """${changeText}"""

DRIVE TREE (relative to the "Business Operations" root):
${tree}

Return JSON only: {"folder": "Properties/Halleck", "name": "5764 Halleck Prelim.pdf", "generalize": "one sentence rule Ryan seems to be teaching, or null"}
Keep the original extension. If he only mentions the folder, keep the proposed name; if only the name, keep the proposed folder. "keep the name" means the ORIGINAL attachment name.`
}

// Ryan 2026-10-03: "keep it simple — look for keywords like TLC, contractor
// special, motivated seller … and let me be the judge." A hit on any of these
// in the subject/body/OM surfaces the deal even when it's a blast from an
// unknown sender. No profit math on houses.
export const OPPORTUNITY_RE = /\b(TLC|contractor'?s? special|handyman special|investor special|investor'?s? special|fixer(?:[- ]upper)?|needs? (?:work|updating|renovation|repairs?)|as[- ]is|motivated(?: seller)?|must sell|price (?:reduced|reduction|improvement)|reduced price|probate|estate sale|trust sale|divorce|pre[- ]?foreclosure|foreclosure|notice of default|\bNOD\b|short sale|bank[- ]owned|\bREO\b|bring your contractor|sweat equity|cash (?:only|buyers?)|deferred maintenance|original condition|tear ?down|lot value|value[- ]add|below market|off[- ]market|pocket listing|vacant|distressed|cosmetic)\b/gi
/** Distinct opportunity phrases found in a blob of text (lower-cased, deduped). */
export function opportunitySignals(text) {
  const out = new Set()
  for (const m of String(text || "").matchAll(OPPORTUNITY_RE)) out.add(m[1].toLowerCase().replace(/\s+/g, " "))
  return [...out]
}
// Ryan 2026-10-03 (after the LA condo card): a keyword hit only counts for a
// Bay Area house or building — "out of the area" and "condo/townhome, I don't
// buy those" are both hard filters.
export const BAY_AREA_RE = /\b(san jose|sunnyvale|milpitas|campbell|santa clara|cupertino|mountain view|los gatos|saratoga|morgan hill|gilroy|palo alto|los altos|willow glen|alum rock|fremont|hayward|oakland|san leandro|union city|newark|san mateo|redwood city|menlo park|burlingame|san bruno|south san francisco|daly city|pacifica|half moon bay|belmont|san carlos|foster city|santa cruz|hollister|san francisco|berkeley|alameda|emeryville|richmond|walnut creek|concord|pleasanton|livermore|dublin|san ramon|danville|castro valley|watsonville|scotts valley|capitola|aptos|east palo alto|millbrae|san francisco bay|bay area|silicon valley|santa clara county|san mateo county|alameda county|contra costa|santa cruz county)\b/i
export const CONDO_RE = /\b(condo(?:minium)?s?|townho(?:me|use)s?|town ?homes?|co-?op|\bHOA dues\b|unit #?\d+|apt\.? ?#?\d+|#\d{2,4}\b)/i
// Ryan 2026-10-03 (Lindy Ngo): "they are all on the market — she sends a lot
// of garbage." Keyword dressing on an MLS listing doesn't count; only genuinely
// off-market / distressed inventory pierces the filter.
export const ON_MARKET_RE = /\b(MLS ?#?\s*\d*|just listed|new listing|now listed|newly listed|listed at|list(?:ing)? price|open house|offers? due|offer deadline|coming soon|broker'?s? tour|tour (?:this )?(?:fri|sat|sun)[a-z]*|active listing|back on (?:the )?market|price (?:reduced|reduction|improvement)|reduced price|showings? (?:start|begin)|see it (?:this )?weekend)\b/i
export const OFF_MARKET_RE = /\b(off[- ]market|pocket listing|pre[- ]?market|not (?:yet )?(?:on|listed on) (?:the )?mls|unlisted|direct from (?:the )?(?:seller|owner)|exclusive(?:ly)? (?:to|for) (?:my )?investors?)\b/i
/** Should a mass blast from an unknown sender get a card? signals + Bay Area + not a condo/townhome + not an on-market retail listing. */
export function blastSignalsPass(text) {
  const t = String(text || "")
  const signals = opportunitySignals(t)
  const inArea = BAY_AREA_RE.test(t)
  const condo = CONDO_RE.test(t)
  const offMarket = OFF_MARKET_RE.test(t)
  const onMarket = ON_MARKET_RE.test(t) && !offMarket
  return { signals, inArea, condo, offMarket, onMarket, ok: signals.length > 0 && inArea && !condo && !onMarket }
}

export const SCREEN_SYSTEM = `You are Ryan LaRocca's deal screener. Ryan (LRG Homes) buys TWO kinds of property in Santa Clara County and the near Bay Area, both with hard money (Kiavi / Conventus bridge loans): (A) single-family houses to fix and flip — his current deals 5764 Halleck Dr and 2116 Quito Rd in San Jose are both SFR flips — and (B) small multifamily at a discount to nearby per-door comps with two exits on day one (refi or sell). "Single-family" is NEVER a reason to pass. Property type decides which screen you run.

SFR SCREEN (Ryan 2026-10-03: "keep it simple … let me be the judge"):
- No profit math. Look for opportunity signals in the listing, email and OM: TLC, contractor special, fixer, as-is, needs work, motivated seller, must sell, price reduced, probate / estate / trust sale, divorce, pre-foreclosure, bank-owned, cash only, deferred maintenance, original condition, teardown / lot value, vacant, off-market, pocket listing.
- Any signal → verdict "look_further", and list the signals verbatim in "reasons". A plain, move-in-ready retail listing with no signal → "pass" in one line.
- Still report asking, sqft, year built, condition and whatever the OM says about value or rents, so Ryan can judge quickly. Never invent an ARV.
- Ryan does NOT buy condos or townhomes and does not buy outside the Bay Area — set property_type "condo_townhome" when it is one, and say so in one line.

MULTIFAMILY SCREEN, in order:
1. Unit count + mix (2BR rents materially more than 1BR). The 4→5 unit line is a lending cliff: 4-plex = Fannie buyers (premium per door); 5+ = commercial money (~10–12× GRM). Never compare per-door across that line.
2. Price per door vs nearby sales. 2026 ladder: downtown San Jose ≈ $200k/door target; Milpitas 2/1 townhome 4-plex $300–325k; Sunnyvale 6-plex $358k in / $445k out (his Kirkland deal: bought $2.15M / 12.8× GRM, sold $2.667M in 5 months).
3. Income comp: published gross vs the subject's; rent upside → "look further", not "buy".
4. 1% rule (door price ≈ 100× monthly market rent) is the aspiration, only reachable near downtown SJ; going west the screen is discount-to-per-door-comps.
5. Rent-increase eligibility (AB 1482 cap 5%+CPI ≈ 8.8%): units not raised in 12 months are value.
6. Cushion to comp: breakeven after ~12 months carry + points + 6% sell costs vs strongest nearby comp. ≥10% = deal, ~5% = thin, ≤0 = never.

Most emailed multifamily deals are passes; say so in one line with the per-door number. Never present model estimates as facts Ryan verified. If the OM lacks a number, say "not stated". Output strict JSON.`

export function screenPrompt({ tier, msg, deal, attachmentsText, signals = [] }) {
  return `TIER: ${tier === "direct" ? "DIRECT LEAD — a person emailed Ryan personally about this property" : "BROKER BLAST — mass marketing"}
OPPORTUNITY SIGNALS FOUND IN THE EMAIL: ${signals.length ? signals.join(", ") : "none in the email text — check the OM"}
FROM: ${msg.from.name || ""} <${msg.from.email}>
SUBJECT: ${msg.subject}
EMAIL BODY:
"""
${msg.text.slice(0, 5000)}
"""
TRIAGE NOTES: ${JSON.stringify(deal)}
${attachmentsText ? `ATTACHMENT NOTES: ${attachmentsText}` : ""}
The attached document(s), if any, are the OM / flyer — read them for the facts.

Return JSON only:
{
  "address": "...",
  "property_type": "sfr" | "multifamily" | "condo_townhome" | "other",
  "facts": {"units": 6, "unit_mix": "4×2/1, 2×1/1", "asking": 2150000, "price_per_door": 358333, "gross_rent_mo": 13959, "grm": 12.8, "rent_per_door_mo": 2326, "year_built": 1962, "sqft": null, "lot_sqft": null, "condition": "...", "seller_motivation": "...", "occupancy": "...", "rent_increase_room": "...", "signals": ["contractor special", "as-is"], "other": "..."},
  "verdict": "pass" | "look_further" | "unknown",
  "one_liner": "≤ 25 words — multifamily: the verdict with the per-door number; SFR: the signals found + asking + condition",
  "reasons": ["≤ 4 short bullets"],
  "questions_for_seller": ["≤ 3, only if look_further"]
}`
}

export const RULES_SYSTEM = `You design and document the Google Drive filing convention for Ryan LaRocca, a real-estate investor (flips + small multifamily, Santa Clara County). Inputs: how his Drive is organized today, his answers to setup questions about real documents, and corrections he made while filing. Ryan has said the agent can probably organize this better than he does and that he is open to suggestions — so PROPOSE a clean structure, don't just transcribe his tree. Keep what he asked for explicitly (those answers are law); improve the rest and say what you changed and why in a short "Proposed changes" section at the top.
Design rules: one folder per property under Properties/, named "<number> <street>" (e.g. "5764 Halleck Dr"); active deals sit directly under Properties/, closed deals move into Properties/<year closed>/; inside each property folder a fixed set of subfolders — "Purchase & Sale" (RPA, addenda, counters, disclosures, escrow, title/prelim, net sheets, closing statements), "Loan & Insurance" (lender docs, evidence of insurance, policies), "Contractor Bids & Invoices", "Photos", "Tenants" (when applicable); a top-level Properties/Pitched Listings/<address>/ for OMs, flyers and deal packages that are not yet Ryan's; tax forms (1099-S, 1098, returns) go to Taxes/<year>/ not the property folder. File names: "<number street> — <document type> — <YYYY-MM-DD>.pdf" unless Ryan said to keep an original name (DocuSign-bracketed forms keep their bracketed names).
Output: Markdown, ≤ 1000 words. Sections in this order: Proposed changes (bullets), Folder structure (a tree), Naming convention (patterns + one example per document type from the setup questions), Special cases (DocuSign completions, Zix/escrow packets, pitched listings/OMs, flyers, bids/invoices, tax/insurance, contractor docs), What NOT to file, Migration notes (what existing folders to rename/move, e.g. "Halleck" → "5764 Halleck Dr", "93 Ridgeview" → "93 Ridgeview Ave"; the agent will do these only after Ryan approves). Where a document type was never covered, write "ASK" so the agent asks Ryan instead of guessing.`

export function rulesPrompt({ tree, qa, corrections, feedback, previous }) {
  const qaText = qa.map((x, i) => `${i + 1}. DOC: ${x.doc} · GUESS: ${x.guess} · RYAN: ${x.answer}`).join("\n") || "(none)"
  const corr = corrections.map((c) => `- ${c}`).join("\n") || "(none)"
  return `EXISTING DRIVE TREE (relative to the shared "Business Operations" root):
${tree}

INTERVIEW (one document at a time; "accepted my guess" means the guess IS his answer):
${qaText}

CORRECTIONS HE MADE WHILE FILING:
${corr}
${previous ? `\nPREVIOUS VERSION OF THE CONVENTION:\n"""\n${previous}\n"""\n\nRYAN'S FEEDBACK ON IT:\n"""\n${feedback}\n"""\nRewrite the whole document applying the feedback.` : ""}

Write the convention document now (markdown only, no preamble).`
}
