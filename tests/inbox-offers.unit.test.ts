// Inbox agent — offers Ryan receives on his own listings (2026-11-01).
// Coko LLC's $1.5M as-is cash offer on 2116 Quito Rd had been filed as Ryan's
// own purchase chain. Pure pieces: buyer detection, package folder + file names,
// filingDecision with the offer flag, and refineDocType on the POF.
import { describe, expect, it } from "vitest"
import { OUR_NAMES_DEFAULT, cleanBuyerName, filingDecision, inboundOfferFrom, offerDocName, offerFolderMatch, offerPackageFolder, refineDocType, shortPrice } from "../scripts/inbox-agent/filing.mjs"
import { DOC_TYPES, OFFER_PACKAGE_TYPES, WHITELIST } from "../scripts/inbox-agent/llm.mjs"

const RECEIVED = "2026-10-30T20:09:07+00:00" // Amanda's forward, 1:09 PM PT

describe("inboundOfferFrom — who is buying?", () => {
  it("a buyer that is not one of our names = an offer Ryan received", () => {
    expect(inboundOfferFrom({ buyer: "Coko LLC, a California limited liability company and/or assignee", seller: "Ryan LaRocca", price: 1500000 })).toEqual({ buyer: "Coko LLC", price: 1500000 })
  })
  it("Ryan, LRG or the partnership entity as buyer = his own purchase chain", () => {
    expect(inboundOfferFrom({ buyer: "Ryan LaRocca", price: 1465000 })).toBeNull()
    expect(inboundOfferFrom({ buyer: "LRG Homes Inc and/or assignee", price: 1465000 })).toBeNull()
    expect(inboundOfferFrom({ buyer: "Ryan LaRocca & Charity Doors LLC", price: 1465000 })).toBeNull()
  })
  it("no readable buyer (a disclosure, a bad scan) = not an offer", () => {
    expect(inboundOfferFrom(null)).toBeNull()
    expect(inboundOfferFrom({ buyer: null, price: 1500000 })).toBeNull()
    expect(inboundOfferFrom({ buyer: "  " })).toBeNull()
  })
  it("extra names from settings count as ours", () => {
    expect(inboundOfferFrom({ buyer: "Quito Partners LLC" }, [...OUR_NAMES_DEFAULT, "Quito Partners"])).toBeNull()
  })
  it("a bad price is dropped, not invented", () => {
    expect(inboundOfferFrom({ buyer: "Coko LLC", price: "n/a" })).toEqual({ buyer: "Coko LLC", price: null })
  })
})

describe("names", () => {
  it("cleanBuyerName strips entity boilerplate and assignee clauses", () => {
    expect(cleanBuyerName("Coko LLC, a California limited liability company and/or assignee")).toBe("Coko LLC")
    expect(cleanBuyerName("Jane Doe and John Doe (or assignee)")).toBe("Jane Doe and John Doe")
    expect(cleanBuyerName("The Smith Family Trust")).toBe("The Smith Family Trust")
  })
  it("shortPrice", () => {
    expect(shortPrice(1500000)).toBe("$1.5M")
    expect(shortPrice(1465000)).toBe("$1.465M")
    expect(shortPrice(850000)).toBe("$850k")
    expect(shortPrice(null)).toBeNull()
  })
  it("one folder per offer, named by buyer, price and the day it arrived", () => {
    expect(offerPackageFolder({ buyer: "Coko LLC", price: 1500000, receivedAt: RECEIVED })).toBe("Coko LLC $1.5M offer 2026-10-30")
    expect(offerPackageFolder({ buyer: "Coko LLC", price: null, receivedAt: RECEIVED })).toBe("Coko LLC offer 2026-10-30")
  })
  it("a later counter joins the buyer's existing folder", () => {
    const existing = ["Coko LLC $1.5M offer 2026-10-30", "Jane Doe $1.6M offer 2026-11-02"]
    expect(offerFolderMatch(existing, "Coko LLC, a California limited liability company")).toBe("Coko LLC $1.5M offer 2026-10-30")
    expect(offerFolderMatch(existing, "Cokonut Inc")).toBeNull()
    expect(offerFolderMatch([], "Coko LLC")).toBeNull()
  })
  it("short dated names inside the package", () => {
    expect(offerDocName({ docType: "purchase_agreement", filename: "California Residential Purchase Agreement - 626pdf-52.pdf", receivedAt: RECEIVED })).toBe("Offer RPA 2026-10-30.pdf")
    expect(offerDocName({ docType: "contingency_removal", filename: "Buyer Contingency Removal 1 - 624pdf-52.pdf", receivedAt: RECEIVED })).toBe("Buyer Contingency Removal 2026-10-30.pdf")
    expect(offerDocName({ docType: "closing_statement", filename: "Coko Closing Statements-3.pdf", receivedAt: RECEIVED })).toBe("Buyer Closing Statement 2026-10-30.pdf")
    expect(offerDocName({ docType: "proof_of_funds", filename: "Coko LLC POF - October 2026.pdf", receivedAt: RECEIVED })).toBe("Proof of Funds 2026-10-30.pdf")
    expect(offerDocName({ docType: "escrow_instructions", filename: "Sky Escrow ABA.pdf", receivedAt: RECEIVED })).toBe("Escrow Wire Instructions 2026-10-30.pdf")
    expect(offerDocName({ docType: "addendum", filename: "Addendum 2.pdf", receivedAt: RECEIVED })).toBe("Addendum 2 2026-10-30.pdf")
    expect(offerDocName({ docType: "other", filename: "Something.pdf", receivedAt: RECEIVED })).toBe("Something.pdf")
  })
})

describe("filingDecision with the offer flag", () => {
  it("the whole package files, including POF and the escrow wire sheet", () => {
    for (const t of ["purchase_agreement", "contingency_removal", "closing_statement", "proof_of_funds", "escrow_instructions"]) {
      expect(filingDecision(t, null, { offer: true })).toMatchObject({ file: true, sub: "Offers" })
    }
  })
  it("the buyer-rep agreement and other noise still stay out", () => {
    expect(filingDecision("other", null, { offer: true }).file).toBe(false)
    expect(filingDecision("flyer", null, { offer: true }).file).toBe(false)
  })
  it("without the flag nothing changes: POF / escrow instructions are not transaction documents", () => {
    expect(filingDecision("proof_of_funds", null).file).toBe(false)
    expect(filingDecision("escrow_instructions", null).file).toBe(false)
    expect(filingDecision("purchase_agreement", null)).toMatchObject({ file: true, sub: "Purchase & Sale" })
  })
  it("package membership vs the whitelist", () => {
    expect(WHITELIST.has("proof_of_funds")).toBe(false)
    expect(DOC_TYPES).toContain("proof_of_funds")
    expect([...OFFER_PACKAGE_TYPES].every((t) => DOC_TYPES.includes(t))).toBe(true)
  })
})

describe("refineDocType — the POF is a proof of funds, never a print proof", () => {
  it("by filename, whatever the classifier said", () => {
    expect(refineDocType("Coko LLC POF - October 2026.pdf", "proof", "amanda@bakshirealestate.com", "Fwd: As-Is Cash Offer - 2116 Quito Road")).toBe("proof_of_funds")
    expect(refineDocType("Proof of Funds.pdf", "other", "agent@example.com", "")).toBe("proof_of_funds")
  })
  it("proof of insurance / payment are not funds, and a classifier 'proof' with no proof in the name is just unknown", () => {
    expect(refineDocType("Proof of Insurance.pdf", "other", "agent@example.com", "")).toBe("other")
    expect(refineDocType("Bank Letter.pdf", "proof", "agent@example.com", "")).toBe("other")
  })
})
