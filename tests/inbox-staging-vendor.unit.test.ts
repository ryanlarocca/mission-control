// Inbox agent — StyleMe Home Staging via FreshBooks → Properties/<address>/Staging
// (briefs/BRIEF_INBOX_STAGING_VENDOR_FRESHBOOKS_2026-10-17.md). Pure pieces only:
// the vendor rule with a sender_re relay, FreshBooks link detection / kind /
// number on the two real URL shapes, doc types from the subjects, the
// deterministic names (incl. PAID), the Staging destination, the property read
// from the page text, the click allowlist, the Paid lookup, the "$0.00" comment
// closing the StyleMe loop — and the regressions: ITI untouched, a random
// sender's staging-looking invoice still ignored.
import { describe, expect, it } from "vitest"
import { DEFAULT_VENDORS, STAGING_DOC_TYPES, isPaidName, matchVendor, paidName, stagingDocType, stagingInvoiceRowFor, stagingNumberFrom, vendorDocType, vendorFilingDecision, vendorRules } from "../scripts/inbox-agent/vendors.mjs"
import { PROPERTY_SUBFOLDERS, destinationFor, filingDecision, refineDocType, vendorFilename, vendorPropertyFolder } from "../scripts/inbox-agent/filing.mjs"
import { WHITELIST, subfolderFor } from "../scripts/inbox-agent/llm.mjs"
import { FRESHBOOKS_SELECTORS, detectProvider, documentLinks, fbClickAllowed, fetchDocuments, freshbooksAddress, freshbooksAmount, freshbooksGate, freshbooksKind, freshbooksNumber, parseFreshbooksPage, providerKind, providerLabel, queuesForVendor, queuesOnSystemEmail } from "../scripts/inbox-agent/fetch/index.mjs"
import { completionCloses, completionEvent, loopEligible, loopKey, resolutionKind } from "../scripts/inbox-agent/loops.mjs"

const ITI = DEFAULT_VENDORS.rules[0]
const STYLEME = DEFAULT_VENDORS.rules[1]

// ---- the real link shapes (jwts shortened)
const PROPOSAL_URL = "https://my.freshbooks.com/#/link/estimate/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3OTIwMDAwMDB9.s1gn4tur3?companyName=Kowi&entityName=proposal&estimateNumber=SS01174&ownerEmail=stylemestaging%40gmail.com&type=primary"
const INVOICE_URL = "https://my.freshbooks.com/#/link/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3OTIwMDAwMDB9.0th3rs1g?companyName=Kowi&invoiceNumber=080223VA&ownerEmail=stylemestaging%40gmail.com&type=primary"
const UP_URL = "https://my.freshbooks.com/#/link/eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3OTAwMDAwMDB9.upupup?companyName=Kowi&invoiceNumber=080223UP&ownerEmail=stylemestaging%40gmail.com&type=primary"

// ---- the four emails named in the brief (+ the comment emails)
const proposal = { id: "1a1273d89af371d2", threadId: "t-ss01174", from: { email: "mail@fb02.freshbooks.com", name: "StyleMe Home Staging, LLC" }, subject: "StyleMe Home Staging, LLC sent you a proposal (SS01174)", internalDate: "2026-10-10T18:30:00.000Z", text: `Hi Ryan,\n\nStyleMe Home Staging, LLC has sent you a proposal.\n\nView Proposal: ${PROPOSAL_URL}\n\nThanks,\nKowi` }
const invoice = { id: "1a14ab5d4cc45c46", threadId: "t-080223va", from: { email: "mail@fb05.freshbooks.com", name: "StyleMe Home Staging, LLC" }, subject: "StyleMe Home Staging, LLC sent you an invoice (080223VA)", internalDate: "2026-10-17T16:05:00.000Z", text: `StyleMe Home Staging, LLC sent you an invoice for $3,253.75 due on Oct 17, 2026.\n\nView Invoice: ${INVOICE_URL}\n\nhttps://www.freshbooks.com/unsubscribe` }
const commentBalance = { id: "1a135f9e00ed5f51", threadId: "t-fb-1", from: { email: "mail@fb02.freshbooks.com", name: "Kowi Chandra (via FreshBooks)" }, subject: "Kowi Chandra commented on invoice 080223UP ($2,985.00)", internalDate: "2026-10-13T15:55:00.000Z", text: `Kowi Chandra: Hi Ryan, please pay the staging invoice when you get a chance.\nView invoice: ${UP_URL}` }
const commentPaid = { id: "1a13712751de3137", threadId: "t-fb-2", from: { email: "mail@fb02.freshbooks.com", name: "Kowi Chandra (via FreshBooks)" }, subject: "Kowi Chandra commented on invoice 080223UP ($0.00)", internalDate: "2026-10-13T21:58:00.000Z", text: `Kowi Chandra: Thank you for your payment!\nView invoice: ${UP_URL}` }
const paidVA = { ...commentPaid, id: "fb-paid-va", threadId: "t-fb-3", subject: "Kowi Chandra commented on invoice 080223VA ($0.00)", internalDate: "2026-10-20T17:00:00.000Z", text: `Kowi Chandra: Thank you for your payment!\nView invoice: ${INVOICE_URL}` }
// another vendor billing through FreshBooks — never StyleMe's rule
const otherVendor = { ...invoice, id: "x", from: { email: "mail@fb03.freshbooks.com", name: "Acme Plumbing" }, subject: "Acme Plumbing sent you an invoice (1001)" }
const juanInvoice = { id: "1a14686438fae4d0", from: { email: "Juan@LetterPrinting.net", name: "Juan Muniz" }, subject: "Invoice 243496 from ITI Direct Mail", internalDate: "2026-10-15T20:11:35.000Z", text: "Total :$10,385.57" }

// ---- what headless Chrome showed the operator (2026-10-17), with the vendor's own address above the client's
const PROPOSAL_PAGE = ["StyleMe Home Staging, LLC", "1 Vendor Way, San Jose, CA 95112", "stylemestaging@gmail.com", "Proposal SS01174", "Invoiced — Kowi Chandra created an invoice for this proposal.", "Prepared For", "Ryan LaRocca", "2116 Quito Rd, San Jose, CA 95130", "Description", "3BR/2BA = 2116 Quito Rd, San Jose, CA 95130 Staged area: living, dining, kitchen, primary", "Amount Due (USD) $3,253.75", "Print Download PDF View Comments Send View History", "Create an account to track this proposal", "Save this Proposal"].join("\n")
const INVOICE_PAGE = ["StyleMe Home Staging, LLC", "1 Vendor Way, San Jose, CA 95112", "Invoice 080223VA", "Outstanding $3,253.75 is due on Oct 17, 2026.", "Billed To Ryan LaRocca 2116 Quito Rd, San Jose, CA 95130", "Description 3BR/2BA = 2116 Quito Rd, San Jose, CA 95130 Staged area: …", "Subtotal $3,253.75", "Total $3,253.75", "Amount Due (USD) $3,253.75", "Print Download PDF View Comments Send View History"].join("\n")
const PAID_PAGE = ["StyleMe Home Staging, LLC", "Invoice 080223UP", "Paid", "Billed To Ryan LaRocca 5764 Halleck Dr, San Jose, CA 95123", "Total $2,985.00", "Amount Due (USD) $0.00", "Print Download PDF"].join("\n")

describe("matchVendor — a relay may use sender_re; ITI is untouched", () => {
  it("FreshBooks' rotating senders (fb02, fb05, …) with a StyleMe subject match the styleme rule", () => {
    expect(matchVendor(proposal, DEFAULT_VENDORS)?.id).toBe("styleme")
    expect(matchVendor(invoice, DEFAULT_VENDORS)?.id).toBe("styleme")
    expect(matchVendor({ from: { email: "MAIL@FB11.FRESHBOOKS.COM" }, subject: "StyleMe Home Staging, LLC sent you a proposal (SS01180)" }, DEFAULT_VENDORS)?.id).toBe("styleme")
    expect(matchVendor({ from: { email: "mail@fb.freshbooks.com" }, subject: "StyleMe Home Staging, LLC sent you an invoice (1)" }, DEFAULT_VENDORS)?.id).toBe("styleme")
  })
  it("the comment emails, another vendor's FreshBooks notice, a spoofed subject from a random sender → null", () => {
    expect(matchVendor(commentBalance, DEFAULT_VENDORS)).toBeNull()
    expect(matchVendor(commentPaid, DEFAULT_VENDORS)).toBeNull()
    expect(matchVendor(otherVendor, DEFAULT_VENDORS)).toBeNull()
    expect(matchVendor({ from: { email: "someone@example.com" }, subject: proposal.subject }, DEFAULT_VENDORS)).toBeNull()
    expect(matchVendor({ from: { email: "mail@fb02.freshbooks.com.evil.io" }, subject: proposal.subject }, DEFAULT_VENDORS)).toBeNull()
    expect(matchVendor({ from: { email: "stylemestaging@gmail.com" }, subject: "Quito staging" }, DEFAULT_VENDORS)).toBeNull() // Kowi's own address is not a sender on the rule
  })
  it("ITI behaves exactly as before: Juan / Alan direct, PandaDoc relay by exact sender + ITI subject, never a StyleMe PandaDoc", () => {
    expect(matchVendor(juanInvoice, DEFAULT_VENDORS)?.id).toBe("iti")
    expect(matchVendor({ from: { email: "alan@letterprinting.net" }, subject: "Quote" }, DEFAULT_VENDORS)?.id).toBe("iti")
    expect(matchVendor({ from: { email: "docs@email.pandadoc.net" }, subject: 'Signed copy of "RE-Proof3 for order #240069"' }, DEFAULT_VENDORS)?.id).toBe("iti")
    expect(matchVendor({ from: { email: "docs@email.pandadoc.net" }, subject: 'Signed copy of "StyleMe Staging Agreement"' }, DEFAULT_VENDORS)).toBeNull()
    expect(ITI).toEqual({ id: "iti", name: "ITI Direct Mail", senders: ["juan@letterprinting.net", "alan@letterprinting.net"], relays: [{ sender: "docs@email.pandadoc.net", subject_re: "iti Direct Mail|Proof.*order #" }], doc_types: ["invoice", "proof", "quote", "tax_form"], campaign_id: "5b71ff54-14f9-4c83-a14d-8d1eed6325f2", subfolder: "3 - MAIL HOUSE" })
    expect(ITI.destination).toBeUndefined()
  })
  it("the seed mirrors the migration; a broken sender_re or subject_re never throws", () => {
    expect(vendorRules({}).map((r: { id: string }) => r.id)).toEqual(["iti", "styleme"])
    expect(STYLEME).toMatchObject({ id: "styleme", name: "StyleMe Home Staging", name_short: "StyleMe", senders: [], relays: [{ sender_re: "@fb\\d*\\.freshbooks\\.com$", subject_re: "^StyleMe Home Staging" }], doc_types: ["staging_proposal", "staging_invoice"], destination: "property", subfolder: "Staging" })
    expect(new RegExp((STYLEME.relays[0] as { sender_re: string }).sender_re, "i").test("mail@fb05.freshbooks.com")).toBe(true)
    const broken = [{ id: "b", name: "B", senders: [], relays: [{ sender_re: "(", subject_re: "x" }, { sender: "r@r.com", subject_re: "(" }], doc_types: ["invoice"] }]
    expect(matchVendor({ from: { email: "r@r.com" }, subject: "x" }, broken)).toBeNull()
    expect(matchVendor({ from: { email: "a@b.com" }, subject: "x" }, broken)).toBeNull()
    // Settings rows written before this build (ITI only) still work — the StyleMe rule then comes only from the migration.
    expect(vendorRules({ rules: [ITI] }).map((r: { id: string }) => r.id)).toEqual(["iti"])
  })
})

describe("FreshBooks link detection", () => {
  it("my.freshbooks.com #/link/… is freshbooks; kind + number come from the hash route and its params", () => {
    expect(detectProvider(PROPOSAL_URL)).toBe("freshbooks")
    expect(detectProvider(INVOICE_URL)).toBe("freshbooks")
    expect(freshbooksKind(PROPOSAL_URL)).toBe("proposal")
    expect(freshbooksKind(INVOICE_URL)).toBe("invoice")
    expect(freshbooksNumber(PROPOSAL_URL)).toBe("SS01174")
    expect(freshbooksNumber(INVOICE_URL)).toBe("080223VA")
    expect(freshbooksNumber(UP_URL)).toBe("080223UP")
    // A bare #/link/<jwt> with no params is still an invoice link; estimate without params a proposal.
    expect(freshbooksKind("https://my.freshbooks.com/#/link/abcdefghijkl")).toBe("invoice")
    expect(freshbooksKind("https://my.freshbooks.com/#/link/estimate/abcdefghijkl")).toBe("proposal")
  })
  it("login, marketing, the app, other hosts, and a wrapped copy are null; existing providers unchanged", () => {
    for (const u of ["https://my.freshbooks.com/#/login", "https://my.freshbooks.com/", "https://www.freshbooks.com/unsubscribe", "https://www.freshbooks.com/", "https://my.freshbooks.com/#/dashboard", "https://evil.example.com/?u=https://my.freshbooks.com/%23/link/x", "https://my.freshbooks.com/link/abc"]) {
      expect(detectProvider(u), u).toBeNull()
      expect(freshbooksKind(u), u).toBeNull()
      expect(freshbooksNumber(u), u).toBeNull()
    }
    expect(detectProvider("https://na4.docusign.net/Signing/EmailStart.aspx?a=1&etti=2&r=3")).toBe("docusign")
    expect(detectProvider("https://f8.f8re.com/listings/01a136a0-d777-7338-9063-d76425919515/download-center?signature=x")).toBe("f8")
    expect(detectProvider("https://app.tapinspect.com/shares/0b3c6c1e-9a1f-4d2b-8e7a-5f0c1d2e3a4b")).toBe("tapinspect")
  })
  it("label, kind, system-email gate, and the vendor gate (a FreshBooks link queues only on a property-destination vendor email)", () => {
    expect(providerLabel("freshbooks")).toBe("FreshBooks")
    expect(providerKind("freshbooks")).toBe("document")
    expect(queuesOnSystemEmail("freshbooks")).toBe(true)
    expect(queuesForVendor("freshbooks", STYLEME)).toBe(true)
    expect(queuesForVendor("freshbooks", ITI)).toBe(false)
    expect(queuesForVendor("freshbooks", null)).toBe(false)
    expect(queuesForVendor("tapinspect", null)).toBe(true)
    expect(queuesForVendor("docusign", ITI)).toBe(true)
  })
  it("documentLinks finds exactly the client link on each email (the unsubscribe footer is noise)", () => {
    expect(documentLinks(proposal)).toEqual([{ url: PROPOSAL_URL, provider: "freshbooks" }])
    expect(documentLinks(invoice)).toEqual([{ url: INVOICE_URL, provider: "freshbooks" }])
    // The comment email's "View invoice" link is a FreshBooks link — the vendor match (null) is what keeps it off the queue.
    expect(documentLinks(commentPaid)).toEqual([{ url: UP_URL, provider: "freshbooks" }])
    expect(queuesForVendor("freshbooks", matchVendor(commentPaid, DEFAULT_VENDORS))).toBe(false)
  })
  it("fetchDocuments still refuses a non-document FreshBooks URL without a browser", async () => {
    const r = await fetchDocuments({ url: "https://my.freshbooks.com/#/login", provider: null, log: () => {} })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/no fetcher/)
  })
})

describe("doc types — subject / link / fetched kind; comments are not documents", () => {
  it("sent you a proposal → staging_proposal, sent you an invoice → staging_invoice, from the subject or the link", () => {
    expect(vendorDocType(STYLEME, {}, proposal)).toBe("staging_proposal")
    expect(vendorDocType(STYLEME, {}, invoice)).toBe("staging_invoice")
    expect(stagingDocType(STYLEME, { url: PROPOSAL_URL }, { subject: "" })).toBe("staging_proposal")
    expect(stagingDocType(STYLEME, { url: INVOICE_URL }, { subject: "" })).toBe("staging_invoice")
    expect(stagingDocType(STYLEME, { kind: "staging_invoice" }, { subject: "whatever" })).toBe("staging_invoice")
    expect(stagingDocType(STYLEME, {}, { subject: "StyleMe Home Staging, LLC sent you an estimate (SS01180)" })).toBe("staging_proposal")
  })
  it("the comment emails → null; a rule that lists only invoices never yields a proposal", () => {
    expect(vendorDocType(STYLEME, {}, commentBalance)).toBeNull()
    expect(vendorDocType(STYLEME, {}, commentPaid)).toBeNull()
    expect(vendorDocType(STYLEME, { url: UP_URL }, commentPaid)).toBe("staging_invoice") // the link itself IS an invoice link — the caller gates on matchVendor
    expect(stagingDocType({ ...STYLEME, doc_types: ["staging_invoice"] }, {}, proposal)).toBeNull()
    expect(Array.from(STAGING_DOC_TYPES).sort()).toEqual(["staging_invoice", "staging_proposal"])
  })
  it("vendorFilingDecision files a PDF of either type; a non-PDF is refused", () => {
    expect(vendorFilingDecision(STYLEME, { filename: "Proposal_SS01174.pdf", mime: "application/pdf", kind: "staging_proposal" }, proposal)).toEqual({ file: true, docType: "staging_proposal", why: "StyleMe Home Staging staging_proposal" })
    expect(vendorFilingDecision(STYLEME, { filename: "invoice.html", mime: "text/html", kind: "staging_invoice" }, invoice)).toEqual({ file: false, docType: "staging_invoice", why: "staging_invoice is not a PDF" })
    expect(vendorFilingDecision(STYLEME, { filename: "x.pdf", mime: "application/pdf" }, commentPaid).docType).toBeNull()
  })
  it("ITI's mapping is as before", () => {
    const inv = { filename: "243496_RyanLarocca_LRG-Homes--LLC_2026-10-15-13-11-35.pdf", cleanName: "243496_RyanLarocca_LRG-Homes--LLC_2026-10-15-13-11-35.pdf", mime: "application/pdf", doc_type: "invoice" }
    expect(vendorDocType(ITI, inv, juanInvoice)).toBe("invoice")
    expect(vendorDocType(ITI, { ...inv, doc_type: "other" }, juanInvoice)).toBe("invoice")
    expect(vendorDocType(ITI, { filename: "CDTFA-230.pdf", cleanName: "CDTFA-230.pdf", mime: "application/pdf", doc_type: "tax_form" }, juanInvoice)).toBe("tax_form")
    // A fetched staging document never becomes an ITI type, and ITI never yields a staging type.
    expect(vendorDocType(ITI, { filename: "Proposal_SS01174.pdf", kind: "staging_proposal" }, { ...juanInvoice, subject: "RE: NOO Absentee Q4" })).toBeNull()
    expect(STAGING_DOC_TYPES.has(vendorDocType(ITI, { filename: "Proposal_SS01174.pdf", kind: "staging_proposal" }, juanInvoice) || "")).toBe(false)
  })
})

describe("names — deterministic, PT-dated, StyleMe prefix from name_short", () => {
  it("proposal: StyleMe proposal SS01174 - 2026-10-10.pdf", () => {
    expect(vendorFilename({ rule: STYLEME, docType: "staging_proposal", filename: "Proposal_SS01174.pdf", subject: proposal.subject, receivedAt: proposal.internalDate }).name).toBe("StyleMe proposal SS01174 - 2026-10-10.pdf")
    // Number from the link when the subject has none; no number at all → no gap.
    expect(vendorFilename({ rule: STYLEME, docType: "staging_proposal", filename: "p.pdf", subject: "Your proposal", receivedAt: proposal.internalDate, url: PROPOSAL_URL }).name).toBe("StyleMe proposal SS01174 - 2026-10-10.pdf")
    expect(vendorFilename({ rule: STYLEME, docType: "staging_proposal", filename: "p.pdf", subject: "Your proposal", receivedAt: proposal.internalDate }).name).toBe("StyleMe proposal - 2026-10-10.pdf")
  })
  it("invoice: StyleMe invoice 080223VA - 2026-10-17 - $3,253.75.pdf — amount from the body, else the page text; PAID before the extension", () => {
    const fromBody = vendorFilename({ rule: STYLEME, docType: "staging_invoice", filename: "Invoice_080223VA.pdf", subject: invoice.subject, receivedAt: invoice.internalDate, bodyText: invoice.text })
    expect(fromBody.name).toBe("StyleMe invoice 080223VA - 2026-10-17 - $3,253.75.pdf")
    expect(fromBody.invoice_no).toBe("080223VA")
    expect(fromBody.amounts?.total).toBe(3253.75)
    const fromPage = vendorFilename({ rule: STYLEME, docType: "staging_invoice", filename: "Invoice_080223VA.pdf", subject: invoice.subject, receivedAt: invoice.internalDate, bodyText: "View your invoice online.", pageText: INVOICE_PAGE })
    expect(fromPage.name).toBe("StyleMe invoice 080223VA - 2026-10-17 - $3,253.75.pdf")
    expect(vendorFilename({ rule: STYLEME, docType: "staging_invoice", filename: "i.pdf", subject: invoice.subject, receivedAt: invoice.internalDate, bodyText: "" }).name).toBe("StyleMe invoice 080223VA - 2026-10-17.pdf")
    expect(vendorFilename({ rule: STYLEME, docType: "staging_invoice", filename: "i.pdf", subject: invoice.subject, receivedAt: invoice.internalDate, bodyText: invoice.text, paid: true }).name).toBe("StyleMe invoice 080223VA - 2026-10-17 - $3,253.75 PAID.pdf")
    expect(paidName("StyleMe invoice 080223UP - 2026-10-04 - $2,985.00.pdf")).toBe("StyleMe invoice 080223UP - 2026-10-04 - $2,985.00 PAID.pdf")
    // A paid page reads Amount Due $0.00 — the Total is the amount.
    expect(vendorFilename({ rule: STYLEME, docType: "staging_invoice", filename: "i.pdf", subject: "StyleMe Home Staging, LLC sent you an invoice (080223UP)", receivedAt: "2026-10-04T17:00:00.000Z", bodyText: "", pageText: PAID_PAGE, paid: true }).name).toBe("StyleMe invoice 080223UP - 2026-10-04 - $2,985.00 PAID.pdf")
  })
  it("date is the received date in PT; the prefix is the rule's name_short (ITI keeps its id)", () => {
    expect(vendorFilename({ rule: STYLEME, docType: "staging_proposal", filename: "p.pdf", subject: proposal.subject, receivedAt: "2026-10-11T03:30:00.000Z" }).name).toBe("StyleMe proposal SS01174 - 2026-10-10.pdf")
    expect(vendorFilename({ rule: { ...STYLEME, name_short: undefined }, docType: "staging_proposal", filename: "p.pdf", subject: proposal.subject, receivedAt: proposal.internalDate }).name).toBe("StyleMe Home Staging proposal SS01174 - 2026-10-10.pdf")
    expect(vendorFilename({ rule: ITI, docType: "invoice", filename: "243496_x.pdf", subject: "", receivedAt: "2026-10-16T03:30:00.000Z", bodyText: "" }).name).toBe("ITI invoice 243496 - 2026-10-15.pdf")
  })
  it("stagingNumberFrom: subject parentheses, then the link, then 'invoice N' in a subject", () => {
    expect(stagingNumberFrom(proposal.subject)).toBe("SS01174")
    expect(stagingNumberFrom(invoice.subject, PROPOSAL_URL)).toBe("080223VA") // the subject wins
    expect(stagingNumberFrom("Your proposal", PROPOSAL_URL)).toBe("SS01174")
    expect(stagingNumberFrom(commentPaid.subject)).toBe("080223UP") // "($0.00)" is not a number
    expect(stagingNumberFrom("Hello", null)).toBeNull()
  })
})

describe("destination — Staging is a standard property subfolder; the whitelist is NOT widened", () => {
  it("both staging types → Properties/<address>/Staging; Staging sits between Construction and Photos", () => {
    expect(vendorPropertyFolder({ rule: STYLEME, docType: "staging_proposal", property: "2116 Quito Rd" })).toBe("Properties/2116 Quito Rd/Staging")
    expect(vendorPropertyFolder({ rule: STYLEME, docType: "staging_invoice", property: "5764 Halleck Dr" })).toBe("Properties/5764 Halleck Dr/Staging")
    expect(vendorPropertyFolder({ rule: { subfolder: null }, docType: "staging_invoice", property: "2116 Quito Rd" })).toBe("Properties/2116 Quito Rd/Staging") // subfolderFor fallback
    expect(vendorPropertyFolder({ rule: STYLEME, docType: "staging_invoice", property: null })).toBeNull()
    expect(subfolderFor("staging_proposal", null)).toBe("Staging")
    expect(subfolderFor("staging_invoice", null)).toBe("Staging")
    expect(PROPERTY_SUBFOLDERS).toEqual(["Purchase & Sale", "Disclosures", "Inspections", "Title & Escrow", "Loan & Insurance", "Construction", "Staging", "Photos"])
  })
  it("regression: a staging_invoice-looking PDF from a random sender is still ignored; the types reach filing only through the vendor rule", () => {
    const t = refineDocType("StyleMe invoice 080223VA.pdf", "invoice", "someone@example.com", "StyleMe Home Staging, LLC sent you an invoice (080223VA)")
    expect(t).toBe("invoice")
    expect(filingDecision(t, null).file).toBe(false)
    expect(filingDecision("staging_invoice", null)).toEqual({ file: false, why: "staging_invoice is not a transaction document" })
    expect(filingDecision("staging_proposal", null).file).toBe(false)
    expect(destinationFor({ property: "2116 Quito Rd", docType: "staging_invoice", filename: "i.pdf", subject: invoice.subject, receivedAt: invoice.internalDate, stage: null, seq: 1 })).toBeNull()
    expect(WHITELIST.has("staging_invoice")).toBe(false)
    expect(WHITELIST.has("staging_proposal")).toBe(false)
    // …and the vendor path refuses it for a non-matching email (no rule → nothing).
    expect(matchVendor({ ...invoice, from: { email: "someone@example.com" } }, DEFAULT_VENDORS)).toBeNull()
    // The ITI rule reads a "… invoice …" PDF on Juan's email as ITI's own invoice (unchanged behaviour) — never as a staging type.
    expect(STAGING_DOC_TYPES.has(vendorDocType(ITI, { filename: "StyleMe invoice 080223VA.pdf", mime: "application/pdf", kind: "staging_invoice" }, juanInvoice) || "")).toBe(false)
  })
})

describe("property + amount from the rendered FreshBooks page", () => {
  it("Prepared For … 2116 Quito Rd (proposal) and Billed To … (invoice) beat the vendor's own San Jose address above them", () => {
    expect(freshbooksAddress(PROPOSAL_PAGE)).toBe("2116 Quito Rd")
    expect(freshbooksAddress(INVOICE_PAGE)).toBe("2116 Quito Rd")
    expect(freshbooksAddress(PAID_PAGE)).toBe("5764 Halleck Dr")
    expect(freshbooksAddress("Prepared For\nRyan LaRocca\n2116 Quito Rd, San Jose, CA 95130")).toBe("2116 Quito Rd")
    expect(freshbooksAddress("Description 3BR/2BA = 2116 Quito Rd, San Jose, CA 95130 Staged area")).toBe("2116 Quito Rd") // no lead-in: anywhere in the text
    expect(freshbooksAddress("Proposal SS01174\nPrepared For Ryan LaRocca")).toBeNull()
    expect(freshbooksAddress("")).toBeNull()
  })
  it("parseFreshbooksPage: kind, number, address, amount, status", () => {
    expect(parseFreshbooksPage(PROPOSAL_PAGE, PROPOSAL_URL)).toEqual({ kind: "proposal", number: "SS01174", address: "2116 Quito Rd", amount: 3253.75, status: "outstanding" })
    expect(parseFreshbooksPage(INVOICE_PAGE, INVOICE_URL)).toEqual({ kind: "invoice", number: "080223VA", address: "2116 Quito Rd", amount: 3253.75, status: "outstanding" })
    expect(parseFreshbooksPage(PAID_PAGE)).toEqual({ kind: "invoice", number: "080223UP", address: "5764 Halleck Dr", amount: 2985, status: "paid" })
    expect(parseFreshbooksPage("", null)).toEqual({ kind: null, number: null, address: null, amount: null, status: null })
  })
  it("freshbooksAmount: 'for $X' in the email first, then Amount Due / Total on the page; $0.00 only when nothing else", () => {
    expect(freshbooksAmount(invoice.text)).toBe(3253.75)
    expect(freshbooksAmount("", INVOICE_PAGE)).toBe(3253.75)
    expect(freshbooksAmount("Amount Due (USD) $0.00\nTotal $2,985.00")).toBe(2985)
    expect(freshbooksAmount("Amount Due (USD) $0.00")).toBe(0)
    expect(freshbooksAmount("Outstanding $1,200.50 is due on Oct 17, 2026.")).toBe(1200.5)
    expect(freshbooksAmount("nothing here", null, undefined)).toBeNull()
  })
  it("the gate: a login wall → login, a dead link → expired, a page that simply never rendered → null", () => {
    expect(freshbooksGate("Log in to FreshBooks to view this invoice")).toBe("login")
    expect(freshbooksGate("Enter your password")).toBe("login")
    expect(freshbooksGate("This link has expired.")).toBe("expired")
    expect(freshbooksGate("Page not found")).toBe("expired")
    expect(freshbooksGate(PROPOSAL_PAGE)).toBeNull()
    expect(freshbooksGate("")).toBeNull()
  })
})

describe("the click allowlist — Download PDF and nothing else", () => {
  it("allows Download PDF (and close/ok); refuses pay, accept, save, create account, send, comments, print, sign, submit", () => {
    for (const l of ["Download PDF", "download pdf", "DOWNLOAD PDF", "Close", "OK", "Got it"]) expect(fbClickAllowed(l).ok, l).toBe(true)
    for (const l of ["Pay", "Pay Now", "Make Payment", "Accept", "Accept Proposal", "Save this Proposal", "Create an account", "Create an account…", "Send", "View Comments", "View History", "Print", "Sign", "Agree and sign", "Submit", "Log in", "Sign in", "Decline"]) expect(fbClickAllowed(l).ok, l).toBe(false)
    expect(fbClickAllowed(["download-pdf-button", "Download PDF"]).ok).toBe(true)
    expect(fbClickAllowed(["Download PDF", "pay-button"]).ok).toBe(false) // a forbidden candidate wins
    expect(fbClickAllowed([]).ok).toBe(false)
    expect(FRESHBOOKS_SELECTORS.downloadPdf.test("Download PDF")).toBe(true)
    expect(FRESHBOOKS_SELECTORS.heading.test("Proposal SS01174")).toBe(true)
    expect(FRESHBOOKS_SELECTORS.heading.test("Invoice 080223VA")).toBe(true)
  })
})

describe("Part D — paid", () => {
  const filedUP = { id: "f-up", status: "filed", doc_type: "staging_invoice", final_name: "StyleMe invoice 080223UP - 2026-10-04 - $2,985.00.pdf", meta: { vendor: "styleme", invoice_no: "080223UP", total: 2985 }, fetch_id: "job-up" }
  const filedVA = { id: "f-va", status: "filed", doc_type: "staging_invoice", final_name: "StyleMe invoice 080223VA - 2026-10-17 - $3,253.75.pdf", meta: { vendor: "styleme", invoice_no: "080223VA", total: 3253.75 }, fetch_id: "job-va" }
  const proposalRow = { id: "f-p", status: "filed", doc_type: "staging_proposal", final_name: "StyleMe proposal SS01174 - 2026-10-10.pdf", meta: { vendor: "styleme", number: "SS01174" } }
  it("stagingInvoiceRowFor finds the filed invoice by meta.invoice_no, else by name; never a proposal, an unfiled row, or another number", () => {
    expect(stagingInvoiceRowFor([proposalRow, filedVA, filedUP], "080223UP")?.id).toBe("f-up")
    expect(stagingInvoiceRowFor([proposalRow, filedVA, filedUP], "080223va")?.id).toBe("f-va")
    expect(stagingInvoiceRowFor([{ ...filedUP, meta: null }], "080223UP")?.id).toBe("f-up") // by name
    expect(stagingInvoiceRowFor([{ ...filedUP, status: "pending" }], "080223UP")).toBeNull()
    expect(stagingInvoiceRowFor([filedUP], "080224UP")).toBeNull()
    expect(stagingInvoiceRowFor([filedUP], null)).toBeNull()
    expect(stagingInvoiceRowFor(null, "080223UP")).toBeNull()
  })
  it("isPaidName / paidName round-trip", () => {
    expect(isPaidName(filedUP.final_name)).toBe(false)
    expect(isPaidName(paidName(filedUP.final_name))).toBe(true)
    expect(isPaidName("x PAID")).toBe(true)
    expect(isPaidName("PAID.pdf")).toBe(false)
    expect(paidName(paidName("a.pdf"))).toBe("a PAID PAID.pdf") // callers check isPaidName first
  })
  it("the $0.00 comment is a completion for its invoice number; the proposal / invoice emails are not; comments never open loops", () => {
    expect(completionEvent(paidVA)).toEqual({ kind: "paid", vendor: "freshbooks", property: null, invoice: "080223VA", shareId: null })
    expect(completionEvent(commentPaid)?.invoice).toBe("080223UP")
    expect(completionEvent(commentBalance)).toBeNull()
    expect(completionEvent(proposal)).toBeNull()
    expect(completionEvent(invoice)).toBeNull()
    expect(loopEligible("automated", paidVA, null)).toBe(false)
    expect(loopEligible("human", invoice, null)).toBe(true)
    expect(resolutionKind(invoice, { ask: "Pay StyleMe invoice 080223VA" })).toBe("portal")
  })
  it("the StyleMe 'Pay invoice 080223VA' loop closes on the 080223VA $0.00 comment, not on 080223UP's", () => {
    const cls = { ask: "Pay StyleMe staging invoice 080223VA ($3,253.75) for 2116 Quito Rd", property: { label: "2116 Quito Rd" } }
    const loop = { id: "loop-va", thread_id: invoice.threadId, gmail_id: invoice.id, subject: invoice.subject, ask: cls.ask, counterparty_email: invoice.from.email, loop_key: loopKey(invoice, cls), status: "open", message_at: invoice.internalDate }
    expect(loop.loop_key).toBe("fb05.freshbooks.com|2116quito|payment")
    expect(completionCloses(completionEvent(paidVA), loop)).toBe(true)
    expect(completionCloses(completionEvent(commentPaid), loop)).toBe(false)
    // The Halleck invoice's loop (080223UP) closes on ITS receipt only.
    const upCls = { ask: "Pay StyleMe staging invoice 080223UP ($2,985.00)", property: { label: "5764 Halleck Dr" } }
    const upLoop = { ...loop, id: "loop-up", gmail_id: commentBalance.id, thread_id: commentBalance.threadId, subject: commentBalance.subject, ask: upCls.ask, loop_key: loopKey(commentBalance, upCls) }
    expect(completionCloses(completionEvent(commentPaid), upLoop)).toBe(true)
    expect(completionCloses(completionEvent(paidVA), upLoop)).toBe(false)
  })
})
