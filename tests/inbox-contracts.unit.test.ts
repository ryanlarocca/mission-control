// Inbox agent — negotiations and ratified contracts (Ryan 2026-11-18).
// On 5764 Halleck Dr the offer ($1,050,000) → SCO 1 ($1,075,000) → BCO 1
// ($1,060,000, signed by LRG Homes) left four copies of the RPA and three of the
// counter (DocuSign "In Process" drafts) in the buyer's folder, the signed BCO
// went to a ❓ card as "2116 Quito Rd", and nothing was ever joined into the
// contract escrow wants. Text fixtures below are trimmed pdftotext -layout output
// of those real documents.
import { describe, expect, it } from "vitest"
import {
  acceptanceFromText, acceptedFolderName, buyerSurnames, contractChain, contractFacts, dollars, emailNamesProperty,
  isAcceptedFolder, isRatified, labelOfName, nextSequence, offerDocName, offerFolderMatch, purchaseChain, ratifiedContractName,
} from "../scripts/inbox-agent/filing.mjs"

const ENV_SCO = "Docusign Envelope ID: 1A2B3C4D-1111-2222-3333-444455556666"
const SCO_SIGNED_BY_SELLER = `${ENV_SCO}
                                                                           SELLER COUNTER OFFER No.                                             1
                                                                               May not be used as a multiple counter offer.
    This is a counter offer to the Purchase Agreement, OR        Buyer Counter Offer No.        , Other
        D. OTHER TERMS: 1. Purchase price to be $1,075,000.
    4.    OFFER: SELLER MAKES THIS COUNTER OFFER ON THE TERMS ABOVE AND ACKNOWLEDGES RECEIPT OF A COPY.
                                                                                                                           11/17/2026
          Seller                                                                                     LRG Homes, LLC Date
    5.    ACCEPTANCE: I/WE accept the above Seller Counter Offer (If checked                                                     SUBJECT TO THE ATTACHED BUYER COUNTER
          OFFER No.     ) and acknowledge receipt of a Copy.

          Buyer                                                                                                                 Priya Anand Sharma Date
          Buyer                                                                                                                           Rohan Mehta Date

    6.    LATE ACCEPTANCE: If the date of Buyer's signature in paragraph 5 is after the expiration specified in paragraph 2A, Buyer's
          Seller                                                                                                                        LRG Homes, LLC Date _______________
    © 2026, California Association of REALTORS®, Inc.`
const SCO_DRAFT = SCO_SIGNED_BY_SELLER.replace("    4.    OFFER:", "                                              In Process\n    4.    OFFER:")
const BCO_ACCEPTED = `Docusign Envelope ID: 5E6F7A8B-7777-8888-9999-AAAABBBBCCCC
                                                              BUYER COUNTER OFFER No.                                           1
    This is a counter offer to the Seller Counter Offer No.             1 , OR        Seller Multiple Counter Offer No.                 ,       Other
          D.   OTHER TERMS: Purchase price to be $1,060,000.
          Buyer X                                                                                                Priya Anand Sharma Date 11/18/2026 | 9:14 AM PST
          Buyer X                                                                                                          Rohan Mehta Date 11/18/2026 | 7:03 AM PST
    4.    ACCEPTANCE: I/WE accept the above Buyer Counter Offer and all Signed Addenda, if any, (If checked                                                         SUBJECT TO THE
          ATTACHED SELLER COUNTER OFFER No.            OR SELLER MULTIPLE COUNTER OFFER No.                                                                         ), and acknowledge
          receipt of a Copy.
                                                                                                                                                                      11/18/2026
          Seller                                                                                                                LRG Homes, LLC Date
          Seller                                                                                                                                           Date
    © 2026, California Association of REALTORS®, Inc.`
const BCO_NOT_YET = BCO_ACCEPTED.replace(/\n {100,}11\/18\/2026\n/, "\n")
const RPA_COUNTERED = `Docusign Envelope ID: 9C8D7E6F-1234-5678-9ABC-DEF012345678
    Pre-approval: $975,000
                      CALIFORNIA RESIDENTIAL PURCHASE AGREEMENT AND JOINT ESCROW INSTRUCTIONS
       A       5, 5B (cash)    Purchase Price                                    $ 1,050,000.00                                                       All Cash
    33. ACCEPTANCE
        A. ACCEPTANCE OF OFFER: Seller warrants that Seller is the owner of the Property or has the authority to execute this
             Seller's acceptance is subject to the attached Counter Offer or Back-Up Offer Addendum, or both, checked below.
              X Seller Counter Offer (C.A.R. Form SCO or SMCO)
                Back-Up Offer Addendum (C.A.R. Form BUO)`

describe("contractFacts — what a contract PDF is, from its text", () => {
  it("reads form, number and price; the title that comes first decides", () => {
    expect(contractFacts(SCO_SIGNED_BY_SELLER)).toEqual({ form: "SCO", number: 1, price: 1075000, envelopeIds: ["1A2B3C4D-1111-2222-3333-444455556666"], inProcess: false })
    // the BCO mentions "Seller Counter Offer No. 1" below its own title
    expect(contractFacts(BCO_ACCEPTED)).toMatchObject({ form: "BCO", number: 1, price: 1060000 })
    // the RPA package starts with a lender letter; the price is the RPA's, not the pre-approval
    expect(contractFacts(RPA_COUNTERED)).toMatchObject({ form: "RPA", number: null, price: 1050000 })
  })
  it("a DocuSign copy stamped In Process is a draft", () => {
    expect(contractFacts(SCO_DRAFT)?.inProcess).toBe(true)
    // the phrase in running text, or without a DocuSign envelope, is not the stamp
    expect(contractFacts("Permit status: work in process at the city.")?.inProcess).toBe(false)
    expect(contractFacts("\n   In Process\n SELLER COUNTER OFFER No. 2")?.inProcess).toBe(false)
  })
  it("no text (a scan) = null; a disclosure has no form", () => {
    expect(contractFacts("")).toBeNull()
    expect(contractFacts("TRANSFER DISCLOSURE STATEMENT 5764 Halleck Dr")).toMatchObject({ form: null, price: null })
  })
})

describe("acceptance — did the other side sign?", () => {
  it("SCO 1 signed only by Ryan is NOT accepted (the model alone said it was)", () => {
    expect(acceptanceFromText(SCO_SIGNED_BY_SELLER, "SCO")).toBe(false)
    expect(isRatified({ form: "SCO", textSays: false, modelSays: true })).toBe(false)
  })
  it("BCO 1 with the seller's acceptance dated is the ratifying signature", () => {
    expect(acceptanceFromText(BCO_ACCEPTED, "BCO")).toBe(true)
    expect(acceptanceFromText(BCO_NOT_YET, "BCO")).toBe(false)
    expect(isRatified({ form: "BCO", textSays: true, modelSays: null })).toBe(true)
  })
  it("accepting subject to a new counter is a counter, not acceptance", () => {
    const sub = BCO_ACCEPTED.replace("ATTACHED SELLER COUNTER OFFER No.            OR", "ATTACHED SELLER COUNTER OFFER No. 2          OR")
    expect(acceptanceFromText(sub, "BCO")).toBe(false)
  })
  it("an RPA answered with a counter was not accepted; otherwise the model reads the seller's signature", () => {
    expect(acceptanceFromText(RPA_COUNTERED, "RPA")).toBe(false)
    const clean = RPA_COUNTERED.replace("              X Seller Counter Offer", "                Seller Counter Offer")
    expect(acceptanceFromText(clean, "RPA")).toBeNull()
    expect(isRatified({ form: "RPA", textSays: null, modelSays: true })).toBe(true)
    expect(isRatified({ form: "RPA", textSays: null, modelSays: false })).toBe(false)
  })
  it("a multiple counter needs the seller's final acceptance too (model) on top of the buyer's (text)", () => {
    expect(isRatified({ form: "SMCO", textSays: true, modelSays: false })).toBe(false)
    expect(isRatified({ form: "SMCO", textSays: true, modelSays: true })).toBe(true)
    expect(isRatified({ form: null, textSays: true, modelSays: true })).toBe(false)
  })
})

describe("names", () => {
  it("contract files read as the negotiation: form, number, date, price", () => {
    const at = "2026-11-18T00:58:02Z" // 4:58 PM PT on 11-17
    expect(offerDocName({ docType: "counter", filename: "Seller_Counter_Offer__4___6_26 (2).pdf", receivedAt: at, facts: contractFacts(SCO_SIGNED_BY_SELLER) })).toBe("SCO 1 2026-11-17 $1,075,000.pdf")
    expect(offerDocName({ docType: "purchase_agreement", filename: "Halleck Offer (1).pdf", receivedAt: at, facts: contractFacts(RPA_COUNTERED) })).toBe("RPA 2026-11-17 $1,050,000.pdf")
    // no readable form → the old label
    expect(offerDocName({ docType: "counter", filename: "scan.pdf", receivedAt: "2026-11-03T20:00:00Z", facts: null })).toBe("Counter Offer 2026-11-03.pdf")
  })
  it("buyers are known by surname; entities whole", () => {
    expect(buyerSurnames("Priya Anand Sharma, Rohan Mehta")).toEqual(["Sharma", "Mehta"])
    expect(buyerSurnames("Daniel Tran & Mei-Lin Wong")).toEqual(["Tran", "Wong"])
    expect(buyerSurnames("Min Park and Ji Lee")).toEqual(["Park", "Lee"])
    expect(buyerSurnames("Jane Doe and John Doe Jr.")).toEqual(["Doe"])
    expect(buyerSurnames("Surging Homes LLC")).toEqual(["Surging Homes LLC"])
  })
  it("one buyer, one folder — however the names are joined, old or new folder style; the ACCEPTED one wins", () => {
    const halleck = ["Daniel Tran, Mei-Lin Wong $1.03M offer 2026-11-03", "2026-11-16 Park & Lee $950k", "Older versions"]
    expect(offerFolderMatch(halleck, "Daniel Tran & Mei-Lin Wong")).toBe("Daniel Tran, Mei-Lin Wong $1.03M offer 2026-11-03")
    expect(offerFolderMatch(halleck, "Ji Lee, Min Park")).toBe("2026-11-16 Park & Lee $950k")
    expect(offerFolderMatch(halleck, "Mei-Lin Wong")).toBe("Daniel Tran, Mei-Lin Wong $1.03M offer 2026-11-03")
    expect(offerFolderMatch(halleck, "Leeann Cho")).toBeNull()
    expect(offerFolderMatch(["2026-11-17 Sharma & Mehta $1.05M", "2026-11-17 Sharma & Mehta $1.05M – ACCEPTED"], "Rohan Mehta, Priya Sharma")).toBe("2026-11-17 Sharma & Mehta $1.05M – ACCEPTED")
  })
  it("ACCEPTED marker and the ratified contract name", () => {
    expect(acceptedFolderName("2026-11-17 Sharma & Mehta $1.05M")).toBe("2026-11-17 Sharma & Mehta $1.05M – ACCEPTED")
    expect(acceptedFolderName("x – ACCEPTED")).toBe("x – ACCEPTED")
    expect(isAcceptedFolder("x - ACCEPTED")).toBe(true)
    expect(ratifiedContractName({ side: "seller", receivedAt: "2026-11-18T19:40:28Z", price: 1060000, seq: 4 })).toBe("04 Sale – Ratified Contract 2026-11-18 $1,060,000.pdf")
    expect(ratifiedContractName({ side: "buyer", receivedAt: "2026-08-25T19:00:00Z", price: null, seq: 2 })).toBe("02 Purchase – Ratified Contract 2026-08-25.pdf")
    expect(dollars(1060000)).toBe("$1,060,000")
  })
  it("Purchase & Sale numbering counts the ratified contract", () => {
    expect(nextSequence(["01 Offer RPA 2026-08-25.pdf", "02 Addendum 2026-10-19.pdf", "03 Addendum 2026-10-19.pdf", "04 Sale – Ratified Contract 2026-11-18 $1,060,000.pdf"])).toBe(5)
  })
})

describe("the chain", () => {
  it("RPA first, then counters by number with the seller's before the buyer's reply; non-contract files left out", () => {
    const files = ["BCO 1 2026-11-18 $1,060,000.pdf", "Fully Executed Disclosures.pdf", "SCO 2 2026-11-19 $1,065,000.pdf", "SCO 1 2026-11-17 $1,075,000.pdf", "RPA 2026-11-17 $1,050,000.pdf", "Proof of Funds 2026-11-17.pdf"].map((name) => ({ name }))
    expect(contractChain(files).map((f) => labelOfName(f.name))).toEqual(["RPA", "SCO 1", "BCO 1", "SCO 2"])
    expect(contractChain([{ name: "SCO 1 2026-11-17 $1,075,000.pdf" }])).toEqual([])
  })
  it("Ryan's own purchase: the latest Offer RPA and the counters after it", () => {
    const ps = ["01 Offer RPA 2026-08-20.pdf", "02 Counter Offer 2026-08-21.pdf", "03 Offer RPA 2026-08-25.pdf", "04 Counter Offer 2026-08-26.pdf", "05 Addendum 2026-08-27.pdf", "06 Counter Offer 2026-08-27.pdf"].map((name) => ({ name }))
    expect(purchaseChain(ps).map((f) => f.name)).toEqual(["03 Offer RPA 2026-08-25.pdf", "04 Counter Offer 2026-08-26.pdf", "06 Counter Offer 2026-08-27.pdf"])
  })
})

describe("whose property — the PDF beats a guess", () => {
  it("a DocuSign Completed email names no address; the classifier's Quito guess is not in it", () => {
    expect(emailNamesProperty("Completed: Complete with Docusign: Buyer_Counter_Offer__1___6_26-1.pdf\nAll parties have completed", "2116 Quito Rd")).toBe(false)
    expect(emailNamesProperty("Re: 2116 Quito Rd — counter attached", "2116 Quito Rd")).toBe(true)
    expect(emailNamesProperty("Quito offer", "2116 Quito Rd")).toBe(false)
  })
})
