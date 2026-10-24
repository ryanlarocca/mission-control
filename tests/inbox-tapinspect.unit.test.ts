// Inbox agent — HomeSentry / tapinspect report fetcher
// (briefs/BRIEF_INBOX_VENDOR_FILING_TAPINSPECT_2026-10-16.md, Part B). Pure
// pieces only: provider detection, the click allowlist, the gate text rule
// (the share page's static instructions are never a gate), the
// awaiting_payment transitions with the 14-day cutoff, the wake rules, the
// same-URL requeue matrix on the Halleck sequence, and the report file name.
import { describe, expect, it } from "vitest"
import { detectProvider, documentLinks, providerKind, providerLabel, queuesOnSystemEmail, tapinspectShareId } from "../scripts/inbox-agent/fetch/providers.mjs"
import { SELECTORS, TAP_CLICK_ALLOW, gateFromReportText, tapClickAllowed } from "../scripts/inbox-agent/fetch/tapinspect.mjs"
import { AWAITING_PAYMENT_ERROR, AWAITING_PAYMENT_MAX_TRIES, AWAITING_PAYMENT_RETRY_MS, addressIn, awaitingPaymentNext, fetchDocuments, paymentWakeTargets, requeueDecision } from "../scripts/inbox-agent/fetch/index.mjs"
import { destinationFor } from "../scripts/inbox-agent/filing.mjs"

const HALLECK_SHARE = "https://app.tapinspect.com/shares/0b3c6c1e-9a1f-4d2b-8e7a-5f0c1d2e3a4b"
const QUITO_SHARE = "https://app.tapinspect.com/shares/7a1e2f3d-4c5b-4a69-9b8c-0d1e2f3a4b5c"

// The three Halleck emails named in the brief (gmail ids 1a14056ab449524c, 1a146754b76d30a8, 1a14674c084ab8c7), modelled.
const firstResults = {
  id: "1a14056ab449524c", threadId: "t-halleck-1",
  from: { email: "inspections@tapinspect.com", name: "HomeSentry Inspections" },
  subject: "Inspection results for 5764 Halleck Dr, San Jose, CA 95123",
  internalDate: "2026-10-13T22:10:00.000Z",
  text: `Your inspection results are ready.\n\nView Report: ${HALLECK_SHARE}\n\nIf you have not signed pre-inspection or made payment results will not be viewable.\nhttps://www.tapinspect.com/privacy`,
  attachments: [],
}
const resultsUpdated = { ...firstResults, id: "1a146754b76d30a8", threadId: "t-halleck-2", subject: "Inspection results have been updated for 5764 Halleck Dr, San Jose, CA 95123", internalDate: "2026-10-16T18:00:00.000Z" }
const paymentThanks = { ...firstResults, id: "1a14674c084ab8c7", threadId: "t-halleck-3", subject: "Thank you for your payment — 5764 Halleck Dr", internalDate: "2026-10-16T17:40:00.000Z", text: "Thanks for your payment of $650.00 for the inspection at 5764 Halleck Dr, San Jose, CA 95123.\nhttps://www.tapinspect.com/help" }
const cls = { kind: "automated", property: { label: "5764 Halleck Dr", address: "5764 Halleck Dr, San Jose, CA 95123" }, document_links: [HALLECK_SHARE] }

describe("detectProvider — tapinspect", () => {
  it("recognises the share page and nothing else on tapinspect.com", () => {
    expect(detectProvider(HALLECK_SHARE)).toBe("tapinspect")
    expect(detectProvider(`${HALLECK_SHARE}/`)).toBe("tapinspect")
    expect(detectProvider(HALLECK_SHARE.toUpperCase().replace("HTTPS://APP.TAPINSPECT.COM", "https://app.tapinspect.com"))).toBe("tapinspect")
    expect(detectProvider("https://app.tapinspect.com/shares/not-a-uuid")).toBeNull()
    expect(detectProvider("https://app.tapinspect.com/shares/0b3c6c1e-9a1f-4d2b-8e7a-5f0c1d2e3a4b/invoice")).toBeNull()
    expect(detectProvider("https://app.tapinspect.com/login")).toBeNull()
    expect(detectProvider("https://app.tapinspect.com/")).toBeNull()
    expect(detectProvider("https://www.tapinspect.com/privacy")).toBeNull()
    expect(detectProvider("https://tapinspect.com/shares/0b3c6c1e-9a1f-4d2b-8e7a-5f0c1d2e3a4b")).toBeNull()
    expect(detectProvider("https://evil.example.com/?u=https://app.tapinspect.com/shares/0b3c6c1e-9a1f-4d2b-8e7a-5f0c1d2e3a4b")).toBeNull()
  })
  it("existing DocuSign / f8 cases are unchanged; kind, label, system-email gate", () => {
    expect(detectProvider("https://na4.docusign.net/Signing/EmailStart.aspx?a=1&etti=2&r=3")).toBe("docusign")
    expect(detectProvider("https://f8.f8re.com/listings/01a136a0-d777-7338-9063-d76425919515/download-center?signature=x")).toBe("f8")
    expect(providerKind("tapinspect")).toBe("document")
    expect(providerKind("f8")).toBe("media")
    expect(providerLabel("tapinspect")).toBe("HomeSentry (Tap Inspect)")
    expect(queuesOnSystemEmail("tapinspect")).toBe(true)
    expect(queuesOnSystemEmail("f8")).toBe(true)
    expect(queuesOnSystemEmail("docusign")).toBe(false)
  })
  it("documentLinks on the results email finds exactly the share link; the share uuid is extracted", () => {
    expect(documentLinks(firstResults)).toEqual([{ url: HALLECK_SHARE, provider: "tapinspect" }])
    expect(documentLinks(paymentThanks)).toEqual([])
    expect(tapinspectShareId(HALLECK_SHARE)).toBe("0b3c6c1e-9a1f-4d2b-8e7a-5f0c1d2e3a4b")
    expect(tapinspectShareId("https://app.tapinspect.com/login")).toBeNull()
    expect(tapinspectShareId("nope")).toBeNull()
  })
})

describe("tapinspect flow — clicks and the gate", () => {
  it("clicks only the report entry and the download controls; never the invoice, agreement, manual or a payment button", () => {
    for (const l of ["Home Inspection Report", "HOME INSPECTION REPORT", "Download Report", "download report", "Download", "Download PDF", "More", "more_vert", "Close"]) expect(tapClickAllowed(l).ok, l).toBe(true)
    for (const l of ["Invoice 11275718", "New Ca Agreement", "Home Maintenance Manual ( Download )", "Agreements and Invoice", "Pay Invoice", "Make Payment", "Sign Agreement", "Log in", "View Invoice"]) expect(tapClickAllowed(l).ok, l).toBe(false)
    expect(tapClickAllowed(["download-report-button", "Download Report"]).ok).toBe(true)
    // Live 2026-10-16 (Halleck): "Download Report" is a dropdown — the full report is the only item the flow picks.
    expect(tapClickAllowed("Download Full Report").ok).toBe(true)
    expect(SELECTORS.downloadMenuItem.test("Download Full Report")).toBe(true)
    expect(SELECTORS.downloadMenuItem.test("Download Report Summary Only")).toBe(false)
    expect(tapClickAllowed(["Download", "invoice-download"]).ok).toBe(false) // a forbidden candidate wins
    expect(tapClickAllowed([]).ok).toBe(false)
    expect(TAP_CLICK_ALLOW.length).toBeGreaterThan(4)
    expect(SELECTORS.reportEntry.test("Home Inspection Report")).toBe(true)
  })
  it("the share page's static instructions are NOT a gate; a payment/agreement message on the report view is", () => {
    const sharePage = ["HomeSentry Inspections", "Please click on View Report to see your inspection results. If you have not signed pre-inspection or made payment results will not be viewable. Click on Agreements and Invoice Button.", "If you choose to download a PDF version of report, scroll to the bottom at left side of report and you will see a download report button there. Or, if viewing on a mobile device, tap the 3 dots at upper right and you will see download option there.", "Reports", "Home Inspection Report", "Attachments", "Invoice 11275718", "New Ca Agreement — Signed on October 13, 2026 by Ryan LaRocca", "Home Maintenance Manual ( Download )"].join("\n")
    expect(gateFromReportText(sharePage)).toBeNull()
    expect(gateFromReportText("5764 Halleck Dr — Home Inspection Report\nSummary\nDownload Report")).toBeNull()
    expect(gateFromReportText("This report is not yet viewable. Please make payment and sign the agreement.")).toBe("payment")
    expect(gateFromReportText("Payment is required to view the results.")).toBe("payment")
    expect(gateFromReportText("Please sign the pre-inspection agreement to continue.")).toBe("payment")
    expect(gateFromReportText("")).toBeNull()
    // Live 2026-10-24 (Quito): the unpaid share page has no Reports section — only this banner.
    expect(gateFromReportText("2116 Quito Rd\nPayment is required before you can access your inspection results\nNew Ca Agreement\nInvoice 11275730 - $475.00\nPlease Pay")).toBe("payment")
  })
  it("fetchDocuments still refuses unknown providers without a browser", async () => {
    const r = await fetchDocuments({ url: "https://disclosures.io/x", provider: null, log: () => {} })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/no fetcher/)
  })
})

describe("awaiting_payment — daily retry, 14-day cutoff", () => {
  const NOW = Date.UTC(2026, 9, 16, 12, 0, 0)
  it("parks for 24 h on each gated run, then expires on the 14th", () => {
    const first = awaitingPaymentNext(1, NOW)
    expect(first).toEqual({ status: "awaiting_payment", next_try_at: new Date(NOW + 24 * 3600_000).toISOString(), attempts: 1, error: AWAITING_PAYMENT_ERROR })
    expect(AWAITING_PAYMENT_RETRY_MS).toBe(24 * 60 * 60_000)
    expect(awaitingPaymentNext(13, NOW).status).toBe("awaiting_payment")
    const last = awaitingPaymentNext(14, NOW)
    expect(last.status).toBe("expired")
    expect(last.attempts).toBe(AWAITING_PAYMENT_MAX_TRIES)
    expect(last.error).toMatch(/never released in 14 days/)
    expect(awaitingPaymentNext(0, NOW).attempts).toBe(1)
    expect(awaitingPaymentNext(undefined as unknown as number, NOW).status).toBe("awaiting_payment")
  })
})

describe("same URL twice — requeue matrix (B5)", () => {
  it("a finished or parked tapinspect job is requeued; queued/running left alone; other providers stay duplicates", () => {
    for (const status of ["awaiting_payment", "failed", "expired"]) expect(requeueDecision({ id: "x", status }, "tapinspect"), status).toBe("requeue")
    // A finished report is pulled again only for an "updated" email — a forward of the first results email is not a new version.
    expect(requeueDecision({ id: "x", status: "done" }, "tapinspect", "Inspection results for 5764 Halleck Dr, San Jose, CA 95123 have been updated")).toBe("requeue")
    expect(requeueDecision({ id: "x", status: "done" }, "tapinspect", "Fwd: Inspection results for 5764 Halleck Dr, San Jose, CA 95123")).toBe("leave")
    expect(requeueDecision({ id: "x", status: "done" }, "tapinspect")).toBe("leave")
    for (const status of ["queued", "running", "needs_login", "needs_property"]) expect(requeueDecision({ id: "x", status }, "tapinspect"), status).toBe("leave")
    for (const status of ["done", "failed", "expired"]) expect(requeueDecision({ id: "x", status }, "docusign"), status).toBe("leave")
    expect(requeueDecision({ id: "x", status: "done" }, "f8")).toBe("leave")
    expect(requeueDecision(null, "tapinspect")).toBe("insert")
  })
  it("the Halleck sequence: results → gated → results updated (same URL) requeues the parked row", () => {
    // 10/13 first results: no row yet → insert.
    expect(requeueDecision(null, detectProvider(HALLECK_SHARE))).toBe("insert")
    // The fetch runs, the report is gated → awaiting_payment.
    const parked = { id: "job-halleck", status: awaitingPaymentNext(1).status, provider: "tapinspect", url: HALLECK_SHARE }
    expect(parked.status).toBe("awaiting_payment")
    // 10/16 "results have been updated" carries the SAME share URL → requeue, never a second row.
    expect(documentLinks(resultsUpdated)[0].url).toBe(HALLECK_SHARE)
    expect(requeueDecision(parked, "tapinspect")).toBe("requeue")
    // Once done, only an "updated" email requeues it (an unchanged PDF is then caught by the sha dedupe, silently).
    expect(requeueDecision({ ...parked, status: "done" }, "tapinspect", resultsUpdated.subject)).toBe("requeue")
    expect(requeueDecision({ ...parked, status: "done" }, "tapinspect", "Fwd: Inspection results for 5764 Halleck Dr")).toBe("leave")
    // While it is queued for the next pass a second copy of the email leaves it alone.
    expect(requeueDecision({ ...parked, status: "queued" }, "tapinspect")).toBe("leave")
  })
})

describe("wake rules (B4a) — which parked rows a HomeSentry email requeues", () => {
  const halleck = { id: "job-halleck", status: "awaiting_payment", provider: "tapinspect", url: HALLECK_SHARE, subject: firstResults.subject, property_label: "5764 Halleck Dr" }
  const quito = { id: "job-quito", status: "awaiting_payment", provider: "tapinspect", url: QUITO_SHARE, subject: "Inspection results for 2116 Quito Rd, Saratoga, CA 95070", property_label: "2116 Quito Rd" }
  const doneHalleck = { ...halleck, id: "job-done", status: "done" }
  it("the same share uuid wakes its row; a payment / updated / results subject wakes the same property; nothing else", () => {
    expect(paymentWakeTargets(resultsUpdated, cls, [halleck, quito, doneHalleck]).map((r) => r.id)).toEqual(["job-halleck"])
    // The payment-thanks email has no share link — the subject + property match does it.
    expect(paymentWakeTargets(paymentThanks, { ...cls, document_links: [] }, [halleck, quito]).map((r) => r.id)).toEqual(["job-halleck"])
    // No classifier property either: the address in the subject still matches.
    expect(paymentWakeTargets(paymentThanks, null, [halleck, quito]).map((r) => r.id)).toEqual(["job-halleck"])
    // A parked row with no label of its own matches by the address in its subject.
    expect(paymentWakeTargets(paymentThanks, null, [{ ...halleck, property_label: null }]).map((r) => r.id)).toEqual(["job-halleck"])
    // A HomeSentry email about something else wakes nothing.
    expect(paymentWakeTargets({ ...paymentThanks, subject: "Your inspector is on the way — 5764 Halleck Dr" }, null, [halleck])).toEqual([])
    expect(paymentWakeTargets({ ...paymentThanks, subject: "Thank you for your payment — 1 Other St" }, null, [halleck, quito])).toEqual([])
  })
  it("only a tapinspect sender wakes anything; only awaiting_payment tapinspect rows are candidates", () => {
    expect(paymentWakeTargets({ ...resultsUpdated, from: { email: "amanda@bakshirealestate.com" } }, cls, [halleck])).toEqual([])
    expect(paymentWakeTargets(resultsUpdated, cls, [{ ...halleck, provider: "docusign" }])).toEqual([])
    expect(paymentWakeTargets(resultsUpdated, cls, [])).toEqual([])
    expect(paymentWakeTargets(resultsUpdated, cls, [{ ...halleck, status: "queued" }])).toEqual([])
  })
  it("addressIn pulls number + street out of a subject", () => {
    expect(addressIn("Inspection results for 5764 Halleck Dr, San Jose, CA 95123")).toBe("5764 Halleck Dr")
    expect(addressIn("Thank you for your payment — 2116 Quito Rd")).toBe("2116 Quito Rd")
    expect(addressIn("93 Ridgeview Ave San Jose CA 95127")).toBe("93 Ridgeview Ave")
    expect(addressIn("Your inspector is on the way")).toBeNull()
    expect(addressIn(null)).toBeNull()
  })
})

describe("the report's file name", () => {
  it("<property> Inspection Report <YYYY-MM-DD> (HomeSentry).pdf — dated in PT so an updated report files as a new version", () => {
    const dest = destinationFor({ property: "5764 Halleck Dr", docType: "inspection", filename: "report.pdf", subject: resultsUpdated.subject, receivedAt: "2026-10-16T18:00:00.000Z", stage: null, seq: 1, source: "tapinspect" })
    expect(dest).toEqual({ folder: "Properties/5764 Halleck Dr/Inspections", name: "5764 Halleck Dr Inspection Report 2026-10-16 (HomeSentry).pdf", stage: null })
    expect(destinationFor({ property: "5764 Halleck Dr", docType: "inspection", filename: "report.pdf", subject: "", receivedAt: "2026-10-17T04:30:00.000Z", stage: null, seq: 1, source: "tapinspect" })?.name).toBe("5764 Halleck Dr Inspection Report 2026-10-16 (HomeSentry).pdf")
    // Attachments and DocuSign pulls keep the sender's name, as before.
    expect(destinationFor({ property: "5764 Halleck Dr", docType: "inspection", filename: "Report 674.pdf", subject: "", receivedAt: "2026-10-16T18:00:00.000Z", stage: null, seq: 1 })?.name).toBe("Report 674.pdf")
    expect(destinationFor({ property: "5764 Halleck Dr", docType: "inspection", filename: "Report 674.pdf", subject: "", receivedAt: "2026-10-16T18:00:00.000Z", stage: null, seq: 1, source: "docusign" })?.name).toBe("Report 674.pdf")
  })
})
