// Inbox agent — ITI vendor filing + the South Bay Termite guard
// (briefs/BRIEF_INBOX_VENDOR_FILING_TAPINSPECT_2026-10-16.md, Parts A and C).
// Pure pieces only: vendor matching, the ITI body parser, deterministic names,
// supersede / paid renames, the invoice diff lines, campaign resolution, and
// refineDocType + filingDecision on the fixtures the brief names.
import { describe, expect, it } from "vitest"
import { DEFAULT_VENDORS, invoiceDiffLines, invoiceNumberFrom, isSignedProofRelay, markedName, matchVendor, money, paidName, parseItiAmounts, parentCampaignOf, pickCampaign, proofTitleFrom, supersedeRenames, vendorDocType, vendorFilingDecision, vendorRules } from "../scripts/inbox-agent/vendors.mjs"
import { PROOF_FILE_RE, TAX_FORM_FILE_RE, TERMITE_SUBJECT_RE, destinationFor, filingDecision, refineDocType, vendorFilename } from "../scripts/inbox-agent/filing.mjs"
import { DOC_TYPES, WHITELIST } from "../scripts/inbox-agent/llm.mjs"
import { ptDate, sanitizeFilename } from "../scripts/inbox-agent/env.mjs"

const ITI = DEFAULT_VENDORS.rules[0]
const CAMPAIGN_ID = "5b71ff54-14f9-4c83-a14d-8d1eed6325f2"

// ---- fixtures modelled on the real emails named in the brief
const juanInvoice = {
  id: "1a14686438fae4d0",
  from: { email: "Juan@LetterPrinting.net", name: "Juan Muniz" },
  subject: "Invoice 243496 from ITI Direct Mail",
  internalDate: "2026-10-15T20:11:35.000Z",
  text: ["Hi Ryan,", "Attached is the revised invoice for the October drop.", "", "Subtotal :$10,135.57", "Shipping Charges :$0.00", "Discount :$0.00", "Tax :$250.00", "Total :$10,385.57", "", "Thanks,", "Juan"].join("\n"),
  attachments: [{ filename: "243496_RyanLarocca_LRG-Homes--LLC_2026-10-15-13-11-35.pdf", mime: "application/pdf", size: 120_000 }],
}
const pandaSigned = {
  id: "19de0808960889dc",
  from: { email: "docs@email.pandadoc.net", name: "Juan Muniz via PandaDoc" },
  subject: 'Signed copy of "RE-Proof3 for order #240069"',
  internalDate: "2026-04-30T18:02:00.000Z",
  text: "Juan Muniz (ITI Direct Mail) has sent you a signed copy of RE-Proof3 for order #240069.",
  attachments: [{ filename: "RE-Proof3 for order #240069.pdf", mime: "application/pdf", size: 900_000 }],
}
const pandaUnsigned = { ...pandaSigned, subject: "Juan Muniz sent you Proof3 for order #240069 via PandaDoc", attachments: [] }
const kiaviInvoice = { from: { email: "draws@kiavi.com", name: "Kiavi Draws" }, subject: "Invoice for inspection fee — 5764 Halleck Dr", text: "Total :$350.00", attachments: [{ filename: "invoice_88213.pdf", mime: "application/pdf", size: 50_000 }] }

describe("matchVendor — surgical: ITI only", () => {
  it("matches Juan and Alan directly (case-insensitive), PandaDoc only with an ITI subject", () => {
    expect(matchVendor(juanInvoice, DEFAULT_VENDORS)?.id).toBe("iti")
    expect(matchVendor({ from: { email: "alan@letterprinting.net" }, subject: "Quote for NOO October" }, DEFAULT_VENDORS)?.id).toBe("iti")
    expect(matchVendor(pandaSigned, DEFAULT_VENDORS)?.id).toBe("iti")
    expect(matchVendor({ from: { email: "docs@email.pandadoc.net" }, subject: "Juan Muniz (iti Direct Mail) sent you a document" }, DEFAULT_VENDORS)?.id).toBe("iti")
    expect(matchVendor(pandaUnsigned, DEFAULT_VENDORS)?.id).toBe("iti") // matches the vendor; filing is refused later as an unsigned proof
  })
  it("never matches another vendor's PandaDoc relay, Kiavi, or a random sender", () => {
    expect(matchVendor({ from: { email: "docs@email.pandadoc.net" }, subject: 'Signed copy of "StyleMe Staging Agreement"' }, DEFAULT_VENDORS)).toBeNull()
    expect(matchVendor(kiaviInvoice, DEFAULT_VENDORS)).toBeNull()
    expect(matchVendor({ from: { email: "someone@example.com" }, subject: "Invoice 243496 from ITI Direct Mail" }, DEFAULT_VENDORS)).toBeNull()
    expect(matchVendor({ from: { email: "" }, subject: "x" }, DEFAULT_VENDORS)).toBeNull()
  })
  it("reads rules from inbox_settings.vendors and falls back to the seed; a broken subject_re never throws", () => {
    expect(vendorRules({})).toBe(DEFAULT_VENDORS.rules)
    expect(vendorRules({ rules: [] })).toBe(DEFAULT_VENDORS.rules)
    const custom = { rules: [{ id: "x", name: "X", senders: ["x@x.com"], relays: [{ sender: "r@r.com", subject_re: "(" }], doc_types: ["invoice"] }] }
    expect(vendorRules(custom)[0].id).toBe("x")
    expect(matchVendor({ from: { email: "r@r.com" }, subject: "anything" }, custom)).toBeNull()
    expect(matchVendor({ from: { email: "X@X.com" }, subject: "anything" }, custom)?.id).toBe("x")
  })
})

describe("regression — the whitelist is unchanged for every non-vendor sender", () => {
  it("an invoice from draws@kiavi.com or a random sender is still ignored", () => {
    const t = refineDocType("invoice_88213.pdf", "invoice", kiaviInvoice.from.email, kiaviInvoice.subject)
    expect(t).toBe("invoice")
    expect(filingDecision(t, null).file).toBe(false)
    expect(filingDecision("invoice", null).why).toMatch(/not a transaction document/)
    expect(filingDecision(refineDocType("Invoice 1001.pdf", "invoice", "billing@someone.com", "Your invoice"), null).file).toBe(false)
    // The vendor doc types are not whitelisted either — only the vendor path files them.
    for (const t of ["proof", "tax_form", "quote", "invoice"]) expect(WHITELIST.has(t), t).toBe(false)
    expect(DOC_TYPES).toContain("proof")
    expect(DOC_TYPES).toContain("tax_form")
  })
  it("refineDocType: proof / tax form by filename, but never 'proof of funds' or an address starting with 1541", () => {
    expect(refineDocType("RE-Proof3 for order #240069.pdf", "other", "juan@letterprinting.net", "")).toBe("proof")
    expect(refineDocType("proof.pdf", "invoice", "juan@letterprinting.net", "")).toBe("proof")
    expect(refineDocType("Proof of Funds - Chase.pdf", "other", "agent@x.com", "")).toBe("other")
    expect(refineDocType("Proof of Insurance.pdf", "evidence_of_insurance", "agent@x.com", "")).toBe("evidence_of_insurance")
    expect(refineDocType("CDTFA-230 Exemption Certificate.pdf", "other", "juan@letterprinting.net", "")).toBe("tax_form")
    expect(refineDocType("Reg 1541.5 resale exempt - signed.pdf", "other", "juan@letterprinting.net", "")).toBe("tax_form")
    expect(refineDocType("1541 Foo Ave Addendum.pdf", "addendum", "agent@x.com", "")).toBe("addendum")
    expect(PROOF_FILE_RE.test("proof")).toBe(true)
    expect(TAX_FORM_FILE_RE.test("1541 Foo Ave")).toBe(false)
  })
})

describe("ITI invoice body + number", () => {
  it("parses Subtotal / Shipping / Discount / Tax / Total from the body", () => {
    expect(parseItiAmounts(juanInvoice.text)).toEqual({ subtotal: 10135.57, shipping: 0, discount: 0, tax: 250, total: 10385.57 })
    expect(parseItiAmounts("Subtotal: $9,885.57\nDiscount: -$500.00\nTax: $247.14\nTotal: $9,632.71")).toEqual({ subtotal: 9885.57, shipping: null, discount: -500, tax: 247.14, total: 9632.71 })
    expect(parseItiAmounts("Discount ($500.00)\nTotal $1,000").discount).toBe(-500)
    expect(parseItiAmounts("Thanks for your order — we will send the total later.")).toEqual({ subtotal: null, shipping: null, discount: null, tax: null, total: null })
    expect(parseItiAmounts("").total).toBeNull()
  })
  it("takes the invoice number from the leading digits of the filename, else the subject", () => {
    expect(invoiceNumberFrom("243496_RyanLarocca_LRG-Homes--LLC_2026-10-15-13-11-35.pdf")).toBe("243496")
    expect(invoiceNumberFrom("243481_RyanLarocca.pdf", "Invoice 243496")).toBe("243481")
    expect(invoiceNumberFrom("invoice.pdf", "Invoice #243496 from ITI Direct Mail")).toBe("243496")
    expect(invoiceNumberFrom("invoice.pdf", "Your order")).toBeNull()
  })
  it("money formats with two decimals and thousands separators", () => {
    expect(money(10385.57)).toBe("$10,385.57")
    expect(money(0)).toBe("$0.00")
    expect(money(-500)).toBe("-$500.00")
    expect(money(null)).toBeNull()
  })
})

describe("vendor doc types + decisions", () => {
  it("only the PandaDoc signed copy of a proof files; unsigned proofs are ignored as 'unsigned proof'", () => {
    expect(isSignedProofRelay(pandaSigned)).toBe(true)
    expect(isSignedProofRelay(pandaUnsigned)).toBe(false)
    expect(isSignedProofRelay({ from: { email: "juan@letterprinting.net" }, subject: 'Signed copy of "Proof"' })).toBe(false)
    expect(proofTitleFrom(pandaSigned.subject)).toBe("RE-Proof3 for order #240069")
    expect(proofTitleFrom("Signed copy of “Curly Proof”")).toBe("Curly Proof")
    const att = { filename: "RE-Proof3 for order #240069.pdf", cleanName: "RE-Proof3 for order #240069.pdf", mime: "application/pdf", doc_type: "proof" }
    expect(vendorFilingDecision(ITI, att, pandaSigned)).toEqual({ file: true, docType: "proof", why: "ITI Direct Mail proof" })
    expect(vendorFilingDecision(ITI, { ...att, filename: "Proof3.pdf", cleanName: "Proof3.pdf" }, { ...juanInvoice, subject: "Proof for your approval" })).toEqual({ file: false, docType: "proof", why: "unsigned proof" })
    expect(vendorFilingDecision(ITI, { ...att, doc_type: "other" }, pandaUnsigned).why).toBe("unsigned proof")
  })
  it("maps the classifier's types onto the vendor's, and leaves non-vendor documents to the normal pipeline", () => {
    const inv = { filename: juanInvoice.attachments[0].filename, cleanName: juanInvoice.attachments[0].filename, mime: "application/pdf", doc_type: "invoice" }
    expect(vendorDocType(ITI, inv, juanInvoice)).toBe("invoice")
    expect(vendorDocType(ITI, { ...inv, doc_type: "other" }, juanInvoice)).toBe("invoice") // subject says Invoice
    expect(vendorDocType(ITI, { filename: "Quote 10-2026.pdf", cleanName: "Quote 10-2026.pdf", mime: "application/pdf", doc_type: "bid" }, { ...juanInvoice, subject: "Quote" })).toBe("quote")
    expect(vendorDocType(ITI, { filename: "estimate.pdf", cleanName: "estimate.pdf", mime: "application/pdf", doc_type: "other" }, { ...juanInvoice, subject: "Pricing" })).toBe("quote")
    expect(vendorDocType(ITI, { filename: "CDTFA-230.pdf", cleanName: "CDTFA-230.pdf", mime: "application/pdf", doc_type: "tax_form" }, juanInvoice)).toBe("tax_form")
    expect(vendorDocType(ITI, { filename: "NOO list final.csv", cleanName: "NOO list final.csv", mime: "text/csv", doc_type: "marketing_list" }, juanInvoice)).toBeNull()
    expect(vendorFilingDecision(ITI, { filename: "NOO list final.csv", cleanName: "NOO list final.csv", mime: "text/csv", doc_type: "marketing_list" }, juanInvoice).docType).toBeNull()
    expect(vendorFilingDecision(ITI, { filename: "invoice.xlsx", cleanName: "invoice.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", doc_type: "invoice" }, juanInvoice)).toEqual({ file: false, docType: "invoice", why: "invoice is not a PDF" })
  })
})

describe("vendor file names (deterministic, PT-dated)", () => {
  it("invoice: ITI invoice <number> - <date> - $<total>.pdf, and without the total when the body has none", () => {
    const named = vendorFilename({ rule: ITI, docType: "invoice", filename: juanInvoice.attachments[0].filename, subject: juanInvoice.subject, receivedAt: juanInvoice.internalDate, bodyText: juanInvoice.text })
    expect(named.name).toBe("ITI invoice 243496 - 2026-10-15 - $10,385.57.pdf")
    expect(named.invoice_no).toBe("243496")
    expect(named.amounts).toEqual({ subtotal: 10135.57, shipping: 0, discount: 0, tax: 250, total: 10385.57 })
    const noTotal = vendorFilename({ rule: ITI, docType: "invoice", filename: "243481_RyanLarocca_LRG-Homes--LLC_2026-10-14.pdf", subject: "Invoice", receivedAt: "2026-10-14T19:00:00.000Z", bodyText: "Please see attached." })
    expect(noTotal.name).toBe("ITI invoice 243481 - 2026-10-14.pdf")
    expect(noTotal.amounts?.total).toBeNull()
    // 03:30 UTC on the 16th is still the 15th in PT.
    expect(vendorFilename({ rule: ITI, docType: "invoice", filename: "243496_x.pdf", subject: "", receivedAt: "2026-10-16T03:30:00.000Z", bodyText: "" }).name).toBe("ITI invoice 243496 - 2026-10-15.pdf")
    expect(ptDate("2026-10-16T03:30:00.000Z")).toBe("2026-10-15")
  })
  it("signed proof, tax form (signed / unsigned), quote — sanitizeFilename applied", () => {
    expect(vendorFilename({ rule: ITI, docType: "proof", filename: "RE-Proof3 for order #240069.pdf", subject: pandaSigned.subject, receivedAt: pandaSigned.internalDate }).name).toBe("ITI proof RE-Proof3 for order #240069 - signed - 2026-04-30.pdf")
    expect(vendorFilename({ rule: ITI, docType: "proof", filename: "p.pdf", subject: 'Signed copy of "Proof: A/B "final"?"', receivedAt: pandaSigned.internalDate }).name).toBe(sanitizeFilename("ITI proof Proof: A/B \"final\"? - signed - 2026-04-30.pdf"))
    expect(vendorFilename({ rule: ITI, docType: "proof", filename: "p.pdf", subject: 'Signed copy of "Proof: A/B "final"?"', receivedAt: pandaSigned.internalDate }).name).not.toMatch(/[\\/:*?"<>|]/)
    expect(vendorFilename({ rule: ITI, docType: "tax_form", filename: "CDTFA-230.pdf", subject: "Tax exemption", receivedAt: "2026-10-10T17:00:00.000Z", signed: null }).name).toBe("ITI tax exemption form - 2026-10-10.pdf")
    expect(vendorFilename({ rule: ITI, docType: "tax_form", filename: "CDTFA-230 signed.pdf", subject: "Tax exemption", receivedAt: "2026-10-10T17:00:00.000Z", signed: null }).name).toBe("ITI tax exemption form - 2026-10-10 - signed.pdf")
    expect(vendorFilename({ rule: ITI, docType: "tax_form", filename: "CDTFA-230.pdf", subject: "Tax exemption", receivedAt: "2026-10-10T17:00:00.000Z", signed: true }).name).toBe("ITI tax exemption form - 2026-10-10 - signed.pdf")
    expect(vendorFilename({ rule: ITI, docType: "quote", filename: "Quote.pdf", subject: "Quote", receivedAt: "2026-09-30T17:00:00.000Z" }).name).toBe("ITI quote - 2026-09-30.pdf")
  })
})

describe("revised / disputed invoices — supersede, paid, diff", () => {
  const folder = [
    { id: "f1", name: "ITI invoice 243481 - 2026-10-14 - $10,135.57.pdf" },
    { id: "f2", name: "ITI invoice 240112 - 2026-04-30 - $8,400.00 PAID.pdf" },
    { id: "f3", name: "ITI invoice 243470 - 2026-10-13 - $10,135.57 SUPERSEDED.pdf" },
    { id: "f4", name: "ITI proof RE-Proof3 for order #240069 - signed - 2026-04-30.pdf" },
    { id: "f5", name: "ITI quote - 2026-09-30.pdf" },
  ]
  it("renames exactly the unpaid, unsuperseded invoice(s)", () => {
    expect(supersedeRenames(folder)).toEqual([{ id: "f1", from: folder[0].name, to: "ITI invoice 243481 - 2026-10-14 - $10,135.57 SUPERSEDED.pdf" }])
    expect(supersedeRenames(folder.map((f) => f.name))).toEqual([{ from: folder[0].name, to: "ITI invoice 243481 - 2026-10-14 - $10,135.57 SUPERSEDED.pdf" }])
    expect(supersedeRenames(folder, { exclude: folder[0].name })).toEqual([]) // the file just uploaded is never superseded
    expect(supersedeRenames([])).toEqual([])
    expect(supersedeRenames([{ id: "x", name: "iti invoice 1 - 2026-01-01.pdf" }])[0].to).toBe("iti invoice 1 - 2026-01-01 SUPERSEDED.pdf")
  })
  it("paid / superseded markers go before the extension", () => {
    expect(paidName("ITI invoice 243496 - 2026-10-15 - $10,385.57.pdf")).toBe("ITI invoice 243496 - 2026-10-15 - $10,385.57 PAID.pdf")
    expect(markedName("no-ext", "PAID")).toBe("no-ext PAID")
    expect(markedName("ITI invoice 1.PDF", "SUPERSEDED")).toBe("ITI invoice 1 SUPERSEDED.PDF")
  })
  it("diff lines against the previous invoice's stored amounts", () => {
    const prev = { subtotal: 9885.57, discount: 0, tax: 250, total: 10135.57, invoice_no: "243481" }
    const next = { subtotal: 10135.57, discount: 0, tax: 250, total: 10385.57, invoice_no: "243496" }
    expect(invoiceDiffLines(prev, next)).toEqual([
      "vs invoice 243481:",
      "Subtotal: $9,885.57 → $10,135.57 (+$250.00)",
      "Discount: $0.00 → $0.00 (same)",
      "Tax: $250.00 → $250.00 (same)",
      "Total: $10,135.57 → $10,385.57 (+$250.00)",
      "setup/other line changes: see PDF",
    ])
    expect(invoiceDiffLines(null, next)).toEqual([])
    expect(invoiceDiffLines({ subtotal: null, total: 100, invoice_no: null }, { subtotal: 90, total: 90 })).toEqual(["vs invoice (previous):", "Subtotal: — → $90.00", "Discount: — → —", "Tax: — → —", "Total: $100.00 → $90.00 (-$10.00)", "setup/other line changes: see PDF"])
  })
})

describe("campaign resolution", () => {
  const parent = { id: CAMPAIGN_ID, name: "NOO Q4 2026", drive_folder_id: "14qk007vZ5iHMPLU3lAjiOB-_o_Go0N--", parent_campaign_id: null, drop_date: "2026-10-08" }
  const childA = { id: "a", name: "NOO Q4 2026 — A (bullets)", drive_folder_id: null, parent_campaign_id: CAMPAIGN_ID, drop_date: "2026-10-08" }
  const old = { id: "o", name: "MFM-B", drive_folder_id: "old-folder", parent_campaign_id: null, drop_date: "2025-03-01" }
  const NOW = Date.UTC(2026, 9, 16)
  it("(1) the pinned campaign wins; (2) else the only current campaign with a folder; (3) else nothing", () => {
    expect(pickCampaign(ITI, [childA, parent, old], NOW).campaign?.id).toBe(CAMPAIGN_ID)
    expect(pickCampaign(ITI, [childA, parent, old], NOW).why).toMatch(/pinned/)
    expect(pickCampaign({ ...ITI, campaign_id: null }, [childA, parent, old], NOW).campaign?.id).toBe(CAMPAIGN_ID) // MFM-B is 19 months old
    expect(pickCampaign({ ...ITI, campaign_id: null }, [childA, parent, { ...old, drop_date: "2026-09-01" }], NOW)).toMatchObject({ campaign: null, why: "2 current campaigns have a Drive folder" })
    expect(pickCampaign({ ...ITI, campaign_id: null }, [childA], NOW)).toMatchObject({ campaign: null, why: "no campaign has a Drive folder" })
    expect(pickCampaign(ITI, [{ ...parent, drive_folder_id: null }, { ...old, drop_date: "2026-09-01" }], NOW)).toMatchObject({ campaign: null, why: "campaign NOO Q4 2026 has no drive_folder_id" })
    expect(pickCampaign(ITI, [], NOW).campaign).toBeNull()
  })
  it("the Paid tap sets total_cost on the parent", () => {
    expect(parentCampaignOf(childA, [parent, childA])?.id).toBe(CAMPAIGN_ID)
    expect(parentCampaignOf(parent, [parent, childA])?.id).toBe(CAMPAIGN_ID)
    expect(parentCampaignOf(null, [])).toBeNull()
  })
})

describe("Part C — South Bay Termite guard", () => {
  it("Termite Report & Receipt → the bare Report PDF is an inspection → Properties/<property>/Inspections", () => {
    const t = refineDocType("Report 674.pdf", "invoice", "southbaytermite@yahoo.com", "Termite Report & Receipt | 674 Kirkland Dr, SUNNYVALE")
    expect(t).toBe("inspection")
    expect(WHITELIST.has(t)).toBe(true)
    expect(filingDecision(t, null)).toEqual({ file: true, sub: "Inspections" })
    const dest = destinationFor({ property: "674 Kirkland Dr", docType: t, filename: "Report 674.pdf", subject: "Termite Report & Receipt | 674 Kirkland Dr, SUNNYVALE", receivedAt: "2026-08-20T18:00:00.000Z", stage: null, seq: 1 })
    expect(dest).toEqual({ folder: "Properties/674 Kirkland Dr/Inspections", name: "Report 674.pdf", stage: null })
  })
  it("the forwarded variant from Amanda, and the model saying 'other'", () => {
    expect(refineDocType("Report 674.pdf", "other", "amanda@bakshirealestate.com", "Fwd: Termite Report & Invoice | 674 Kirkland Dr, SUNNYVALE")).toBe("inspection")
    expect(refineDocType("Report 674.pdf", "invoice", "amanda@bakshirealestate.com", "Fwd: Termite Report & Invoice | 674 Kirkland Dr, SUNNYVALE")).toBe("inspection")
    expect(refineDocType("WDO report 2116 Quito.pdf", null, "x@y.com", "WDO inspection")).toBe("inspection")
  })
  it("a file whose own name says invoice/receipt stays an invoice; other explicit types are kept", () => {
    expect(refineDocType("Invoice 674.pdf", "invoice", "southbaytermite@yahoo.com", "Termite Report & Receipt | 674 Kirkland Dr")).toBe("invoice")
    expect(refineDocType("Receipt.pdf", "other", "southbaytermite@yahoo.com", "Termite Report & Receipt | 674 Kirkland Dr")).toBe("other")
    expect(refineDocType("TDS.pdf", "disclosure", "agent@x.com", "Termite clearance + disclosures")).toBe("disclosure")
    expect(TERMITE_SUBJECT_RE.test("Window replacement")).toBe(false)
  })
})
