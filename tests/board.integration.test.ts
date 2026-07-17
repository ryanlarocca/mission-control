import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { getLeadsClient } from "@/lib/leads"
import { fetchActivePeriod, fetchPeriodEvents } from "@/lib/boardDb"
import { GET as boardGET } from "@/app/api/board/route"
import { DELETE as eventsDELETE, PATCH as eventsPATCH, POST as eventsPOST } from "@/app/api/board/events/route"
import { GET as periodsGET, PATCH as periodsPATCH, POST as periodsPOST } from "@/app/api/board/periods/route"

// Integration tests run against the REAL LRG Supabase project through the
// actual route handlers. Everything happens inside a throwaway board_period
// parked in 1999 — fetchActivePeriod resolves by containment first and falls
// back to the LATEST period, so a 1999 block can never shadow the live one —
// and afterAll deletes the period, cascading away every event we created.

const T0 = "1999-01-01"
const T_MID = "1999-02-01"
const T1 = "1999-03-31"
const LABEL = "INTEGRATION-TEST — safe to delete"

let periodId = ""

const url = (path: string) => `http://mc.test${path}`
const jsonReq = (path: string, method: string, body: unknown) =>
  new Request(url(path), {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

async function post(body: unknown) {
  const res = await eventsPOST(jsonReq("/api/board/events", "POST", body))
  return { status: res.status, data: await res.json() }
}

beforeAll(async () => {
  // Belt-and-braces: clear any leftovers from a previously crashed run.
  await getLeadsClient().from("board_periods").delete().eq("label", LABEL)

  const res = await periodsPOST(
    jsonReq("/api/board/periods", "POST", { label: LABEL, starts_on: T0, ends_on: T1 })
  )
  const data = await res.json()
  expect(res.status).toBe(200)
  expect(data.success).toBe(true)
  periodId = data.period.id
})

afterAll(async () => {
  if (!periodId) return
  const { error } = await getLeadsClient().from("board_periods").delete().eq("id", periodId)
  expect(error).toBeNull()
  // cascade check: no orphaned events survive the period delete
  const { count } = await getLeadsClient()
    .from("board_events")
    .select("id", { count: "exact", head: true })
    .eq("period_id", periodId)
  expect(count).toBe(0)
})

describe("periods route", () => {
  it("lists the created period", async () => {
    const res = await periodsGET()
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.periods.some((p: { id: string }) => p.id === periodId)).toBe(true)
  })

  it("PATCH updates the label and validates input", async () => {
    const ok = await periodsPATCH(
      jsonReq("/api/board/periods", "PATCH", { id: periodId, label: LABEL })
    )
    expect(ok.status).toBe(200)

    const bad = await periodsPATCH(
      jsonReq("/api/board/periods", "PATCH", { id: periodId, starts_on: "not-a-date" })
    )
    expect(bad.status).toBe(400)

    const missing = await periodsPATCH(
      jsonReq("/api/board/periods", "PATCH", { id: "00000000-0000-0000-0000-000000000000", label: "x" })
    )
    expect(missing.status).toBe(404)
  })

  it("POST rejects inverted ranges and blank labels", async () => {
    const inverted = await periodsPOST(
      jsonReq("/api/board/periods", "POST", { label: "x", starts_on: T1, ends_on: T0 })
    )
    expect(inverted.status).toBe(400)
    const blank = await periodsPOST(
      jsonReq("/api/board/periods", "POST", { label: "  ", starts_on: T0, ends_on: T1 })
    )
    expect(blank.status).toBe(400)
  })
})

describe("board GET", () => {
  it("empty-data state: period resolves with zero events", async () => {
    const res = await boardGET(new Request(url(`/api/board?date=${T_MID}`)))
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.period.id).toBe(periodId)
    expect(data.events).toEqual([])
  })

  it("rejects a missing/malformed date", async () => {
    expect((await boardGET(new Request(url("/api/board")))).status).toBe(400)
    expect((await boardGET(new Request(url("/api/board?date=1999-02-30")))).status).toBe(400)
  })
})

describe("event writes — every type round-trips", () => {
  it("logs one of each event type and reads them back verbatim", async () => {
    const writes: [string, Record<string, unknown>][] = [
      ["contact_touch", { bucket: "agent" }],
      ["contact_touch", { bucket: "seller" }],
      ["contact_touch", { bucket: "referral_partner" }],
      ["offer", {}],
      ["appointment", {}],
      ["draft", { wins: 3, losses: 1 }],
      ["dg_round", { over_par: -2 }],
      ["dg_practice", {}],
      ["cage", {}],
      ["softball_game", { pa: ["1B", "HR", "BB", "SF", "K", "OUT"] }],
    ]
    for (const [event_type, payload] of writes) {
      const { status, data } = await post({ event_type, occurred_on: T_MID, payload })
      expect(status).toBe(200)
      expect(data.success).toBe(true)
      expect(data.event.period_id).toBe(periodId)
      expect(data.event.occurred_on).toBe(T_MID) // Postgres date round-trips as YYYY-MM-DD
      expect(data.event.payload).toEqual(payload)
    }

    const res = await boardGET(new Request(url(`/api/board?date=${T_MID}`)))
    const data = await res.json()
    expect(data.events).toHaveLength(writes.length)
    const types = data.events.map((e: { event_type: string }) => e.event_type)
    expect(new Set(types).size).toBe(8)
  })

  it("midnight boundary: consecutive days stay distinct through the round-trip", async () => {
    const day1 = "1999-02-10"
    const day2 = "1999-02-11" // the tap that lands just after local midnight
    await post({ event_type: "offer", occurred_on: day1 })
    await post({ event_type: "offer", occurred_on: day2 })
    const res = await boardGET(new Request(url(`/api/board?date=${T_MID}`)))
    const data = await res.json()
    const offers = data.events.filter((e: { event_type: string }) => e.event_type === "offer")
    expect(offers.some((e: { occurred_on: string }) => e.occurred_on === day1)).toBe(true)
    expect(offers.some((e: { occurred_on: string }) => e.occurred_on === day2)).toBe(true)
  })

  it("validation: bad payloads, bad dates, junk types are all 400s", async () => {
    expect((await post({ event_type: "contact_touch", occurred_on: T_MID, payload: { bucket: "friend" } })).status).toBe(400)
    expect((await post({ event_type: "draft", occurred_on: T_MID, payload: { wins: -1, losses: 0 } })).status).toBe(400)
    expect((await post({ event_type: "dg_round", occurred_on: T_MID, payload: { over_par: 1.5 } })).status).toBe(400)
    expect((await post({ event_type: "softball_game", occurred_on: T_MID, payload: { pa: [] } })).status).toBe(400)
    expect((await post({ event_type: "sleep", occurred_on: T_MID })).status).toBe(400)
    expect((await post({ event_type: "offer", occurred_on: "1999-2-1" })).status).toBe(400)
    expect((await post({ event_type: "offer", occurred_on: T_MID, relationship_id: periodId })).status).toBe(400)
  })
})

describe("undo / delete paths", () => {
  it("deletes a logged event; a second delete (double-tapped undo) is a clean 404", async () => {
    const { data } = await post({ event_type: "cage", occurred_on: "1999-02-15" })
    const id = data.event.id

    const del1 = await eventsDELETE(jsonReq("/api/board/events", "DELETE", { id }))
    expect(del1.status).toBe(200)
    expect((await del1.json()).success).toBe(true)

    const del2 = await eventsDELETE(jsonReq("/api/board/events", "DELETE", { id }))
    expect(del2.status).toBe(404) // decrement-below-zero can't happen: nothing left to delete

    const res = await boardGET(new Request(url(`/api/board?date=${T_MID}`)))
    const events = (await res.json()).events
    expect(events.some((e: { id: string }) => e.id === id)).toBe(false)
  })

  it("rejects a delete with no id", async () => {
    expect((await eventsDELETE(jsonReq("/api/board/events", "DELETE", {}))).status).toBe(400)
  })

  it("duplicate rapid taps create distinct rows — both undoable", async () => {
    const [a, b] = await Promise.all([
      post({ event_type: "contact_touch", occurred_on: "1999-02-16", payload: { bucket: "agent" } }),
      post({ event_type: "contact_touch", occurred_on: "1999-02-16", payload: { bucket: "agent" } }),
    ])
    expect(a.data.event.id).not.toBe(b.data.event.id)
    for (const r of [a, b]) {
      const del = await eventsDELETE(jsonReq("/api/board/events", "DELETE", { id: r.data.event.id }))
      expect(del.status).toBe(200)
    }
  })
})

describe("contact linking (PATCH)", () => {
  it("links a touch to a real relationships row and unlinks it", async () => {
    const { data: rels } = await getLeadsClient().from("relationships").select("id").limit(1)
    if (!rels?.length) return // empty book of business — nothing to link against

    const relId = rels[0].id
    const { data } = await post({
      event_type: "contact_touch",
      occurred_on: "1999-02-20",
      payload: { bucket: "agent" },
    })

    const link = await eventsPATCH(
      jsonReq("/api/board/events", "PATCH", { id: data.event.id, relationship_id: relId })
    )
    expect(link.status).toBe(200)
    expect((await link.json()).event.relationship_id).toBe(relId)

    const unlink = await eventsPATCH(
      jsonReq("/api/board/events", "PATCH", { id: data.event.id, relationship_id: null })
    )
    expect(unlink.status).toBe(200)
    expect((await unlink.json()).event.relationship_id).toBeNull()
  })

  it("linking at POST time works for contact_touch", async () => {
    const { data: rels } = await getLeadsClient().from("relationships").select("id").limit(1)
    if (!rels?.length) return
    const { status, data } = await post({
      event_type: "contact_touch",
      occurred_on: "1999-02-21",
      payload: { bucket: "seller" },
      relationship_id: rels[0].id,
    })
    expect(status).toBe(200)
    expect(data.event.relationship_id).toBe(rels[0].id)
  })

  it("404s on a nonexistent event id", async () => {
    const res = await eventsPATCH(
      jsonReq("/api/board/events", "PATCH", {
        id: "00000000-0000-0000-0000-000000000000",
        relationship_id: null,
      })
    )
    expect(res.status).toBe(404)
  })
})

describe("PostgREST 1000-row cap", () => {
  it("fetchPeriodEvents pages past 1000 events", async () => {
    const supabase = getLeadsClient()
    const before = await fetchPeriodEvents(supabase, periodId)

    const BULK = 1005
    const rows = Array.from({ length: BULK }, (_, i) => ({
      period_id: periodId,
      event_type: "contact_touch",
      occurred_on: "1999-03-01",
      payload: { bucket: (["agent", "seller", "referral_partner"] as const)[i % 3] },
      relationship_id: null,
    }))
    const { error } = await supabase.from("board_events").insert(rows)
    expect(error).toBeNull()

    const after = await fetchPeriodEvents(supabase, periodId)
    expect(after.length).toBe(before.length + BULK) // a bare .select() would cap at 1000

    // the API route returns the full set too
    const res = await boardGET(new Request(url(`/api/board?date=${T_MID}`)))
    expect((await res.json()).events.length).toBe(after.length)
  })
})

describe("period resolution", () => {
  it("a date inside the block resolves to it; the 1999 block never shadows the live period", async () => {
    const inBlock = await fetchActivePeriod(getLeadsClient(), T_MID)
    expect(inBlock?.id).toBe(periodId)

    // today's date must NOT resolve to the 1999 test block
    const today = new Date().toISOString().slice(0, 10)
    const live = await fetchActivePeriod(getLeadsClient(), today)
    expect(live?.id).not.toBe(periodId)
  })
})
