import { describe, expect, it } from "vitest"
import { alertDate, contactAlertLines, contactLabel, type AlertContact } from "@/lib/contactAlert"
import { NO_HISTORY, decideArm, isKnownCaller } from "@/lib/jackie"

// Ryan 2026-11-09: a call back from someone who'd asked off the list came in
// as "📞 New lead call — NOO-Q4-2026-B — +1669…". Repeat contacts say so,
// lead with who they are (name, else the property), and carry a DNC tag.
const concerto: AlertContact = {
  known: true, name: null, address: "4411 Concerto Dr, San Jose",
  dnc: true, dncSince: "2026-11-08T23:43:31.060721+00:00",
}

describe("contactAlertLines", () => {
  it("repeat DNC caller with no name → address up front, DNC tag + date, where a miss goes", () => {
    expect(contactAlertLines({ kind: "call", source: "NOO-Q4-2026-B", phone: "+16693779191", contact: concerto, jackieLine: true })).toEqual([
      "📞 Repeat caller · 🚫 DNC — <b>4411 Concerto Dr, San Jose</b> — NOO-Q4-2026-B",
      "+16693779191 · asked off the list Nov 8, 2026",
      "If you miss it → your voicemail, not Jackie",
    ])
  })
  it("repeat caller with a name → name · address, no DNC tag", () => {
    const lines = contactAlertLines({
      kind: "call", source: "Legacy DM", phone: "+14155550100",
      contact: { known: true, name: "Gary", address: "140 Johnson Ave, Los Gatos", dnc: false, dncSince: null },
    })
    expect(lines).toEqual(["📞 Repeat caller — <b>Gary · 140 Johnson Ave, Los Gatos</b> — Legacy DM", "+14155550100"])
  })
  it("repeat text", () => {
    const lines = contactAlertLines({
      kind: "text", source: "Outbound", phone: "+14155550101",
      contact: { known: true, name: "Juan", address: null, dnc: false, dncSince: null },
    })
    expect(lines[0]).toBe("💬 Repeat text — <b>Juan</b> — Outbound")
    expect(lines).toHaveLength(2)
  })
  it("first-time contact keeps the old New lead line", () => {
    expect(contactAlertLines({ kind: "call", source: "NOO-Q4-2026-A", phone: "+14085550123", contact: { known: false, name: null, address: null, dnc: false, dncSince: null } }))
      .toEqual(["📞 New lead call — <b>NOO-Q4-2026-A</b> — +14085550123"])
    expect(contactAlertLines({ kind: "text", source: "Website", phone: "+14085550123", contact: null, suffix: " X" }))
      .toEqual(["💬 New lead text — <b>Website</b> — +14085550123 X"])
  })
  it("on the do-not-contact list with no card → still tagged, never New", () => {
    const lines = contactAlertLines({ kind: "call", source: "Legacy DM", phone: "+14085550124", contact: { known: false, name: null, address: null, dnc: true, dncSince: null } })
    expect(lines[0]).toBe("📞 Repeat caller · 🚫 DNC — Legacy DM")
    expect(lines[1]).toBe("+14085550124 · asked off the list")
  })
  it("iPhone-only caller with no card says so", () => {
    const lines = contactAlertLines({ kind: "call", source: "NOO-Q4-2026-A", phone: "+14085550125", contact: { known: true, name: null, address: null, dnc: false, dncSince: null, iphoneOnly: true } })
    expect(lines[1]).toBe("+14085550125 · in your iPhone call history, no card")
  })
  it("the phone stays in E.164 so Telegram replies still find the lead", () => {
    for (const l of [contactAlertLines({ kind: "call", source: "S", phone: "+16693779191", contact: concerto })]) {
      expect(l.join("\n")).toMatch(/\+16693779191/)
    }
  })
  it("escapes HTML in names and addresses", () => {
    expect(contactLabel({ name: "A & B", address: null })).toBe("A & B")
    expect(contactAlertLines({ kind: "call", source: "S", phone: "+1", contact: { ...concerto, dnc: false, name: "A & B" } })[0]).toContain("A &amp; B")
  })
  it("a name that is just the phone number is dropped", () => {
    expect(contactLabel({ name: "(669) 377-9191", address: "4411 Concerto Dr" })).toBe("4411 Concerto Dr")
  })
  it("dates show the year, Pacific day", () => {
    expect(alertDate("2026-11-09T06:30:00Z")).toBe("Nov 8, 2026")
  })
})

describe("master-list DNC routes like a card DNC", () => {
  it("no card but asked off → voicemail, not Jackie", () => {
    const h = { ...NO_HISTORY, dnc: true }
    expect(isKnownCaller(h)).toBe(false)
    expect(decideArm({ answered: false, anonymous: false, anonymousJackieToday: 0, jackieToday: 0, forced: false, history: h }))
      .toMatchObject({ jackie: false, reason: "asked to come off the list" })
  })
})
