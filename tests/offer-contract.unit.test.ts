import { describe, it, expect } from "vitest"
import { PDFDocument, StandardFonts } from "pdf-lib"
import {
  DEFAULT_EXPIRATION_DAYS,
  DEFAULT_EXPIRATION_TIME,
  addDays,
  blankFields,
  daysBetween,
  expirationLabel,
  fieldsFromInput,
  fillOfferPdf,
  finishParse,
  formatDateMMDDYYYY,
  formatExpirationTime,
  formatMoney,
  formatPhone,
  missingFields,
  normalizeExpiration,
  normalizeExpirationTime,
  normalizeModelOffer,
  offerDriveRelPath,
  offerFilename,
  parseExpirationDate,
  parseExpirationDays,
  parseExpirationTime,
  parseMoney,
  pdfFieldValues,
  resolveExpiration,
  streetFromAddress,
  todayPT,
  traceStipulations,
  validateFields,
  type OfferFields,
} from "@/lib/offerContract"
import { signTelegramInitData, validateTelegramInitData } from "@/lib/telegramWebApp"
import { newDraft, renderOfferCard } from "@/lib/offerBot"

// briefs/OFFER_BOT.md — Tests section. Everything here is offline: the PDF
// fixture is built in the test with pdf-lib, initData is signed with a fake
// token. The real template, Drive and Telegram are exercised from the Mac
// mini after merge.

describe("parseMoney — shorthand handled in code, never by the model", () => {
  it.each([
    ["1.52M", 1_520_000],
    ["1.52mm", 1_520_000],
    ["$1.52 million", 1_520_000],
    ["1.2 mil", 1_200_000],
    ["1520k", 1_520_000],
    ["1,520,000", 1_520_000],
    ["1520000", 1_520_000],
    ["1,520,000.00", 1_520_000],
    ["10k", 10_000],
    ["$10,000", 10_000],
    ["10 thousand", 10_000],
    ["USD 450,000", 450_000],
    ["  1.2M  ", 1_200_000],
    ["1.25M", 1_250_000],
    ["999.5k", 999_500],
  ])("%s → %d", (raw, expected) => {
    expect(parseMoney(raw)).toBe(expected)
  })

  it("rejects percentages, words and ambiguous bare numbers (ask instead)", () => {
    expect(parseMoney("2.5%")).toBeNull()
    expect(parseMoney("2.5 %")).toBeNull()
    expect(parseMoney("ten thousand")).toBeNull()
    expect(parseMoney("1.2")).toBeNull() // 1.2M or $1.20? ask
    expect(parseMoney("450")).toBeNull()
    expect(parseMoney("")).toBeNull()
    expect(parseMoney(null)).toBeNull()
    expect(parseMoney(undefined)).toBeNull()
    expect(parseMoney("1.2M or 1.3M")).toBeNull()
    expect(parseMoney("-10k")).toBeNull()
  })

  it("accepts numbers as numbers", () => {
    expect(parseMoney(1_520_000)).toBe(1_520_000)
    expect(parseMoney(0)).toBeNull()
  })
})

describe("formatting", () => {
  it("formats money with thousands separators and cents, no $", () => {
    expect(formatMoney(1_520_000)).toBe("1,520,000.00")
    expect(formatMoney(10_000)).toBe("10,000.00")
    expect(formatMoney(999_500.5)).toBe("999,500.50")
  })

  it("formats phones as (408) 555-1234", () => {
    expect(formatPhone("408-555-1234")).toBe("(408) 555-1234")
    expect(formatPhone("4085551234")).toBe("(408) 555-1234")
    expect(formatPhone("+1 (408) 555 1234")).toBe("(408) 555-1234")
    expect(formatPhone("1-408-555-1234")).toBe("(408) 555-1234")
    expect(formatPhone("  ")).toBeNull()
    expect(formatPhone(null)).toBeNull()
    // Not a 10-digit US number → as typed
    expect(formatPhone("+44 20 7946 0958")).toBe("+44 20 7946 0958")
  })

  it("renders dates MM/DD/YYYY and defaults to today in Pacific time", () => {
    expect(formatDateMMDDYYYY("2026-10-16")).toBe("10/16/2026")
    // 2026-10-17T03:30Z is still the evening of the 16th in Los Angeles.
    expect(todayPT(new Date("2026-10-17T03:30:00Z"))).toBe("2026-10-16")
    expect(todayPT(new Date("2026-10-17T07:30:00Z"))).toBe("2026-10-17")
    expect(blankFields(new Date("2026-10-17T03:30:00Z")).agreement_date).toBe("2026-10-16")
    expect(blankFields().closing_days).toBe(45)
  })
})

describe("expiration — term 4 (days parsed in code, default 3 calendar days after the agreement date)", () => {
  it("parses a plain number of days and nothing else", () => {
    expect(parseExpirationDays("5 days")).toBe(5)
    expect(parseExpirationDays("good for 5 days")).toBe(5)
    expect(parseExpirationDays("within 10 days")).toBe(10)
    expect(parseExpirationDays("3")).toBe(3)
    expect(parseExpirationDays("1 day")).toBe(1)
    expect(parseExpirationDays(7)).toBe(7)
    expect(parseExpirationDays("Friday")).toBeNull()
    expect(parseExpirationDays("0 days")).toBeNull()
    expect(parseExpirationDays("5 business days")).toBeNull()
    expect(parseExpirationDays("")).toBeNull()
    expect(parseExpirationDays(null)).toBeNull()
  })

  it("reads a date as ISO or MM/DD/YYYY", () => {
    expect(parseExpirationDate("2026-10-24")).toBe("2026-10-24")
    expect(parseExpirationDate("10/24/2026")).toBe("2026-10-24")
    expect(parseExpirationDate("1/5/2027")).toBe("2027-01-05")
    expect(parseExpirationDate("Friday")).toBeNull()
    expect(parseExpirationDate("2026-13-01")).toBeNull()
  })

  it("calendar arithmetic never shifts a day", () => {
    expect(addDays("2026-10-16", 3)).toBe("2026-10-19")
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02")
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01")
    expect(daysBetween("2026-10-16", "2026-10-19")).toBe(3)
  })

  it("normalises a phrase to 'N days' or a date, flags what it can't read, keeps the default meanwhile", () => {
    expect(normalizeExpiration(null, "2026-10-16")).toEqual({ value: null, problem: null })
    expect(normalizeExpiration("", "2026-10-16")).toEqual({ value: null, problem: null })
    expect(normalizeExpiration("good for 5 days", "2026-10-16")).toEqual({ value: "5 days", problem: null })
    expect(normalizeExpiration("10/24/2026", "2026-10-16")).toEqual({ value: "2026-10-24", problem: null })
    expect(normalizeExpiration("2026-10-24", "2026-10-16")).toEqual({ value: "2026-10-24", problem: null })
    const bad = normalizeExpiration("end of the week", "2026-10-16")
    expect(bad.value).toBeNull()
    expect(bad.problem).toMatch(/offer expiration: "end of the week"/)
    const past = normalizeExpiration("2026-10-16", "2026-10-16")
    expect(past.value).toBeNull()
    expect(past.problem).toMatch(/not after the agreement date/)
  })

  it("resolves to a date + day count + time: default, a count, a date", () => {
    expect(DEFAULT_EXPIRATION_DAYS).toBe(3)
    expect(DEFAULT_EXPIRATION_TIME).toBe("17:00")
    expect(resolveExpiration({ agreement_date: "2026-10-16", expiration: null })).toEqual({ date: "2026-10-19", days: 3, time: "17:00" })
    expect(resolveExpiration({ agreement_date: "2026-10-16", expiration: "5 days" })).toEqual({ date: "2026-10-21", days: 5, time: "17:00" })
    expect(resolveExpiration({ agreement_date: "2026-10-16", expiration: "2026-10-24" })).toEqual({ date: "2026-10-24", days: 8, time: "17:00" })
    expect(resolveExpiration({ agreement_date: "2026-10-16", expiration: null, expiration_time: "12:00" })).toEqual({ date: "2026-10-19", days: 3, time: "12:00" })
    expect(resolveExpiration({ agreement_date: "2026-10-16", expiration: "2026-10-24", expiration_time: "23:59" }).time).toBe("23:59")
    expect(blankFields().expiration).toBeNull()
    expect(blankFields().expiration_time).toBeNull()
  })

  it("flows from the model (a day name already converted to a date) and from the form", () => {
    const now = new Date("2026-10-16T18:00:00Z")
    expect(normalizeModelOffer({ expiration: "2026-10-23" }, { now }).fields.expiration).toBe("2026-10-23")
    expect(normalizeModelOffer({ expiration: "5 days" }, { now }).fields.expiration).toBe("5 days")
    expect(normalizeModelOffer({ expiration: null }, { now }).fields.expiration).toBeNull()
    const odd = normalizeModelOffer({ expiration: "whenever" }, { now })
    expect(odd.fields.expiration).toBeNull()
    expect(odd.unclear.some((u) => u.includes("offer expiration"))).toBe(true)
    const form = fieldsFromInput({ agreement_date: "2026-11-02", expiration: "10/24/2026" }, { now })
    expect(form.unclear[0]).toMatch(/not after the agreement date/)
    expect(form.fields.expiration).toBeNull()
    expect(fieldsFromInput({ agreement_date: "2026-11-02", expiration: "4" }, { now }).fields.expiration).toBe("4 days")
  })
})

describe("expiration time — term 4 (parsed in code, default 5:00 p.m.)", () => {
  it.each([
    ["noon", "12:00"],
    ["12 noon", "12:00"],
    ["at noon", "12:00"],
    ["5pm", "17:00"],
    ["5 pm", "17:00"],
    ["5PM", "17:00"],
    ["5:00 p.m.", "17:00"],
    ["5:00pm", "17:00"],
    ["5:30 p.m.", "17:30"],
    ["by 5pm", "17:00"],
    ["5pm Pacific", "17:00"],
    ["5:00 p.m. (Pacific time)", "17:00"],
    ["end of day", "23:59"],
    ["end of the day", "23:59"],
    ["EOD", "23:59"],
    ["midnight", "23:59"],
    ["close of business", "23:59"],
    ["9am", "09:00"],
    ["9:15 a.m.", "09:15"],
    ["12pm", "12:00"],
    ["12am", "00:00"],
    ["17:00", "17:00"],
    ["00:30", "00:30"],
    ["12:00", "12:00"],
  ])("%s → %s", (raw, expected) => {
    expect(parseExpirationTime(raw)).toBe(expected)
  })

  it("rejects what it can't read (ask instead): garbage, 13pm, a bare ambiguous clock time", () => {
    expect(parseExpirationTime("whenever")).toBeNull()
    expect(parseExpirationTime("13pm")).toBeNull()
    expect(parseExpirationTime("0pm")).toBeNull()
    expect(parseExpirationTime("5:60 pm")).toBeNull()
    expect(parseExpirationTime("5:00")).toBeNull() // 5 a.m. or p.m.? ask
    expect(parseExpirationTime("5")).toBeNull()
    expect(parseExpirationTime("24:00")).toBeNull()
    expect(parseExpirationTime("")).toBeNull()
    expect(parseExpirationTime(null)).toBeNull()
  })

  it("normalises to HH:MM, keeps the default for nothing, flags garbage as unclear", () => {
    expect(normalizeExpirationTime(null)).toEqual({ value: null, problem: null })
    expect(normalizeExpirationTime("")).toEqual({ value: null, problem: null })
    expect(normalizeExpirationTime("noon")).toEqual({ value: "12:00", problem: null })
    expect(normalizeExpirationTime("5:00 p.m.")).toEqual({ value: "17:00", problem: null })
    expect(normalizeExpirationTime("EOD")).toEqual({ value: "23:59", problem: null })
    const bad = normalizeExpirationTime("teatime")
    expect(bad.value).toBeNull()
    expect(bad.problem).toMatch(/offer expiration time: "teatime"/)
  })

  it("renders lower-case a.m./p.m. with no leading zero", () => {
    expect(formatExpirationTime("17:00")).toBe("5:00 p.m.")
    expect(formatExpirationTime("12:00")).toBe("12:00 p.m.")
    expect(formatExpirationTime("23:59")).toBe("11:59 p.m.")
    expect(formatExpirationTime("09:00")).toBe("9:00 a.m.")
    expect(formatExpirationTime("00:00")).toBe("12:00 a.m.")
    expect(expirationLabel({ agreement_date: "2026-10-19", expiration: null })).toBe("10/22/2026 at 5:00 p.m.")
    expect(expirationLabel({ agreement_date: "2026-10-19", expiration: "2026-10-24", expiration_time: "12:00" })).toBe("10/24/2026 at 12:00 p.m.")
  })

  it("flows from the model and from the form; an unreadable time is asked about, the default stands meanwhile", () => {
    const now = new Date("2026-10-16T18:00:00Z")
    expect(normalizeModelOffer({ expiration: "2026-10-23", expiration_time: "12:00" }, { now }).fields.expiration_time).toBe("12:00")
    expect(normalizeModelOffer({ expiration_time: "5pm" }, { now }).fields.expiration_time).toBe("17:00") // model ignored the HH:MM rule — code still reads it
    expect(normalizeModelOffer({ expiration_time: null }, { now }).fields.expiration_time).toBeNull()
    const odd = normalizeModelOffer({ expiration_time: "after lunch" }, { now })
    expect(odd.fields.expiration_time).toBeNull()
    expect(odd.unclear).toHaveLength(1)
    expect(odd.unclear[0]).toMatch(/offer expiration time: "after lunch"/)
    const both = normalizeModelOffer({ expiration: "whenever", expiration_time: "after lunch" }, { now })
    expect(both.unclear).toHaveLength(2) // the date question and the time question are separate
    const form = fieldsFromInput({ agreement_date: "2026-11-02", expiration: "4", expiration_time: "5:00 p.m." }, { now })
    expect(form.fields.expiration_time).toBe("17:00")
    expect(form.unclear).toEqual([])
    expect(fieldsFromInput({ agreement_date: "2026-11-02", expiration_time: "5:00" }, { now }).unclear[0]).toMatch(/expiration time: "5:00"/)
  })

  it("review card: 'Expires: 10/19/2026 at 5:00 p.m. (3 days, default)' — default only when neither date nor time was stated", () => {
    const card = (over: Partial<OfferFields>) => renderOfferCard({ ...newDraft(), fields: full(over) })
    expect(card({})).toContain("<b>Expires:</b> 10/19/2026 at 5:00 p.m. (3 days, default)")
    expect(card({ expiration: "5 days" })).toContain("<b>Expires:</b> 10/21/2026 at 5:00 p.m. (5 days)")
    expect(card({ expiration_time: "12:00" })).toContain("<b>Expires:</b> 10/19/2026 at 12:00 p.m. (3 days)")
    expect(card({ expiration: "2026-10-17", expiration_time: "23:59" })).toContain("<b>Expires:</b> 10/17/2026 at 11:59 p.m. (1 day)")
  })
})

describe("filename + Drive path", () => {
  it("takes the street up to the first comma and strips filename-unsafe characters", () => {
    expect(streetFromAddress("1234 Main St, San Jose, CA 95125")).toBe("1234 Main St")
    expect(streetFromAddress('12 "Oak" Ave / Unit 3: B?, Oakland, CA')).toBe("12 Oak Ave  Unit 3 B".replace(/\s+/g, " "))
    expect(streetFromAddress("  <weird>|name*  ")).toBe("weirdname")
    expect(streetFromAddress(null)).toBe("Unknown address")
  })

  it("names the PDF after the street and the agreement date", () => {
    expect(offerFilename({ property_address: "1234 Main St, San Jose, CA 95125", agreement_date: "2026-10-16" })).toBe(
      "Purchase Agreement - 1234 Main St - 2026-10-16.pdf"
    )
    expect(offerDriveRelPath({ property_address: "1234 Main St, San Jose, CA 95125" })).toBe("Offers/Drafts/1234 Main St")
  })
})

function full(over: Partial<OfferFields> = {}): OfferFields {
  return {
    ...blankFields(new Date("2026-10-16T18:00:00Z")),
    seller_name: "John and Mary Smith",
    property_address: "1234 Main St, San Jose, CA 95125",
    purchase_price: 1_200_000,
    earnest_money: 10_000,
    closing_days: 30,
    special_stipulations: ["Seller may leave the furniture in the property."],
    seller_signer_name: "John and Mary Smith",
    seller_tel: "(408) 555-1234",
    ...over,
  }
}

describe("required-field validation", () => {
  it("passes a complete draft", () => {
    expect(validateFields(full())).toEqual({ ok: true, missing: [] })
  })

  it("names every missing required field, in form order", () => {
    const v = validateFields(full({ seller_name: null, earnest_money: null }))
    expect(v.ok).toBe(false)
    expect(v.missing).toEqual(["seller_name", "earnest_money"])
  })

  it("doesn't double-report a field the model already flagged as unclear", () => {
    const f = full({ earnest_money: null })
    expect(missingFields(f, ['earnest money deposit: "2.5%" — I need a dollar amount'])).toEqual([])
    expect(missingFields(f, [])).toEqual(["earnest_money"])
  })
})

describe("normalizeModelOffer — model JSON → fields", () => {
  const now = new Date("2026-10-16T18:00:00Z")

  it("converts raw money, defaults, signer and phone", () => {
    const out = normalizeModelOffer(
      {
        seller_name: "John and Mary Smith",
        property_address: "1234 Main St, San Jose, CA 95125",
        address_needs_confirm: true,
        purchase_price_raw: "1.2M",
        earnest_money_raw: "10k",
        closing_days: 30,
        special_stipulations: ["Seller may leave the furniture."],
        agreement_date: null,
        seller_signer_name: null,
        seller_tel: "408-555-1234",
        seller_email: null,
        unclear: [],
      },
      { now }
    )
    expect(out.fields.purchase_price).toBe(1_200_000)
    expect(out.fields.earnest_money).toBe(10_000)
    expect(out.fields.agreement_date).toBe("2026-10-16")
    expect(out.fields.seller_signer_name).toBe("John and Mary Smith")
    expect(out.fields.seller_tel).toBe("(408) 555-1234")
    expect(out.fields.address_needs_confirm).toBe(true)
    expect(out.missing).toEqual([])
    expect(out.unclear).toEqual([])
  })

  it("asks about a percentage EMD instead of guessing, and lists nulls as missing", () => {
    const out = normalizeModelOffer({ seller_name: "Jane Doe", purchase_price_raw: "1.2M", earnest_money_raw: "2.5%", closing_days: null }, { now })
    expect(out.fields.earnest_money).toBeNull()
    expect(out.unclear).toHaveLength(1)
    expect(out.unclear[0]).toMatch(/earnest money deposit: "2\.5%"/)
    expect(out.missing).toEqual(["property_address"]) // EMD is unclear, not missing
    expect(out.fields.closing_days).toBe(45)
  })

  it("ignores a malformed agreement_date and keeps a stated one", () => {
    expect(normalizeModelOffer({ agreement_date: "next Monday" }, { now }).fields.agreement_date).toBe("2026-10-16")
    expect(normalizeModelOffer({ agreement_date: "2026-11-01" }, { now }).fields.agreement_date).toBe("2026-11-01")
  })
})

describe("stipulations must trace to Ryan's words", () => {
  const source = "1234 Main St San Jose 95125, seller John and Mary Smith, 1.2M, 10k EMD, 30 day close, seller can leave furniture, seller phone 408-555-1234"

  it("keeps a clarity rewrite and drops an invented term", () => {
    const { kept, dropped } = traceStipulations(
      ["Seller may leave the furniture in the property.", "Buyer waives the inspection contingency.", "Seller to credit $5,000 toward repairs."],
      source
    )
    expect(kept).toEqual(["Seller may leave the furniture in the property."])
    expect(dropped).toEqual(["Buyer waives the inspection contingency.", "Seller to credit $5,000 toward repairs."])
  })

  it("a number alone is enough to trace (e.g. '14 day close option')", () => {
    const { kept } = traceStipulations(["Buyer has the option to close in 14 days."], `${source}\n+ add stip: 14 day close option`)
    expect(kept).toHaveLength(1)
  })

  it("finishParse applies the trace and reports what it dropped", () => {
    const out = finishParse(
      { seller_name: "John", property_address: "1234 Main St, San Jose, CA 95125", purchase_price_raw: "1.2M", earnest_money_raw: "10k", special_stipulations: ["Seller may leave furniture.", "Buyer waives appraisal contingency."] },
      source,
      new Date("2026-10-16T18:00:00Z")
    )
    expect(out.fields.special_stipulations).toEqual(["Seller may leave furniture."])
    expect(out.droppedStipulations).toEqual(["Buyer waives appraisal contingency."])
  })
})

describe("fieldsFromInput — the Mini App form", () => {
  it("accepts shorthand money and one-per-line stipulations", () => {
    const out = fieldsFromInput({ seller_name: "Jane", property_address: "1 Oak St, Oakland, CA 94601", purchase_price: "1.52M", earnest_money: "$10,000", closing_days: "21", special_stipulations: "a\n\nb ", seller_tel: "4085551234", agreement_date: "2026-11-02" })
    expect(out.fields.purchase_price).toBe(1_520_000)
    expect(out.fields.earnest_money).toBe(10_000)
    expect(out.fields.closing_days).toBe(21)
    expect(out.fields.special_stipulations).toEqual(["a", "b"])
    expect(out.fields.seller_tel).toBe("(408) 555-1234")
    expect(out.fields.seller_signer_name).toBe("Jane")
    expect(out.fields.agreement_date).toBe("2026-11-02")
    expect(out.missing).toEqual([])
  })

  it("flags unparsable money and empty required fields", () => {
    const out = fieldsFromInput({ purchase_price: "2.5%", earnest_money: "" })
    expect(out.unclear).toHaveLength(1)
    expect(out.missing).toEqual(["seller_name", "property_address", "earnest_money"])
  })
})

describe("pdfFieldValues", () => {
  it("renders the 15 template fields; seller_date blank, governing_state California, expiration resolved", () => {
    const v = pdfFieldValues(full())
    expect(Object.keys(v)).toHaveLength(15)
    expect(v.agreement_date).toBe("10/16/2026")
    expect(v.buyer_date).toBe("10/16/2026")
    expect(v.expiration_date).toBe("10/19/2026") // 3 calendar days after the agreement date
    expect(v.expiration_time).toBe("5:00 p.m.") // default
    expect(v).not.toHaveProperty("expiration_days")
    const e = pdfFieldValues(full({ expiration: "2026-10-24", expiration_time: "12:00" }))
    expect(e.expiration_date).toBe("10/24/2026")
    expect(e.expiration_time).toBe("12:00 p.m.")
    expect(pdfFieldValues(full({ expiration: "5 days", expiration_time: "23:59" })).expiration_time).toBe("11:59 p.m.")
    expect(pdfFieldValues(full({ expiration: "5 days" })).expiration_date).toBe("10/21/2026")
    expect(v).not.toHaveProperty("addendum_attached") // e-sign's box, left blank by the offer bot
    expect(v.seller_date).toBe("")
    expect(v.governing_state).toBe("California")
    expect(v.purchase_price).toBe("1,200,000.00")
    expect(v.earnest_money).toBe("10,000.00")
    expect(v.closing_days).toBe("30")
    expect(v.seller_signer_name).toBe("John and Mary Smith")
  })
})

describe("fillOfferPdf — pdf-lib fixture", () => {
  async function fixture(): Promise<Uint8Array> {
    const doc = await PDFDocument.create()
    const page = doc.addPage([612, 792])
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const form = doc.getForm()
    const name = form.createTextField("seller_name")
    name.addToPage(page, { x: 50, y: 700, width: 300, height: 18, font })
    const stips = form.createTextField("special_stipulations")
    stips.enableMultiline()
    stips.addToPage(page, { x: 50, y: 500, width: 491, height: 60, font })
    form.updateFieldAppearances(font)
    return doc.save({ useObjectStreams: false })
  }

  it("fills the fields it finds, reports the rest, stays fillable", async () => {
    const template = await fixture()
    const before = Buffer.from(template).toString("latin1")
    const out = await fillOfferPdf(template, full({ special_stipulations: ["Seller may leave the furniture.", "Buyer may close in 14 days."] }))
    expect(out.filled.sort()).toEqual(["seller_name", "special_stipulations"])
    expect(out.absent).toContain("purchase_price")
    expect(out.absent).toContain("expiration_date")
    expect(out.absent).toContain("expiration_time")
    expect(out.absent).toHaveLength(13)

    const reloaded = await PDFDocument.load(out.bytes)
    const form = reloaded.getForm()
    expect(form.getFields().length).toBeGreaterThan(0) // not flattened
    expect(form.getTextField("seller_name").getText()).toBe("John and Mary Smith")
    expect(form.getTextField("special_stipulations").getText()).toBe("Seller may leave the furniture.\nBuyer may close in 14 days.")
    expect(form.getTextField("special_stipulations").isMultiline()).toBe(true)
    expect(form.acroForm.dict.has(PDFNameOf("NeedAppearances"))).toBe(true)
    // The template bytes were not touched.
    expect(Buffer.from(template).toString("latin1")).toBe(before)
  })

  it("clears a template /MaxLen instead of throwing (real template: special_stipulations MaxLen 100)", async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([612, 792])
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const form = doc.getForm()
    const name = form.createTextField("seller_name")
    name.setMaxLength(10)
    name.addToPage(page, { x: 50, y: 700, width: 300, height: 18, font })
    const stips = form.createTextField("special_stipulations")
    stips.setMaxLength(10)
    stips.enableMultiline()
    stips.addToPage(page, { x: 50, y: 500, width: 491, height: 60, font })
    const template = await doc.save({ useObjectStreams: false })

    const thirty = "Seller may leave the furniture" // 30 chars
    expect(thirty).toHaveLength(30)
    const out = await fillOfferPdf(template, full({ seller_name: thirty, special_stipulations: [thirty, thirty] }))
    const reloaded = await PDFDocument.load(out.bytes)
    const f = reloaded.getForm()
    expect(f.getTextField("seller_name").getText()).toBe(thirty)
    expect(f.getTextField("seller_name").getMaxLength()).toBeUndefined()
    expect(f.getTextField("special_stipulations").getText()).toBe(`${thirty}\n${thirty}`)
    expect(f.getTextField("special_stipulations").getMaxLength()).toBeUndefined()
  })

  it("auto-sizes a long stipulation block instead of truncating", async () => {
    const template = await fixture()
    const many = Array.from({ length: 9 }, (_, i) => `Stipulation number ${i + 1} is a full sentence of contract language that runs on.`)
    const out = await fillOfferPdf(template, full({ special_stipulations: many }))
    const reloaded = await PDFDocument.load(out.bytes)
    const f = reloaded.getForm().getTextField("special_stipulations")
    expect(f.getText()?.split("\n")).toHaveLength(9)
    // setFontSize(0) → pdf-lib computes the size that fits the 60pt box and
    // writes it to /DA: nine lines land well under the template's 9pt.
    const m = /(\d+(?:\.\d+)?) Tf/.exec(f.acroField.getDefaultAppearance() ?? "")
    expect(m).not.toBeNull()
    const size = Number(m![1])
    expect(size).toBeGreaterThan(0)
    expect(size).toBeLessThan(9)
  })
})

// pdf-lib's PDFName is only needed for one assertion; keep the import local.
import { PDFName } from "pdf-lib"
function PDFNameOf(s: string) {
  return PDFName.of(s)
}

describe("Telegram Mini App initData validation", () => {
  const TOKEN = "123456:FAKE-bot-token-for-tests"
  const NOW = 1_760_000_000
  const user = JSON.stringify({ id: 42, first_name: "Ryan", username: "ryan" })
  const params = { auth_date: String(NOW - 60), query_id: "AAHdF6IQAAAAAN0XohDhrOrc", user }

  it("accepts a correctly signed, fresh payload", () => {
    const initData = signTelegramInitData(params, TOKEN)
    const v = validateTelegramInitData(initData, TOKEN, { nowSec: NOW })
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.user.id).toBe(42)
      expect(String(v.user.id) === "42").toBe(true)
    }
  })

  it("rejects a wrong hash, a different bot token, and a tampered field", () => {
    const initData = signTelegramInitData(params, TOKEN)
    const wrongToken = validateTelegramInitData(initData, "999:other", { nowSec: NOW })
    expect(wrongToken).toEqual({ ok: false, error: "bad signature" })
    const tampered = initData.replace(encodeURIComponent(user), encodeURIComponent(JSON.stringify({ id: 7, first_name: "Mallory" })))
    expect(tampered).not.toBe(initData)
    expect(validateTelegramInitData(tampered, TOKEN, { nowSec: NOW })).toEqual({ ok: false, error: "bad signature" })
    const flipped = initData.replace(/hash=([0-9a-f])/, (_m, c: string) => `hash=${c === "0" ? "1" : "0"}`)
    expect(validateTelegramInitData(flipped, TOKEN, { nowSec: NOW })).toEqual({ ok: false, error: "bad signature" })
    expect(validateTelegramInitData("user=%7B%7D", TOKEN, { nowSec: NOW })).toEqual({ ok: false, error: "missing hash" })
  })

  it("rejects a stale auth_date (older than 24h)", () => {
    const stale = signTelegramInitData({ ...params, auth_date: String(NOW - 25 * 3600) }, TOKEN)
    expect(validateTelegramInitData(stale, TOKEN, { nowSec: NOW })).toEqual({ ok: false, error: "initData expired" })
    const fresh = signTelegramInitData({ ...params, auth_date: String(NOW - 23 * 3600) }, TOKEN)
    expect(validateTelegramInitData(fresh, TOKEN, { nowSec: NOW }).ok).toBe(true)
  })

  it("the route's identity check: another user id is not Ryan", () => {
    const other = signTelegramInitData({ ...params, user: JSON.stringify({ id: 99, first_name: "Other" }) }, TOKEN)
    const v = validateTelegramInitData(other, TOKEN, { nowSec: NOW })
    expect(v.ok).toBe(true)
    if (v.ok) expect(String(v.user.id) === "42").toBe(false)
  })
})
