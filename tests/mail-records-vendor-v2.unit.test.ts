import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { normApn } from "@/lib/mailMatch"
import { parseCsv, parseCsvTable, stripBom } from "@/lib/csv"
import {
  REQUIRED_HEADERS,
  V2_COLUMNS,
  WRITTEN_COLUMNS,
  buildReport,
  buildV2Index,
  checkHeaders,
  formatReport,
  matchRecords,
  parseDate,
  parseExemption,
  parseNumeric,
  parseYN,
  rowToUpdate,
  splitParcels,
  type MailRecordJoinRow,
} from "@/lib/mailRecordsV2"

// Vendor v2 join (brief BRIEF_NOO_Q4_VENDOR_V2_JOIN_2026-10-14 §2c). Pure — no database.

const FIXTURE = path.resolve(__dirname, "fixtures/vendor_v2_sample.csv")
const fixtureText = () => fs.readFileSync(FIXTURE, "utf8")
const NOW = "2026-10-14T20:00:00.000Z"

const rec = (o: Partial<MailRecordJoinRow> & { record_id: string }): MailRecordJoinRow => ({
  id: `id-${o.record_id}`,
  arm: "A",
  parcel_number: null,
  parcels: null,
  parcel_count: null,
  sale_date: null,
  owner_name: null,
  is_seed: false,
  ...o,
})

describe("normApn", () => {
  it("strips dashes, spaces and anything outside [0-9A-Z]", () => {
    expect(normApn("050-273-520")).toBe("050273520")
    expect(normApn("058 702 030")).toBe("058702030")
    expect(normApn(" 012-345-67.8 ")).toBe("012345678")
  })
  it("uppercases letters", () => {
    expect(normApn("123-abc-45")).toBe("123ABC45")
  })
  it("leaves an already-normalized key alone and maps blanks to empty", () => {
    expect(normApn("050273520")).toBe("050273520")
    expect(normApn("")).toBe("")
    expect(normApn(null)).toBe("")
    expect(normApn(undefined)).toBe("")
  })
})

describe("lib/csv parseCsv", () => {
  it("strips a leading BOM and keeps RFC 4180 quoting", () => {
    const rows = parseCsv('﻿"a","b,c",d\r\n"x ""q""","line\nbreak",\n')
    expect(rows).toEqual([["a", "b,c", "d"], ['x "q"', "line\nbreak", ""]])
    expect(stripBom("﻿x")).toBe("x")
    expect(stripBom("x")).toBe("x")
  })
  it("parses the committed fixture: BOM gone, 63 headers, 3 rows", () => {
    const t = parseCsvTable(fixtureText())
    expect(t.header[0]).toBe("Parcel Number")
    expect(t.header.length).toBe(63)
    expect(t.rows.length).toBe(3)
    expect(t.rows[0]["Parcel Number"]).toBe("001-001-001")
    expect(t.rows[1]["Tax Delinquent Year(s)"]).toBe("2025, 2024")
  })
  it("rejects a body row with the wrong field count", () => {
    expect(() => parseCsvTable("a,b\n1,2,3\n")).toThrow(/wrong field count/)
  })
})

describe("checkHeaders", () => {
  it("accepts the fixture and reports only extras", () => {
    const { header } = parseCsvTable(fixtureText())
    const c = checkHeaders(header)
    expect(c.missing).toEqual([])
    expect(c.extra).toContain("Site Address")
    expect(c.extra).not.toContain("Deed Type")
  })
  it("names every missing required header", () => {
    const c = checkHeaders(["Parcel Number", "Owner Name"])
    expect(c.missing).toContain("Sale Date")
    expect(c.missing).toContain("Loan Amount 2nd")
    expect(c.missing.length).toBe(REQUIRED_HEADERS.length - 2)
  })
  it("requires the 3 keys + 20 v2 columns", () => {
    expect(REQUIRED_HEADERS.length).toBe(23)
    expect(V2_COLUMNS.length).toBe(23) // 20 new + vendor_v2_sale_date + vendor_v2_owner_name + homeowner_exemption (derived)
  })
})

describe("cell parsers", () => {
  it("Y/N/blank booleans", () => {
    expect(parseYN("Y")).toBe(true)
    expect(parseYN("y")).toBe(true)
    expect(parseYN("N")).toBe(false)
    expect(parseYN("")).toBeNull()
    expect(parseYN("  ")).toBeNull()
    expect(parseYN("maybe")).toBeNull()
  })
  it("homeowner exemption from the code", () => {
    expect(parseExemption("Yes (H)")).toBe(true)
    expect(parseExemption("None")).toBe(false)
    expect(parseExemption("")).toBeNull()
  })
  it("MM/DD/YYYY dates", () => {
    expect(parseDate("08/20/2026")).toBe("2026-08-20")
    expect(parseDate("1/5/2026")).toBe("2026-01-05")
    expect(parseDate("")).toBeNull()
    expect(parseDate("2026-08-20")).toBeNull()
    expect(parseDate("13/01/2026")).toBeNull()
  })
  it("numerics with blanks and formatting", () => {
    expect(parseNumeric("6500.50")).toBe(6500.5)
    expect(parseNumeric("")).toBeNull()
    expect(parseNumeric("$1,250,000")).toBe(1250000)
    expect(parseNumeric("n/a")).toBeNull()
  })
})

describe("rowToUpdate", () => {
  const rows = () => parseCsvTable(fixtureText()).rows

  it("maps a fully populated row (fixture row 1)", () => {
    const u = rowToUpdate(rows()[0], "ALL SM Co NOO SFR 11+ yr.csv", NOW)
    expect(u).toMatchObject({
      deed_type: "Grant Deed",
      non_dollar_sale_date: "2010-03-01",
      non_dollar_doc_number: "2010-000001",
      tax_delinquent: false,
      tax_delinquent_years: null,
      tax_amount: 4000,
      tax_exemption_code: "None",
      homeowner_exemption: false,
      loan_amount: 180000,
      loan_amount_2nd: null,
      loan_type: "O",
      owner_type_vendor: null,
      assessed_improvement_value: 150000,
      total_assessed_value: 250000,
      total_market_value: null,
      distressed_status: null,
      prior_sale_date: "1990-06-01",
      prior_sales_price: 120000,
      prior_buyer1_last: "Older",
      effective_year_built: 1970,
      air_conditioning: "N",
      vendor_v2_sale_date: "1999-01-15",
      vendor_v2_owner_name: "Test Owner One",
      vendor_v2_at: NOW,
      vendor_v2_file: "ALL SM Co NOO SFR 11+ yr.csv",
    })
  })
  it("maps the delinquent / exempt / distressed row (fixture row 2) with blanks as null", () => {
    const u = rowToUpdate(rows()[1], "f.csv", NOW)
    expect(u.tax_delinquent).toBe(true)
    expect(u.tax_delinquent_years).toBe("2025, 2024")
    expect(u.tax_amount).toBe(6500.5)
    expect(u.tax_exemption_code).toBe("Yes (H)")
    expect(u.homeowner_exemption).toBe(true)
    expect(u.loan_amount).toBeNull()
    expect(u.loan_type).toBeNull()
    expect(u.owner_type_vendor).toBe("T")
    expect(u.distressed_status).toBe("Nod")
    expect(u.prior_sale_date).toBeNull()
    expect(u.prior_sales_price).toBeNull()
    expect(u.effective_year_built).toBeNull()
    expect(u.air_conditioning).toBe("C")
    expect(u.deed_type).toBeNull()
    expect(u.vendor_v2_sale_date).toBe("1984-06-13")
  })
  it("blank Tax Delinquent → null, Owner Type C kept (fixture row 3)", () => {
    const u = rowToUpdate(rows()[2], "f.csv", NOW)
    expect(u.tax_delinquent).toBeNull()
    expect(u.homeowner_exemption).toBe(false)
    expect(u.owner_type_vendor).toBe("C")
    expect(u.loan_amount_2nd).toBe(50000)
    expect(u.prior_sale_date).toBe("2026-10-01")
    expect(u.air_conditioning).toBeNull()
  })
  it("never carries sale_date / owner_name / raw keys; raw_v2 is the verbatim row", () => {
    const row = rows()[0]
    const u = rowToUpdate(row, "f.csv", NOW)
    expect("sale_date" in u).toBe(false)
    expect("owner_name" in u).toBe(false)
    expect("raw" in u).toBe(false)
    expect("owner_type" in u).toBe(false)
    expect(u.vendor_v2_sale_date).toBe("1999-01-15")
    expect(u.raw_v2).toEqual(row)
    expect(Object.keys(u.raw_v2 as object).length).toBe(63)
    expect(Object.keys(u).sort()).toEqual([...WRITTEN_COLUMNS].sort())
  })
  it("tolerates whitespace around text codes", () => {
    const u = rowToUpdate({ "Deed Type": "  Gift Deed ", "Tax Delinquent": " y ", "Tax Exemption Code": " yes (H)" }, "f.csv", NOW)
    expect(u.deed_type).toBe("Gift Deed")
    expect(u.tax_delinquent).toBe(true)
    expect(u.homeowner_exemption).toBe(true)
  })
})

describe("buildV2Index", () => {
  it("keys rows by normalized APN and remembers the file", () => {
    const idx = buildV2Index([{ file: "a.csv", rows: [{ "Parcel Number": "001-001-001" }] }, { file: "b.csv", rows: [{ "Parcel Number": "002 002 002" }] }])
    expect(idx.byApn.get("001001001")?.file).toBe("a.csv")
    expect(idx.byApn.get("002002002")?.file).toBe("b.csv")
    expect(idx.blankApn).toBe(0)
  })
  it("fails on a duplicate APN across files, counts blank APNs", () => {
    expect(() => buildV2Index([
      { file: "a.csv", rows: [{ "Parcel Number": "001-001-001" }] },
      { file: "b.csv", rows: [{ "Parcel Number": "001001001" }] },
    ])).toThrow(/duplicate normalized APN 001001001/)
    expect(buildV2Index([{ file: "a.csv", rows: [{ "Parcel Number": "" }] }]).blankApn).toBe(1)
  })
})

describe("matchRecords", () => {
  const index = () => buildV2Index([{ file: "sm.csv", rows: parseCsvTable(fixtureText()).rows }])
  it("primary hit on normalized parcel_number", () => {
    const m = matchRecords([rec({ record_id: "NOO26-1", parcel_number: "001001001" })], index())
    expect(m.matched.length).toBe(1)
    expect(m.matched[0].via).toBe("primary")
    expect(m.matched[0].v2.row["Owner Name"]).toBe("Test Owner One")
    expect(m.unmatched).toEqual([])
    expect(m.v2NotInRecords).toBe(2)
  })
  it("secondary-parcel hit walks `parcels` in order", () => {
    const m = matchRecords([rec({ record_id: "NOO26-2", parcel_number: "999-999-999", parcels: "888-888-888|001-001-002|001-001-003", parcel_count: 3 })], index())
    expect(m.matched.length).toBe(1)
    expect(m.matched[0].via).toBe("secondary_parcel")
    expect(m.matched[0].v2.apn).toBe("001001002")
    expect(splitParcels("888-888-888|001-001-002||")).toEqual(["888888888", "001001002"])
  })
  it("miss lands in unmatched", () => {
    const m = matchRecords([rec({ record_id: "NOO26-3", parcel_number: "999-999-999", parcels: "999-999-999" })], index())
    expect(m.matched).toEqual([])
    expect(m.unmatched.map(r => r.record_id)).toEqual(["NOO26-3"])
    expect(m.v2NotInRecords).toBe(3)
  })
  it("seeds and blank parcels are skipped, not unmatched", () => {
    const m = matchRecords([
      rec({ record_id: "SEED-1", parcel_number: "001-001-001", is_seed: true }),
      rec({ record_id: "NOO26-4", parcel_number: "" }),
      rec({ record_id: "NOO26-5", parcel_number: null }),
    ], index())
    expect(m.matched).toEqual([])
    expect(m.unmatched).toEqual([])
    expect(m.seeds.map(r => r.record_id)).toEqual(["SEED-1", "NOO26-4", "NOO26-5"])
  })
})

describe("buildReport", () => {
  it("counts matches, drift and fill rates on the fixture", () => {
    const files = [{ file: "sm.csv", rows: parseCsvTable(fixtureText()).rows }]
    const index = buildV2Index(files)
    const records = [
      rec({ record_id: "NOO26-1", parcel_number: "001-001-001", sale_date: "1999-01-15", owner_name: "Test Owner One" }),
      rec({ record_id: "NOO26-2", parcel_number: "001-001-002", sale_date: "1980-01-01", owner_name: "Sample Family Trust" }),
      rec({ record_id: "NOO26-3", parcel_number: "001-001-003", sale_date: "2005-11-02", owner_name: "Old Owner" }),
      rec({ record_id: "NOO26-4", parcel_number: "777-777-777" }),
      rec({ record_id: "SEED-1", parcel_number: "001-001-001", is_seed: true }),
    ]
    const match = matchRecords(records, index)
    const updates = match.matched.map(m => rowToUpdate(m.v2.row, m.v2.file, NOW))
    const r = buildReport(files, index, records, match, updates)
    expect(r.rowsPerFile).toEqual({ "sm.csv": 3 })
    expect(r.recordsTotal).toBe(5)
    expect(r.matched).toBe(3)
    expect(r.matchedViaSecondaryParcel).toBe(0)
    expect(r.unmatchedRecordIds).toEqual(["NOO26-4"])
    expect(r.seedsSkipped).toBe(1)
    expect(r.v2NotInRecords).toBe(0)
    expect(r.saleDateDrift).toEqual([{ record_id: "NOO26-2", sale_date: "1980-01-01", vendor_v2_sale_date: "1984-06-13" }])
    expect(r.ownerNameChanged).toBe(1)
    expect(r.fillRate.tax_delinquent).toBeCloseTo(2 / 3)
    expect(r.fillRate.total_market_value).toBe(0)
    expect(r.fillRate.vendor_v2_sale_date).toBe(1)
    expect(r.distributions.homeowner_exemption).toEqual({ true: 1, false: 2 })
    expect(r.distributions.tax_delinquent).toEqual({ false: 1, true: 1, null: 1 })
    expect(r.distributions.owner_type_vendor).toEqual({ null: 1, T: 1, C: 1 })
    const text = formatReport(r)
    expect(text).toContain("unmatched: 1 — NOO26-4")
    expect(text).toContain("NOO26-2: 1980-01-01 → 1984-06-13")
    expect(text).toContain("vendor_v2_owner_name ≠ owner_name: 1")
  })
})
