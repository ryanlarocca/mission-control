import { describe, expect, it } from "vitest"
import {
  QUOTAS,
  addDays,
  contactCounts,
  countsFromPa,
  daysBetween,
  daysRemaining,
  dgStats,
  draftTotals,
  eventsInWeekOf,
  eventsOn,
  formatOverPar,
  formatRate,
  formatWinRatePct,
  gameLineString,
  inPeriod,
  inSameWeek,
  isDateKey,
  lastEvent,
  localDateKey,
  mondayOf,
  paFromGames,
  rateStats,
  rollingOps,
  seasonStats,
  validatePayload,
  type BoardEvent,
  type BoardEventType,
  type PaOutcome,
} from "@/lib/board"

let seq = 0
function ev(
  event_type: BoardEventType,
  occurred_on: string,
  payload: Record<string, unknown> = {},
  created_at?: string
): BoardEvent {
  seq += 1
  return {
    id: `e${seq}`,
    period_id: "p1",
    event_type,
    occurred_on,
    payload,
    relationship_id: null,
    created_at: created_at ?? `${occurred_on}T12:00:${String(seq % 60).padStart(2, "0")}Z`,
  }
}

// ---------------------------------------------------------------- dates

describe("date math", () => {
  it("localDateKey uses local calendar components", () => {
    expect(localDateKey(new Date(2026, 6, 15, 0, 0, 0))).toBe("2026-07-15")
    expect(localDateKey(new Date(2026, 6, 15, 23, 59, 59))).toBe("2026-07-15")
    // one second later it's the next local day — the midnight boundary
    expect(localDateKey(new Date(2026, 6, 16, 0, 0, 0))).toBe("2026-07-16")
    expect(localDateKey(new Date(2026, 0, 1))).toBe("2026-01-01")
  })

  it("addDays crosses months, years, and DST", () => {
    expect(addDays("2026-07-31", 1)).toBe("2026-08-01")
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01")
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31")
    // US DST ends 2026-11-01 — UTC-noon anchoring keeps day math exact
    expect(addDays("2026-10-31", 2)).toBe("2026-11-02")
    expect(addDays("2026-03-07", 2)).toBe("2026-03-09") // DST starts 2026-03-08
  })

  it("daysBetween is signed whole days", () => {
    expect(daysBetween("2026-07-15", "2026-10-13")).toBe(90)
    expect(daysBetween("2026-10-13", "2026-07-15")).toBe(-90)
    expect(daysBetween("2026-07-15", "2026-07-15")).toBe(0)
  })

  it("mondayOf: weeks start Monday", () => {
    expect(mondayOf("2026-07-13")).toBe("2026-07-13") // Monday → itself
    expect(mondayOf("2026-07-15")).toBe("2026-07-13") // Wednesday
    expect(mondayOf("2026-07-19")).toBe("2026-07-13") // Sunday stays in prior-Monday week
    expect(mondayOf("2026-07-20")).toBe("2026-07-20") // next Monday = new week
    expect(mondayOf("2026-11-01")).toBe("2026-10-26") // Sunday across DST fall-back
  })

  it("inSameWeek respects the Monday boundary", () => {
    expect(inSameWeek("2026-07-13", "2026-07-19")).toBe(true)  // Mon..Sun same week
    expect(inSameWeek("2026-07-19", "2026-07-20")).toBe(false) // Sun vs next Mon
    expect(inSameWeek("2026-07-12", "2026-07-13")).toBe(false) // prior Sun vs Mon
  })

  it("daysRemaining: 90 on day one, 1 the day before the end, 0 on/after", () => {
    const p = { ends_on: "2026-10-13" }
    expect(daysRemaining(p, "2026-07-15")).toBe(90)
    expect(daysRemaining(p, "2026-10-12")).toBe(1)
    expect(daysRemaining(p, "2026-10-13")).toBe(0)
    expect(daysRemaining(p, "2026-11-01")).toBe(0)
  })

  it("inPeriod includes both endpoints", () => {
    const p = { starts_on: "2026-07-15", ends_on: "2026-10-13" }
    expect(inPeriod("2026-07-15", p)).toBe(true)
    expect(inPeriod("2026-10-13", p)).toBe(true)
    expect(inPeriod("2026-07-14", p)).toBe(false)
    expect(inPeriod("2026-10-14", p)).toBe(false)
  })

  it("isDateKey validates real calendar dates only", () => {
    expect(isDateKey("2026-07-15")).toBe(true)
    expect(isDateKey("2026-02-30")).toBe(false)
    expect(isDateKey("2026-13-01")).toBe(false)
    expect(isDateKey("2026-7-15")).toBe(false)
    expect(isDateKey("garbage")).toBe(false)
    expect(isDateKey(null)).toBe(false)
    expect(isDateKey(20260715)).toBe(false)
  })
})

// ---------------------------------------------------------------- filters

describe("event filters + week bucketing", () => {
  const events = [
    ev("contact_touch", "2026-07-13", { bucket: "agent" }),   // Mon
    ev("contact_touch", "2026-07-19", { bucket: "seller" }),  // Sun same week
    ev("contact_touch", "2026-07-20", { bucket: "agent" }),   // next Mon
    ev("offer", "2026-07-15"),
    ev("offer", "2026-07-12"),                                 // prior week Sun
  ]

  it("eventsOn filters by day and type", () => {
    expect(eventsOn(events, "2026-07-15")).toHaveLength(1)
    expect(eventsOn(events, "2026-07-15", "offer")).toHaveLength(1)
    expect(eventsOn(events, "2026-07-15", "contact_touch")).toHaveLength(0)
  })

  it("eventsInWeekOf spans Monday..Sunday of the reference day", () => {
    const wk = eventsInWeekOf(events, "2026-07-15")
    expect(wk.map(e => e.occurred_on).sort()).toEqual(["2026-07-13", "2026-07-15", "2026-07-19"])
    expect(eventsInWeekOf(events, "2026-07-15", "offer")).toHaveLength(1)
    // an event logged at 11:59pm Sunday belongs to that week, not the next
    expect(eventsInWeekOf(events, "2026-07-20").map(e => e.occurred_on)).toEqual(["2026-07-20"])
  })

  it("lastEvent picks the most recent by created_at, scoped by day", () => {
    const a = ev("cage", "2026-07-15", {}, "2026-07-15T10:00:00Z")
    const b = ev("cage", "2026-07-15", {}, "2026-07-15T11:00:00Z")
    const c = ev("cage", "2026-07-14", {}, "2026-07-14T23:00:00Z")
    expect(lastEvent([a, b, c], "cage", "2026-07-15")?.id).toBe(b.id)
    expect(lastEvent([a, b, c], "cage")?.id).toBe(b.id)
    expect(lastEvent([a, b, c], "offer")).toBeNull()
    expect(lastEvent([], "cage")).toBeNull()
  })
})

// ---------------------------------------------------------------- financial

describe("contacts + quota chip states", () => {
  it("counts buckets and total across any mix", () => {
    const c = contactCounts([
      ev("contact_touch", "2026-07-15", { bucket: "agent" }),
      ev("contact_touch", "2026-07-15", { bucket: "agent" }),
      ev("contact_touch", "2026-07-15", { bucket: "seller" }),
      ev("contact_touch", "2026-07-15", { bucket: "referral_partner" }),
      ev("offer", "2026-07-15"), // ignored
    ])
    expect(c).toEqual({ agent: 2, seller: 1, referral_partner: 1, total: 4 })
  })

  it("ignores malformed buckets instead of crashing", () => {
    const c = contactCounts([
      ev("contact_touch", "2026-07-15", { bucket: "alien" }),
      ev("contact_touch", "2026-07-15", {}),
    ])
    expect(c.total).toBe(0)
  })

  it("quota thresholds: chip flips green exactly at quota", () => {
    // Chip renders green when n >= target — verify the constants the chips use
    expect(QUOTAS.contactsPerDay).toBe(5)
    expect(4 >= QUOTAS.contactsPerDay).toBe(false)
    expect(5 >= QUOTAS.contactsPerDay).toBe(true)
    expect(QUOTAS.contactsPerWeek).toBe(25)
    expect(QUOTAS.appointmentsPerWeek).toBe(2)
    expect(QUOTAS.offersPerWeek).toBe(1)
    expect(QUOTAS.offersPer90).toBe(12)
    expect(QUOTAS.offersFloor).toBe(7)
    expect(QUOTAS.draftsPerDay).toBe(1)
    expect(QUOTAS.draftsPerWeek).toBe(7)
    expect(QUOTAS.dgRoundsPerWeek).toBe(5)
    expect(QUOTAS.dgPracticesPerWeek).toBe(2)
    expect(QUOTAS.cagesPerWeek).toBe(1)
  })
})

// ---------------------------------------------------------------- mtg

describe("draft totals", () => {
  it("accumulates record and win rate", () => {
    const t = draftTotals([
      ev("draft", "2026-07-15", { wins: 3, losses: 0 }),
      ev("draft", "2026-07-16", { wins: 1, losses: 2 }),
    ])
    expect(t).toEqual({ drafts: 2, wins: 4, losses: 2, winRate: 4 / 6 })
    expect(formatWinRatePct(t.winRate)).toBe("67%")
  })

  it("winRate is null (—) with no games played", () => {
    expect(draftTotals([]).winRate).toBeNull()
    expect(draftTotals([ev("draft", "2026-07-15", { wins: 0, losses: 0 })]).winRate).toBeNull()
    expect(formatWinRatePct(null)).toBe("—")
  })

  it("treats malformed win/loss payloads as 0", () => {
    const t = draftTotals([ev("draft", "2026-07-15", { wins: -2, losses: 1.5 })])
    expect(t.wins).toBe(0)
    expect(t.losses).toBe(0)
  })
})

// ---------------------------------------------------------------- disc golf

describe("disc golf stats", () => {
  it("averages over-par across rounds (negatives allowed)", () => {
    const s = dgStats([
      ev("dg_round", "2026-07-15", { over_par: 6 }),
      ev("dg_round", "2026-07-16", { over_par: -2 }),
      ev("dg_round", "2026-07-17", { over_par: 5 }),
      ev("dg_practice", "2026-07-17"), // ignored
    ])
    expect(s.rounds).toBe(3)
    expect(s.avgOverPar).toBe(3)
  })

  it("empty state: null average, formatted as —", () => {
    const s = dgStats([])
    expect(s).toEqual({ rounds: 0, avgOverPar: null })
    expect(formatOverPar(s.avgOverPar)).toBe("—")
  })

  it("formats over par golf-style", () => {
    expect(formatOverPar(3.25)).toBe("+3.3")
    expect(formatOverPar(0)).toBe("E")
    expect(formatOverPar(-1.5)).toBe("-1.5")
    expect(formatOverPar(6, 0)).toBe("+6")
    expect(formatOverPar(-0.04)).toBe("E") // rounds to 0.0
  })
})

// ---------------------------------------------------------------- softball

describe("softball counting stats", () => {
  it("maps every PA outcome and computes AB = PA − BB − SF", () => {
    const c = countsFromPa(["1B", "2B", "3B", "HR", "BB", "SF", "K", "OUT"])
    expect(c.pa).toBe(8)
    expect(c.singles + c.doubles + c.triples + c.hr).toBe(4)
    expect(c.hits).toBe(4)
    expect(c.bb).toBe(1)
    expect(c.sf).toBe(1)
    expect(c.k).toBe(1)
    expect(c.outs).toBe(1)
    expect(c.ab).toBe(6) // 8 − 1 BB − 1 SF (K and OUT are at-bats)
    expect(c.totalBases).toBe(1 + 2 + 3 + 4)
  })

  it("computes AVG/OBP/SLG/OPS on a known line", () => {
    // 1B, 2B, HR, K, BB, SF, OUT → PA 7, AB 5, H 3, TB 7
    const r = rateStats(countsFromPa(["1B", "2B", "HR", "K", "BB", "SF", "OUT"]))
    expect(r.avg).toBeCloseTo(3 / 5, 10)
    expect(r.obp).toBeCloseTo((3 + 1) / (5 + 1 + 1), 10)
    expect(r.slg).toBeCloseTo(7 / 5, 10)
    expect(r.ops).toBeCloseTo(4 / 7 + 7 / 5, 10)
  })

  it("zero at-bats (all walks): AVG/SLG undefined, OBP = 1.000, OPS = OBP", () => {
    const r = rateStats(countsFromPa(["BB", "BB", "BB"]))
    expect(r.avg).toBeNull()
    expect(r.slg).toBeNull()
    expect(r.obp).toBe(1)
    expect(r.ops).toBe(1)
    expect(formatRate(r.avg)).toBe("—")
    expect(formatRate(r.obp)).toBe("1.000")
  })

  it("all sac flies: AB 0 but OBP denominator counts SF", () => {
    const r = rateStats(countsFromPa(["SF", "SF"]))
    expect(r.avg).toBeNull()
    expect(r.obp).toBe(0)
    expect(r.ops).toBe(0)
  })

  it("no PAs at all: everything null / em-dash", () => {
    const r = rateStats(countsFromPa([]))
    expect(r).toEqual({ avg: null, obp: null, slg: null, ops: null })
    expect(formatRate(r.ops)).toBe("—")
  })

  it("strikeouts tracked separately and count as at-bats", () => {
    const c = countsFromPa(["K", "K", "1B"])
    expect(c.k).toBe(2)
    expect(c.ab).toBe(3)
    expect(rateStats(c).avg).toBeCloseTo(1 / 3, 10)
  })

  it("seasonStats folds multiple games; paFromGames drops junk outcomes", () => {
    const games = [
      ev("softball_game", "2026-07-15", { pa: ["1B", "K"] }),
      ev("softball_game", "2026-07-16", { pa: ["HR", "BB", "XX"] }), // XX ignored
      ev("cage", "2026-07-16"), // ignored entirely
    ]
    expect(paFromGames(games)).toEqual(["1B", "K", "HR", "BB"])
    const s = seasonStats(games)
    expect(s.pa).toBe(4)
    expect(s.ab).toBe(3)
    expect(s.hits).toBe(2)
    expect(s.hr).toBe(1)
    expect(s.avg).toBeCloseTo(2 / 3, 10)
  })

  it("gameLineString builds the live line", () => {
    expect(gameLineString(["1B", "HR", "K"])).toBe("2-for-3, 1 HR, 1 K")
    expect(gameLineString(["BB", "BB"])).toBe("0-for-0, 2 BB")
    expect(gameLineString([])).toBe("0-for-0")
    expect(gameLineString(["2B", "3B", "SF"])).toBe("2-for-2, 1 3B, 1 2B, 1 SF")
  })

  it("formatRate drops the leading zero, keeps 1.000+", () => {
    expect(formatRate(0.333333)).toBe(".333")
    expect(formatRate(1)).toBe("1.000")
    expect(formatRate(1.4)).toBe("1.400")
    expect(formatRate(0)).toBe(".000")
    expect(formatRate(null)).toBe("—")
  })
})

describe("rolling last-5 OPS", () => {
  const mk = (day: string, pa: PaOutcome[]) => ev("softball_game", day, { pa })

  it("null with no games; equals season OPS with ≤5 games", () => {
    expect(rollingOps([])).toBeNull()
    const games = [mk("2026-07-15", ["1B", "K"]), mk("2026-07-16", ["HR", "OUT"])]
    expect(rollingOps(games)).toBeCloseTo(seasonStats(games).ops!, 10)
  })

  it("windows to the most recent 5 games by date", () => {
    // oldest game is a disaster (0-for-4); five later perfect games
    const games = [
      mk("2026-07-01", ["K", "K", "OUT", "OUT"]),
      mk("2026-07-05", ["HR"]),
      mk("2026-07-06", ["HR"]),
      mk("2026-07-07", ["HR"]),
      mk("2026-07-08", ["HR"]),
      mk("2026-07-09", ["HR"]),
    ]
    // last 5 are all-HR: OBP 1, SLG 4, OPS 5 — the 0-fer is outside the window
    expect(rollingOps(games, 5)).toBeCloseTo(5, 10)
    // season OPS is dragged down by the opener
    expect(seasonStats(games).ops!).toBeLessThan(5)
  })

  it("order-independent: sorts by occurred_on even if array is shuffled", () => {
    const games = [
      mk("2026-07-09", ["HR"]),
      mk("2026-07-01", ["K", "K", "OUT", "OUT"]),
      mk("2026-07-07", ["HR"]),
      mk("2026-07-05", ["HR"]),
      mk("2026-07-08", ["HR"]),
      mk("2026-07-06", ["HR"]),
    ]
    expect(rollingOps(games, 5)).toBeCloseTo(5, 10)
  })
})

// ---------------------------------------------------------------- validation

describe("validatePayload (the API write gate)", () => {
  it("contact_touch requires a real bucket", () => {
    expect(validatePayload("contact_touch", { bucket: "agent" })).toEqual({
      ok: true,
      payload: { bucket: "agent" },
    })
    expect(validatePayload("contact_touch", { bucket: "seller" }).ok).toBe(true)
    expect(validatePayload("contact_touch", { bucket: "referral_partner" }).ok).toBe(true)
    expect(validatePayload("contact_touch", { bucket: "friend" }).ok).toBe(false)
    expect(validatePayload("contact_touch", {}).ok).toBe(false)
    expect(validatePayload("contact_touch", null).ok).toBe(false)
  })

  it("draft requires integer wins/losses ≥ 0", () => {
    expect(validatePayload("draft", { wins: 3, losses: 1 })).toEqual({
      ok: true,
      payload: { wins: 3, losses: 1 },
    })
    expect(validatePayload("draft", { wins: 0, losses: 0 }).ok).toBe(true)
    expect(validatePayload("draft", { wins: -1, losses: 0 }).ok).toBe(false)
    expect(validatePayload("draft", { wins: 1.5, losses: 0 }).ok).toBe(false)
    expect(validatePayload("draft", { wins: "3", losses: 0 }).ok).toBe(false)
    expect(validatePayload("draft", {}).ok).toBe(false)
  })

  it("dg_round requires a sane integer over_par (negatives fine)", () => {
    expect(validatePayload("dg_round", { over_par: 6 }).ok).toBe(true)
    expect(validatePayload("dg_round", { over_par: -3 }).ok).toBe(true)
    expect(validatePayload("dg_round", { over_par: 0 }).ok).toBe(true)
    expect(validatePayload("dg_round", { over_par: 6.5 }).ok).toBe(false)
    expect(validatePayload("dg_round", { over_par: 999 }).ok).toBe(false)
    expect(validatePayload("dg_round", {}).ok).toBe(false)
  })

  it("softball_game requires 1–30 known outcomes", () => {
    expect(validatePayload("softball_game", { pa: ["1B", "HR", "OUT"] }).ok).toBe(true)
    expect(validatePayload("softball_game", { pa: [] }).ok).toBe(false)
    expect(validatePayload("softball_game", { pa: ["HB"] }).ok).toBe(false)
    expect(validatePayload("softball_game", { pa: Array(31).fill("OUT") }).ok).toBe(false)
    expect(validatePayload("softball_game", {}).ok).toBe(false)
  })

  it("one-tap types normalize to an empty payload (extraneous keys stripped)", () => {
    for (const t of ["offer", "dg_practice", "cage"] as const) {
      expect(validatePayload(t, { junk: 1 })).toEqual({ ok: true, payload: {} })
      expect(validatePayload(t, undefined)).toEqual({ ok: true, payload: {} })
    }
  })
})
