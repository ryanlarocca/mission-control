import { describe, expect, it } from "vitest"
import { clusterFacts, cooledTemperature, decideCooling, decideQuietMove, decideStageMove, statusAnchor, type ClusterRow } from "@/lib/leadStatus"
import { buildDigest, latestPerPerson } from "@/lib/leadStatusDigest"
import { pacificDate, pacificDatePlusDays } from "@/lib/pacificDate"

const DAY = 86_400_000
const NOW = Date.parse("2026-10-24T16:00:00Z")
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

function row(p: Partial<ClusterRow> & { id: string; created_at: string }): ClusterRow {
  return { twilio_number: "+14084186294", caller_phone: "+14085551212", email: null, status: "new", ...p }
}
const inbound = (id: string, ago: number, extra: Partial<ClusterRow> = {}) => row({ id, created_at: iso(ago), ...extra })
const outbound = (id: string, ago: number, extra: Partial<ClusterRow> = {}) => row({ id, created_at: iso(ago), twilio_number: null, status: "contacted", ...extra })
const facts = (rows: ClusterRow[]) => clusterFacts(rows, statusAnchor(rows)!)

describe("statusAnchor", () => {
  it("is the newest inbound row, like the card", () => {
    const rows = [inbound("a", 5 * DAY), outbound("b", 1 * DAY)]
    expect(statusAnchor(rows)!.id).toBe("a")
  })
})

describe("decideStageMove", () => {
  it("a lead moves New → Active", () => {
    expect(decideStageMove(facts([inbound("a", DAY)]), "lead")).toEqual({ to: "active", rule: "lead" })
  })
  it("an Active lead stays put", () => {
    expect(decideStageMove(facts([inbound("a", DAY, { status: "active" })]), "lead")).toBeNull()
  })
  it("not now moves New / Active → Nurture but leaves Nurture alone", () => {
    expect(decideStageMove(facts([inbound("a", DAY)]), "not_now")).toEqual({ to: "nurture", rule: "not_now" })
    expect(decideStageMove(facts([inbound("a", DAY, { status: "active" })]), "not_now")?.to).toBe("nurture")
    expect(decideStageMove(facts([inbound("a", DAY, { status: "nurture" })]), "not_now")).toBeNull()
  })
  it("sold / wrong person → Dead", () => {
    expect(decideStageMove(facts([inbound("a", DAY)]), "sold")).toEqual({ to: "dead", rule: "sold" })
    expect(decideStageMove(facts([inbound("a", DAY, { status: "nurture" })]), "wrong_person")).toEqual({ to: "dead", rule: "wrong_person" })
  })
  it("unclear never moves anything", () => {
    expect(decideStageMove(facts([inbound("a", DAY)]), "unclear")).toBeNull()
  })
  it("never touches a DNC person or a pending / closed deal", () => {
    expect(decideStageMove(facts([inbound("a", DAY, { is_dnc: true })]), "lead")).toBeNull()
    expect(decideStageMove(facts([inbound("a", DAY, { pending_at: iso(DAY) })]), "not_now")).toBeNull()
    expect(decideStageMove(facts([inbound("a", DAY, { deal_closed_at: iso(DAY) })]), "sold")).toBeNull()
  })
  it("Ryan's hand-set status wins until something new happens", () => {
    const set = inbound("a", 3 * DAY, { status: "nurture", status_set_by: "ryan", status_set_at: iso(2 * DAY) })
    expect(decideStageMove(facts([set]), "lead")).toBeNull()
    // a newer message after his change re-opens it
    expect(decideStageMove(facts([set, inbound("b", DAY, { status: "nurture" })]), "lead")?.to).toBe("active")
  })
  it("a milestone keeps the person a lead even on a soft no", () => {
    const rows = [inbound("a", DAY, { status: "nurture", appointment_at: iso(DAY) })]
    expect(decideStageMove(facts(rows), "not_now")).toEqual({ to: "active", rule: "lead" })
  })
})

describe("decideQuietMove", () => {
  it("Active + Ryan reached out 30+ days ago + no reply → Nurture", () => {
    const rows = [inbound("a", 40 * DAY, { status: "active" }), outbound("b", 31 * DAY)]
    const m = decideQuietMove(rows, facts(rows), NOW)
    expect(m?.to).toBe("nurture")
    expect(m?.rule).toBe("quiet_30d")
  })
  it("not yet 30 days → nothing", () => {
    const rows = [inbound("a", 40 * DAY, { status: "active" }), outbound("b", 29 * DAY)]
    expect(decideQuietMove(rows, facts(rows), NOW)).toBeNull()
  })
  it("the clock starts at Ryan's FIRST chase after their last message", () => {
    const rows = [inbound("a", 40 * DAY, { status: "active" }), outbound("b", 31 * DAY), outbound("c", 2 * DAY)]
    expect(decideQuietMove(rows, facts(rows), NOW)?.to).toBe("nurture")
  })
  it("they replied after the chase → nothing", () => {
    const rows = [inbound("a", 40 * DAY, { status: "active" }), outbound("b", 35 * DAY), inbound("c", 33 * DAY, { status: "active" })]
    expect(decideQuietMove(rows, facts(rows), NOW)).toBeNull()
  })
  it("Ryan never reached out → nothing (Follow Ups owns it)", () => {
    const rows = [inbound("a", 60 * DAY, { status: "active" })]
    expect(decideQuietMove(rows, facts(rows), NOW)).toBeNull()
  })
  it("never moves to Dead, and only from Active", () => {
    const rows = [inbound("a", 60 * DAY, { status: "nurture" }), outbound("b", 50 * DAY)]
    expect(decideQuietMove(rows, facts(rows), NOW)).toBeNull()
  })
  it("a personal-cell reply (The Pile) is a reply — Candace, 10-24", () => {
    const rows = [inbound("a", 160 * DAY, { status: "active" }), outbound("b", 159 * DAY)]
    expect(decideQuietMove(rows, facts(rows), NOW)?.to).toBe("nurture")
    expect(decideQuietMove(rows, facts(rows), NOW, { inbound: [NOW - 4 * DAY], outbound: [NOW - 8 * DAY] })).toBeNull()
  })
  it("a personal-cell chase starts the clock when Supabase has none", () => {
    const rows = [inbound("a", 90 * DAY, { status: "active" })]
    expect(decideQuietMove(rows, facts(rows), NOW, { inbound: [], outbound: [NOW - 45 * DAY] })?.to).toBe("nurture")
    expect(decideQuietMove(rows, facts(rows), NOW, { inbound: [], outbound: [NOW - 10 * DAY] })).toBeNull()
  })
  it("Ryan re-setting Active restarts the clock", () => {
    const rows = [inbound("a", 60 * DAY, { status: "active", status_set_by: "ryan", status_set_at: iso(10 * DAY) }), outbound("b", 50 * DAY)]
    expect(decideQuietMove(rows, facts(rows), NOW)).toBeNull()
  })
})

describe("buildDigest", () => {
  it("nothing moved → no message", () => {
    expect(buildDigest([])).toBeNull()
  })
  it("one message with counts, lines and an undo button per move", () => {
    const d = buildDigest([
      { id: "11111111-1111-1111-1111-111111111111", to_status: "nurture", rule: "quiet_30d", reason: "No reply for 31 days", who: "Herb Bivens" },
      { id: "22222222-2222-2222-2222-222222222222", to_status: "active", rule: "lead", reason: "Wants an offer on 4032 Ross Park", who: "Jane <Doe>" },
    ])!
    expect(d.text).toContain("1 → Nurture")
    expect(d.text).toContain("1 → Active")
    expect(d.text).toContain("Jane &lt;Doe&gt;")
    expect(d.buttons).toHaveLength(2)
    expect(d.buttons[0][0].data).toBe("lsundo:11111111-1111-1111-1111-111111111111")
    expect(d.buttons[0][0].data.length).toBeLessThanOrEqual(64) // Telegram callback_data limit
  })
  it("caps the list at 20 and says how many more", () => {
    const evs = Array.from({ length: 25 }, (_, i) => ({ id: `0000000${i}`.slice(-8) + "-0000-0000-0000-000000000000", to_status: "nurture", rule: "quiet_30d", reason: null, who: `P${i}` }))
    const d = buildDigest(evs)!
    expect(d.buttons).toHaveLength(20)
    expect(d.text).toContain("and 5 more")
  })
})

describe("latestPerPerson", () => {
  it("lists a person once — their newest move — even across two rows", () => {
    const key: Record<string, string | null> = { call: "+15550001111", text: "+15550001111", other: "+15550002222", lonely: null }
    const shown = latestPerPerson(
      [
        { id: "e1", lead_id: "call" },
        { id: "e2", lead_id: "other" },
        { id: "e3", lead_id: "text" },
        { id: "e4", lead_id: "lonely" },
      ],
      (id) => key[id]
    )
    expect(Array.from(shown).sort()).toEqual(["e2", "e3", "e4"])
  })
})

describe("pacificDate", () => {
  it("6pm Pacific is still today, not UTC's tomorrow", () => {
    const at = new Date("2026-11-05T02:03:16Z") // Nov 4, 6:03pm PST
    expect(pacificDate(at)).toBe("2026-11-04")
    expect(pacificDatePlusDays(1, at)).toBe("2026-11-05")
  })
  it("crosses month ends and DST", () => {
    expect(pacificDatePlusDays(1, new Date("2026-03-01T07:30:00Z"))).toBe("2026-03-01") // Feb 28 11:30pm PST
    expect(pacificDatePlusDays(180, new Date("2026-11-05T18:00:00Z"))).toBe("2027-05-04")
  })
})

describe("cooling (hot / warm fades with their silence)", () => {
  it("Hot → Warm at 30 days, anything → Cold at 60", () => {
    expect(cooledTemperature("hot", 29)).toBe("hot")
    expect(cooledTemperature("hot", 30)).toBe("warm")
    expect(cooledTemperature("warm", 59)).toBe("warm")
    expect(cooledTemperature("warm", 60)).toBe("cold")
    expect(cooledTemperature("hot", 61)).toBe("cold")
    expect(cooledTemperature("cold", 400)).toBe("cold")
  })
  it("a one-voicemail Warm from six months ago cools to Cold on the chip row", () => {
    const rows = [inbound("vm", 185 * DAY, { status: "active", temperature: "warm" }), outbound("call", 185 * DAY - 90_000, { temperature: "warm" }), outbound("auto", 0)]
    expect(decideCooling(rows, NOW)).toEqual({ rowId: "call", from: "warm", to: "cold", silentDays: 185 })
  })
  it("Ryan's calls and auto texts don't count as hearing from them", () => {
    const rows = [inbound("a", 40 * DAY, { temperature: "hot" }), outbound("b", 2 * DAY), outbound("c", 1 * DAY)]
    expect(decideCooling(rows, NOW)?.to).toBe("warm")
  })
  it("a text to Ryan's personal cell counts", () => {
    const rows = [inbound("a", 90 * DAY, { temperature: "warm" })]
    expect(decideCooling(rows, NOW, { inbound: [NOW - 5 * DAY], outbound: [] })).toBeNull()
  })
  it("they reached out recently → leave it", () => {
    expect(decideCooling([inbound("a", 10 * DAY, { temperature: "hot" })], NOW)).toBeNull()
  })
  it("keeps the rating for call-me-in-January, appointments, deals, DNC / junk / dead", () => {
    const old = (extra: Partial<ClusterRow> = {}) => [inbound("a", 100 * DAY, { temperature: "warm", ...extra })]
    expect(decideCooling(old(), NOW, null, "call_on")).toBeNull()
    expect(decideCooling(old(), NOW, null, "appointment")).toBeNull()
    expect(decideCooling(old({ appointment_at: new Date(NOW + DAY).toISOString() }), NOW)).toBeNull()
    expect(decideCooling(old({ pending_at: iso(DAY) }), NOW)).toBeNull()
    expect(decideCooling(old({ is_junk: true }), NOW)).toBeNull()
    expect(decideCooling(old({ status: "dead" }), NOW)).toBeNull()
    expect(decideCooling(old(), NOW, null, "quiet_until")?.to).toBe("cold")
  })
})
