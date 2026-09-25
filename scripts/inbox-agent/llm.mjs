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
  "purchase_agreement", "addendum", "counter", "disclosure", "inspection", "title_report", "escrow_instructions",
  "net_sheet", "closing_statement", "evidence_of_insurance", "appraisal", "invoice", "bid", "offering_memorandum",
  "flyer", "loan_docs", "tax_doc", "lease", "photos", "other",
]

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
  "attachments": [ {"filename": "...", "relevant": true|false, "doc_type": "<one of: ${DOC_TYPES.join(", ")}>", "property_label": "..."|null, "signed": true|false|null, "description": "6-12 words"} ],
  "needs_reply": true|false,                   // does the sender need something from Ryan (an answer, a signature, a document, a decision, a signing time)?
  "ask": "one sentence: what they need from Ryan" | null,
  "due_on": "YYYY-MM-DD" | null,               // only if a date/deadline is stated or clearly implied (e.g. 'tomorrow', 'by Friday')
  "priority": "high"|"normal"|"low",           // high = money/closing/signature/deadline within ~3 days or a direct deal from a person
  "category": "escrow"|"lender"|"agent"|"contractor"|"tax"|"insurance"|"vendor"|"signature"|"personal"|"other",
  "counterparty": "Lisa Nunes (Chicago Title)",
  "deal": null | {"tier": "direct"|"blast", "address": "...", "property_type": "sfr"|"multifamily"|"land"|"commercial"|"other", "units": 6|null, "asking": 2150000|null, "off_market": true|false, "seller_motivated": true|false, "is_open_house_invite": true|false, "is_retail_listing": true|false, "notes": "..."},   // direct = a person emailing Ryan about a specific property they want him to buy; blast = mass marketing flyer/OM. off_market = not on MLS / pocket / pre-market; seller_motivated = probate, divorce, deferred maintenance, price reduced, must sell, tenant trouble, out-of-state owner etc.; is_retail_listing = an ordinary MLS-style marketing email with no angle
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

export const SCREEN_SYSTEM = `You are Ryan LaRocca's deal screener. Ryan buys small multifamily in Santa Clara County (San Jose, Sunnyvale, Milpitas, Campbell) at a discount to nearby per-door comps, using hard money, with two exits on day one (refi or sell). His screen, in order:
1. Unit count + mix (2BR rents materially more than 1BR). The 4→5 unit line is a lending cliff: 4-plex = Fannie buyers (premium per door); 5+ = commercial money (~10–12× GRM). Never compare per-door across that line.
2. Price per door vs nearby sales. 2026 ladder: downtown San Jose ≈ $200k/door target; Milpitas 2/1 townhome 4-plex $300–325k; Sunnyvale 6-plex $358k in / $445k out (his Kirkland deal: bought $2.15M / 12.8× GRM, sold $2.667M in 5 months).
3. Income comp: published gross vs the subject's; rent upside → "look further", not "buy".
4. 1% rule (door price ≈ 100× monthly market rent) is the aspiration, only reachable near downtown SJ; going west the screen is discount-to-per-door-comps.
5. Rent-increase eligibility (AB 1482 cap 5%+CPI ≈ 8.8%): units not raised in 12 months are value.
6. Cushion to comp: breakeven after ~12 months carry + points + 6% sell costs vs strongest nearby comp. ≥10% = deal, ~5% = thin, ≤0 = never.
Retail-priced listings are a straight pass — do not over-analyze them. Most emailed deals are passes; say so in one line with the per-door number. Never present model estimates as facts Ryan verified. If the OM lacks a number, say "not stated". Output strict JSON.`

export function screenPrompt({ tier, msg, deal, attachmentsText }) {
  return `TIER: ${tier === "direct" ? "DIRECT LEAD — a person emailed Ryan personally about this property" : "BROKER BLAST — mass marketing"}
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
  "facts": {"units": 6, "unit_mix": "4×2/1, 2×1/1", "asking": 2150000, "price_per_door": 358333, "gross_rent_mo": 13959, "grm": 12.8, "rent_per_door_mo": 2326, "year_built": 1962, "lot_sqft": null, "condition": "...", "seller_motivation": "...", "occupancy": "...", "rent_increase_room": "...", "other": "..."},
  "verdict": "pass" | "look_further" | "unknown",
  "one_liner": "≤ 25 words, the verdict with the per-door number and the comp reasoning",
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
