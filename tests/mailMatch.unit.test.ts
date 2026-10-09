import { describe, expect, it } from "vitest"
import { normStreet, normSurname, parseFreeAddress } from "@/lib/mailMatch"

describe("mailMatch normalizers", () => {
  it("drops units and standardizes suffixes", () => {
    expect(normStreet("231 Market Pl # 290")).toBe("231 MARKET PL")
    expect(normStreet("1630 8th St Unit 2308")).toBe("1630 8TH ST")
    expect(normStreet("860 24th Ave., Apt 4")).toBe("860 24TH AVE")
    expect(normStreet("1145 Davis Street")).toBe("1145 DAVIS ST")
    expect(normStreet("2130 Rexford Way")).toBe("2130 REXFORD WAY")
  })
  it("takes the last real token as the surname", () => {
    expect(normSurname("Donald Teixeira, Trustee")).toBe("TEIXEIRA")
    expect(normSurname("Richard Hudnut Jr")).toBe("HUDNUT")
    expect(normSurname("Kim & Deborah Rosenblatt")).toBe("ROSENBLATT")
    expect(normSurname("The Liu Family Trust")).toBe("LIU")
    expect(normSurname("")).toBe("")
  })
  it("parses the free-text addresses leads actually carry", () => {
    expect(parseFreeAddress("860 24th Ave., Santa Cruz 95062")).toEqual({ street: "860 24TH AVE", city: "SANTA CRUZ", zip: "95062", hasNumber: true })
    expect(parseFreeAddress("1035 Bryant, Palo Alto")).toEqual({ street: "1035 BRYANT", city: "PALO ALTO", zip: "", hasNumber: true })
    expect(parseFreeAddress("132 N 14th Street, San Jose, CA 95112")).toEqual({ street: "132 N 14TH ST", city: "SAN JOSE", zip: "95112", hasNumber: true })
    expect(parseFreeAddress("1450 Merrill St Santa Cruz")).toEqual({ street: "1450 MERRILL ST", city: "SANTA CRUZ", zip: "", hasNumber: true })
    expect(parseFreeAddress("San Jose, CA (duplex)").hasNumber).toBe(false)
    expect(parseFreeAddress("").hasNumber).toBe(false)
  })
})
