// Inbox agent — documents behind links (briefs/BRIEF_INBOX_LINK_FETCH_2026-10-12.md §5).
// Pure pieces only: provider detection, the click allowlist, ZIP → files,
// documentLinks on a Ridgeview-shaped fixture, the loop fix, URL buttons.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { zipSync } from "fflate"
import { afterEach, describe, expect, it } from "vitest"
import { detectProvider, documentLinks, extractUrls } from "../scripts/inbox-agent/fetch/providers.mjs"
import { CLICK_ALLOW, CLICK_REFUSE, isAllowedClick, mimeFor, pruneScreenshots } from "../scripts/inbox-agent/fetch/browser.mjs"
import { expandDownloads, fetchedFilePath, nextTryAt, readFetchedBytes, saveFetchedBytes, unzipToFiles } from "../scripts/inbox-agent/fetch/index.mjs"
import { gateFromText } from "../scripts/inbox-agent/fetch/docusign.mjs"
import { envelopeMatches, loopEligible, normalizeEnvelope } from "../scripts/inbox-agent/loops.mjs"
import { tgButton, tgKeyboard } from "../scripts/inbox-agent/telegram.mjs"

// The real shapes from the Ridgeview Completed email (gmail 1a1135bbe462b5b1, 2026-10-06).
const EMAIL_START = "https://na4.docusign.net/Signing/EmailStart.aspx?a=9c1f2e0a-6b7d-4f1e-8a2b-3c4d5e6f7a8b&etti=24&r=1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b"
const IN_SESSION = "https://na4.docusign.net/Signing/?ti=abc123def456"
const APP_LINK = "https://app.docusign.com/documents/details/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b"
const FOOTER = [
  "https://protect.docusign.net/products/esignature",
  "https://support.docusign.com/s/document-item?language=en_US&bundleId=pik1583277475390",
  "https://www.docusign.com/company/privacy-policy",
  "https://www.docusign.com/",
  "https://na4.docusign.net/Member/EmailOptOut.aspx?tok=abc",
  "https://account.docusign.com/signup",
  "https://go.docusign.com/o/trial",
]

describe("detectProvider", () => {
  it("recognises both DocuSign recipient link shapes and the app link", () => {
    expect(detectProvider(EMAIL_START)).toBe("docusign")
    expect(detectProvider(IN_SESSION)).toBe("docusign")
    expect(detectProvider("https://demo.docusign.net/Signing/EmailStart.aspx?a=1&etti=2&r=3")).toBe("docusign")
    expect(detectProvider(APP_LINK)).toBe("docusign")
    expect(detectProvider(EMAIL_START.toUpperCase().replace("HTTPS", "https"))).toBe("docusign")
  })
  it("ignores footer / support / protect / unsubscribe links and non-URLs", () => {
    for (const u of FOOTER) expect(detectProvider(u), u).toBeNull()
    expect(detectProvider("https://na4.docusign.net/")).toBeNull()
    expect(detectProvider("https://docs.google.com/document/d/abc")).toBeNull()
    expect(detectProvider("mailto:dse_na4@docusign.net")).toBeNull()
    expect(detectProvider("not a url")).toBeNull()
    expect(detectProvider("")).toBeNull()
    expect(detectProvider(null)).toBeNull()
    expect(detectProvider("https://evil.example.com/?u=https://na4.docusign.net/Signing/")).toBeNull()
    expect(detectProvider("https://na4.docusign.net.evil.io/Signing/EmailStart.aspx?a=1")).toBeNull()
  })
})

describe("extractUrls / documentLinks", () => {
  const ridgeview = {
    id: "1a1135bbe462b5b1",
    from: { email: "dse_na4@docusign.net", name: "Ryan Nickell via DocuSign" },
    subject: "Completed: Please Sign: 93 Ridgeview Ave - Disclosures",
    text: [
      "Ryan Nickell",
      "All parties have completed Please Sign: 93 Ridgeview Ave - Disclosures.",
      "",
      `VIEW COMPLETED DOCUMENTS (${EMAIL_START})`,
      "",
      "Ryan Nickell",
      "ryan@nickellrealty.com",
      "",
      "Do Not Share This Email",
      "This email contains a secure link to DocuSign. Please do not share this email, link, or access code with others.",
      "",
      "About DocuSign",
      "Sign documents electronically in just minutes. It's safe, secure, and legally binding. https://www.docusign.com/",
      "Questions about the Document? If you need to modify the document or have questions about the details in the document, please reach out to the sender by emailing them directly.",
      "If you are having trouble signing the document, please visit the Help with Signing page on our Support Center. https://support.docusign.com/s/document-item?language=en_US&bundleId=pik1583277475390",
      "Download the DocuSign App https://go.docusign.com/o/mobile",
      "This message was sent to you by Ryan Nickell who is using the DocuSign Electronic Signature Service. https://protect.docusign.net/products/esignature",
      "Unsubscribe: https://na4.docusign.net/Member/EmailOptOut.aspx?tok=abc.",
    ].join("\n"),
    attachments: [],
  }
  it("pulls every URL out of plain text, stripping the wrapping punctuation", () => {
    const urls = extractUrls(ridgeview.text)
    expect(urls[0]).toBe(EMAIL_START)
    expect(urls).toContain("https://na4.docusign.net/Member/EmailOptOut.aspx?tok=abc")
    expect(urls.every((u) => !/[.)]$/.test(u))).toBe(true)
  })
  it("finds exactly the envelope link in the Ridgeview Completed email", () => {
    expect(documentLinks(ridgeview)).toEqual([{ url: EMAIL_START, provider: "docusign" }])
  })
  it("merges classifier-reported links, de-duplicated, and drops unknown providers", () => {
    const out = documentLinks(ridgeview, [EMAIL_START, APP_LINK, "https://disclosures.io/x/abc"])
    expect(out.map((l) => l.url)).toEqual([EMAIL_START, APP_LINK])
  })
  it("returns nothing for an email with only footer links", () => {
    expect(documentLinks({ text: FOOTER.join("\n") })).toEqual([])
    expect(documentLinks({})).toEqual([])
  })
})

describe("click allowlist", () => {
  it("allows exactly the labels the brief names", () => {
    for (const label of ["Continue", "CONTINUE", "Review Documents", "Review Document", "REVIEW DOCUMENTS", "Other Actions", "OTHER ACTIONS", "Print & Download", "Print and Download", "Download", "DOWNLOAD", "Combined PDF", "Separate PDFs", "Separate", "Combined", "Close", "Finish Later", "FINISH LATER", "Got it", "OK", "Okay", "Validate"]) {
      expect(isAllowedClick(label).ok, label).toBe(true)
    }
    expect(CLICK_ALLOW.length).toBeGreaterThan(8)
  })
  it("refuses everything that could sign, adopt, finish, submit, decline or complete", () => {
    for (const label of ["Sign", "SIGN HERE", "Sign Now", "Adopt and Sign", "Adopt Signature", "Finish", "FINISH", "Submit", "Decline", "Decline to Sign", "Agree and Sign", "Complete", "Mark Complete", "Sign in", "Log in with DocuSign", "Initial"]) {
      const r = isAllowedClick(label)
      expect(r.ok, label).toBe(false)
    }
    expect(CLICK_REFUSE.test("Finish")).toBe(true)
    expect(CLICK_REFUSE.test("Finish Later")).toBe(false)
  })
  it("refuses labels that merely are not on the list, and empty labels", () => {
    expect(isAllowedClick("Next").ok).toBe(false)
    expect(isAllowedClick("Save").ok).toBe(false)
    expect(isAllowedClick("Assign to Someone Else").ok).toBe(false)
    expect(isAllowedClick("").ok).toBe(false)
    expect(isAllowedClick("Download…").ok).toBe(true) // trailing ellipsis / icon glyphs are stripped
    expect(isAllowedClick("⬇ Download").ok).toBe(true)
  })
})

describe("ZIP → files", () => {
  const pdf = (n: number) => Buffer.from(`%PDF-1.4\n% doc ${n}\n%%EOF`)
  it("expands a Separate PDFs zip into one file per document, basename only, keeping DocuSign's names", () => {
    const zip = zipSync({
      "93 Ridgeview Ave - Disclosures/[TDS] Real Estate Transfer Disclosure Statement.pdf": new Uint8Array(pdf(1)),
      "93 Ridgeview Ave - Disclosures/[SPQ] Seller Property Questionnaire.pdf": new Uint8Array(pdf(2)),
      "93 Ridgeview Ave - Disclosures/[AVID] Agent Visual Inspection Disclosure.pdf": new Uint8Array(pdf(3)),
      "93 Ridgeview Ave - Disclosures/Summary.pdf": new Uint8Array(pdf(4)),
      "__MACOSX/._junk.pdf": new Uint8Array([1, 2, 3]),
      "93 Ridgeview Ave - Disclosures/": new Uint8Array(0),
    })
    const files = unzipToFiles(Buffer.from(zip))
    expect(files.map((f) => f.filename)).toEqual([
      "[TDS] Real Estate Transfer Disclosure Statement.pdf",
      "[SPQ] Seller Property Questionnaire.pdf",
      "[AVID] Agent Visual Inspection Disclosure.pdf",
      "Summary.pdf",
    ])
    expect(files.every((f) => f.mime === "application/pdf")).toBe(true)
    expect(Buffer.from(files[1].bytes).toString()).toContain("doc 2")
  })
  it("suffixes duplicate names and expandDownloads passes non-zips through", () => {
    const zip = zipSync({ "a/Summary.pdf": new Uint8Array(pdf(1)), "b/Summary.pdf": new Uint8Array(pdf(2)) })
    expect(unzipToFiles(Buffer.from(zip)).map((f) => f.filename)).toEqual(["Summary.pdf", "Summary (2).pdf"])
    const out = expandDownloads([
      { filename: "Disclosures.zip", mime: "application/octet-stream", bytes: Buffer.from(zip) },
      { filename: "Combined.pdf", mime: "application/octet-stream", bytes: pdf(9) },
    ])
    expect(out.map((f) => f.filename)).toEqual(["Summary.pdf", "Summary (2).pdf", "Combined.pdf"])
    expect(out[2].mime).toBe("application/pdf")
  })
  it("mimeFor sniffs magic bytes before trusting the extension", () => {
    expect(mimeFor("x.bin", pdf(1))).toBe("application/pdf")
    expect(mimeFor("x.pdf", Buffer.from("PK\u0003\u0004abc", "latin1"))).toBe("application/zip")
    expect(mimeFor("list.csv", Buffer.from("a,b"))).toBe("text/csv")
    expect(mimeFor("weird.xyz", Buffer.from("zz"))).toBe("application/octet-stream")
  })
})

describe("fetch store, backoff, screenshot pruning", () => {
  const tmp: string[] = []
  afterEach(() => {
    for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })
  it("keeps bytes under <store>/<fetchId>/<sha256> and reads them back", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-fetch-store-"))
    tmp.push(root)
    const bytes = Buffer.from("%PDF-1.4 hello")
    const file = saveFetchedBytes("11111111-2222-3333-4444-555555555555", bytes, root)
    const sha = path.basename(file)
    expect(sha).toMatch(/^[0-9a-f]{64}$/)
    expect(fetchedFilePath("11111111-2222-3333-4444-555555555555", sha, root)).toBe(file)
    expect(readFetchedBytes("11111111-2222-3333-4444-555555555555", sha, root).equals(bytes)).toBe(true)
    expect(() => readFetchedBytes("nope", sha, root)).toThrow(/missing on disk/)
  })
  it("retries after 5 min, then 30 min, then gives up", () => {
    const now = Date.UTC(2026, 9, 12, 12, 0, 0)
    expect(nextTryAt(1, now)).toBe(new Date(now + 5 * 60_000).toISOString())
    expect(nextTryAt(2, now)).toBe(new Date(now + 30 * 60_000).toISOString())
    expect(nextTryAt(3, now)).toBeNull()
  })
  it("prunes screenshot dirs down to the newest N jobs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-fetch-shots-"))
    tmp.push(root)
    for (let i = 0; i < 6; i++) {
      const d = path.join(root, `job-${i}`)
      fs.mkdirSync(d)
      const t = new Date(Date.now() - (6 - i) * 60_000)
      fs.utimesSync(d, t, t)
    }
    const removed = pruneScreenshots(root, 4)
    expect(removed.sort()).toEqual(["job-0", "job-1"])
    expect(fs.readdirSync(root).sort()).toEqual(["job-2", "job-3", "job-4", "job-5"])
    expect(pruneScreenshots(path.join(root, "does-not-exist"), 4)).toEqual([])
  })
})

describe("DocuSign gates from page text", () => {
  it("names the gate the page is showing", () => {
    expect(gateFromText("Please review the documents below. ☐ I agree to use electronic records and signatures. CONTINUE")).toBe("consent")
    expect(gateFromText("Enter the access code the sender gave you. Access code: [    ] VALIDATE")).toBe("access_code")
    expect(gateFromText("Verify your identity. We'll text you a code to the number on file.")).toBe("login")
    expect(gateFromText("Sign in to view this envelope.")).toBe("login")
    expect(gateFromText("This envelope has expired. Please contact the sender.")).toBe("expired")
    expect(gateFromText("This envelope has been voided by the sender and can no longer be accessed.")).toBe("expired")
    expect(gateFromText("Completed: 93 Ridgeview Ave - Disclosures. OTHER ACTIONS. Download")).toBeNull()
  })
})

describe("loop fix — completions never open a loop, always close one", () => {
  it("docusign_completed / esign_completed are never loop-eligible", () => {
    expect(loopEligible("docusign_completed")).toBe(false)
    expect(loopEligible("esign_completed")).toBe(false)
    expect(loopEligible("docusign_request")).toBe(true)
    expect(loopEligible("human")).toBe(true)
  })
  it("normalizeEnvelope strips every stacked prefix", () => {
    expect(normalizeEnvelope("Please Sign: 93 Ridgeview Ave - Disclosures")).toBe("93ridgeviewavedisclosures")
    expect(normalizeEnvelope("Completed: Please Sign: 93 Ridgeview Ave - Disclosures")).toBe("93ridgeviewavedisclosures")
    expect(normalizeEnvelope("Re: Reminder: Please DocuSign: 93 Ridgeview Ave - Disclosures")).toBe("93ridgeviewavedisclosures")
    expect(normalizeEnvelope("Fwd: Completed: 2116 Quito Rd - OFFER")).toBe("2116quitordoffer")
  })
  it("matches a Completed email against the loop its request opened — and the loop a Completed email wrongly opened", () => {
    expect(envelopeMatches("Please Sign: 93 Ridgeview Ave - Disclosures", "Completed: Please Sign: 93 Ridgeview Ave - Disclosures")).toBe(true)
    expect(envelopeMatches("Completed: Please Sign: 93 Ridgeview Ave - Disclosures", "Completed: Please Sign: 93 Ridgeview Ave - Disclosures")).toBe(true)
    expect(envelopeMatches("Please Sign: 2116 Quito Rd - OFFER", "Completed: Please Sign: 93 Ridgeview Ave - Disclosures")).toBe(false)
    expect(envelopeMatches("", "Completed: X")).toBe(false)
  })
})

describe("Telegram buttons", () => {
  it("maps {text,url} to a URL button and {text,data} to a callback button", () => {
    expect(tgButton({ text: "Open in DocuSign", url: EMAIL_START })).toEqual({ text: "Open in DocuSign", url: EMAIL_START })
    expect(tgButton({ text: "🔁 Retry", data: "ix:fr:abc" })).toEqual({ text: "🔁 Retry", callback_data: "ix:fr:abc" })
    expect(tgKeyboard([[{ text: "Open", url: EMAIL_START }, { text: "🔁 Retry", data: "ix:fr:abc" }]])).toEqual({ inline_keyboard: [[{ text: "Open", url: EMAIL_START }, { text: "🔁 Retry", callback_data: "ix:fr:abc" }]] })
  })
})
