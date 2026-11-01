// Inbox agent — the same disclosure sent twice is filed once (Ryan 2026-11-01).
// 2116 Quito Rd's DocuSign "Completed" email carried ten PDFs as attachments and
// the link fetcher pulled the same envelope; DocuSign regenerates every PDF so
// the bytes differed by 0–3 bytes and neither sha256 nor md5 matched. A second
// envelope then re-sent the NHD as "… (1) (1).pdf" with DocuSign's Summary.pdf.
import { describe, expect, it } from "vitest"
import { DOCUSIGN_SUMMARY_RE, driveNamesakeOf, normalizeDocName, refineDocType, sameDocName } from "../scripts/inbox-agent/filing.mjs"

// Real names + sizes from inbox_files (attachment copy, DocuSign-fetched copy).
const PAIRS: Array<[string, number, string, number]> = [
  ["Market Conditions Advisory - 624.pdf", 294702, "Market_Conditions_Advisory_-_6_24.pdf", 294697],
  ["Seller Property Questionnaire #1 - 626.pdf", 428146, "Seller_Property_Questionnaire__1_-_6_26.pdf", 428146],
  ["Real Estate Transfer Disclosure Statement #1 - 624.pdf", 465586, "Real_Estate_Transfer_Disclosure_Statement__1_-_6_24.pdf", 465583],
  ["Megans Law Data Base Disclosure - 623.pdf", 293480, "Megans_Law_Data_Base_Disclosure_-_6_23.pdf", 293477],
  ["Lead-Based Paint and Lead-Based Paint Hazards Disclosure #1 - 626.pdf", 336269, "Lead-Based_Paint_and_Lead-Based_Paint_Hazards_Disclosure__1_-_6_26.pdf", 336269],
  ["Water Heater and Smoke Detector Statement of Compliance - 1223.pdf", 319432, "Water_Heater_and_Smoke_Detector_Statement_of_Compliance_-_12_23.pdf", 319431],
  ["Water-Conserving Plum. Fixtures & Carbon Monoxide Det. Notice - 624.pdf", 290923, "Water-Conserving_Plum._Fixtures_&_Carbon_Monoxide_Det._Notice_-_6_24.pdf", 290921],
  ["Statewide Buyer and Seller Advisory - 626.pdf", 491581, "Statewide_Buyer_and_Seller_Advisory_-_6_26.pdf", 491584],
  ["3_ConsolidatedSignature_2116 QUITO RD_3653105_JCP.pdf", 628396, "3_ConsolidatedSignature_2116_QUITO_RD_3653105_JCP.pdf", 628397],
  ["fire_hardening_and_defensible_space_advisory_disclosure_and_addendum__625_ts87327.pdf", 384276, "fire_hardening_and_defensible_space_advisory_disclosure_and_addendum__625_ts87327.pdf", 384276],
]
const FOLDER = "Properties/2116 Quito Rd/Disclosures"
const filed = PAIRS.map(([name, size], i) => ({ id: `f${i}`, name, size, md5Checksum: `m${i}`, webViewLink: null, path: `${FOLDER}/${name}` }))

describe("normalizeDocName / sameDocName", () => {
  it("every DocuSign-fetched name equals its attachment twin", () => {
    for (const [a, , b] of PAIRS) expect(sameDocName(a, b), `${a} vs ${b}`).toBe(true)
  })
  it("a re-sent copy with (1) (1) is the same name", () => {
    expect(sameDocName("3_ConsolidatedSignature_2116 QUITO RD_3653105_JCP (1) (1).pdf", "3_ConsolidatedSignature_2116_QUITO_RD_3653105_JCP.pdf")).toBe(true)
    expect(normalizeDocName("Report 674 copy.PDF")).toBe("report674")
  })
  it("different documents stay different; tiny names never match", () => {
    expect(sameDocName("Seller Property Questionnaire #1 - 626.pdf", "Seller Property Questionnaire #2 - 626.pdf")).toBe(false)
    expect(sameDocName("Lead-Based Paint Disclosure.pdf", "Lead-Based Paint Addendum.pdf")).toBe(false)
    expect(sameDocName("a.pdf", "a.pdf")).toBe(false)
    expect(sameDocName("", "")).toBe(false)
  })
})

describe("driveNamesakeOf — same name, same size (±0.5%) = the same document", () => {
  it("each fetched copy hits the attachment copy already in Drive", () => {
    for (const [a, , b, size] of PAIRS) {
      const hit = driveNamesakeOf({ name: b, size }, filed)
      expect(hit?.same, b).toBe(true)
      expect(hit?.file.name).toBe(a)
    }
  })
  it("the next day's re-send of the NHD (22 KB bigger, re-signed) is a namesake but not the same bytes → a new version", () => {
    const hit = driveNamesakeOf({ name: "3_ConsolidatedSignature_2116 QUITO RD_3653105_JCP (1) (1).pdf", size: 650605 }, filed)
    expect(hit?.same).toBe(false)
    expect(hit?.file.path).toBe(`${FOLDER}/3_ConsolidatedSignature_2116 QUITO RD_3653105_JCP.pdf`)
  })
  it("nothing on file with that name → null; no size → namesake only", () => {
    expect(driveNamesakeOf({ name: "Earthquake Hazards Disclosure.pdf", size: 100_000 }, filed)).toBeNull()
    expect(driveNamesakeOf({ name: "Market Conditions Advisory - 624.pdf", size: null }, filed)?.same).toBe(false)
    expect(driveNamesakeOf({ name: "Market Conditions Advisory - 624.pdf", size: 294702 }, [])).toBeNull()
  })
  it("the floor lets small PDFs differ by a few hundred bytes", () => {
    expect(driveNamesakeOf({ name: "tiny notice.pdf", size: 20_300 }, [{ id: "t", name: "Tiny Notice.pdf", size: 20_000, path: "x/Tiny Notice.pdf" }])?.same).toBe(true)
    expect(driveNamesakeOf({ name: "tiny notice.pdf", size: 21_000 }, [{ id: "t", name: "Tiny Notice.pdf", size: 20_000, path: "x/Tiny Notice.pdf" }])?.same).toBe(false)
  })
})

describe("DocuSign's Summary.pdf is the envelope certificate, not a disclosure", () => {
  it("on a DocuSign email it is 'other' whatever the classifier said", () => {
    expect(DOCUSIGN_SUMMARY_RE.test("Summary.pdf")).toBe(true)
    expect(refineDocType("Summary.pdf", "disclosure", "dse_na4@docusign.net", "Completed: Complete with Docusign: Checkboxes on Earthquake Disclosure")).toBe("other")
  })
  it("a Summary.pdf from anyone else is left to the classifier", () => {
    expect(refineDocType("Summary.pdf", "inspection", "inspector@example.com", "Your inspection results")).toBe("inspection")
  })
})
