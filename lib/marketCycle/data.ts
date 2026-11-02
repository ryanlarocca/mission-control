import type { SupabaseClient } from "@supabase/supabase-js"
import { THESIS, configCalendar, configClaims, configDials, initialWeights } from "./config"
import type {
  CalendarEntry,
  Checkpoint,
  Claim,
  CycleNote,
  OwnedProperty,
  Reading,
  ReviewState,
  TripwireEvent,
  WeightMove,
  Weights,
} from "./types"

// I/O for the market-cycle review: Supabase (service role, LRG project) or a
// JSON fixture. The sibling workstreams' tables (cycle_tripwire_events,
// cycle_notes) are read defensively — a missing table reads as empty.

const PAGE = 1000 // PostgREST default row cap — always paginate

function isMissingTable(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false
  return err.code === "42P01" || err.code === "PGRST205" || /does not exist|could not find the table/i.test(err.message ?? "")
}

function shiftDays(day: string, n: number): string {
  const d = new Date(day + "T00:00:00Z")
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function groupReadings(rows: Reading[]): Record<string, Reading[]> {
  const out: Record<string, Reading[]> = {}
  for (const r of rows) (out[r.dial_id] ??= []).push({ ...r, value: r.value === null || r.value === undefined ? null : Number(r.value) })
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.as_of.localeCompare(b.as_of))
  return out
}

export function todayPT(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
}

type Page = PromiseLike<{ data: unknown[] | null; error: { code?: string; message?: string } | null }>
/** `page(from, to)` must be an ordered query paged with range(from, to). */
async function paginate<T>(page: (from: number, to: number) => Page): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    out.push(...((data ?? []) as T[]))
    if (!data || data.length < PAGE) break
  }
  return out
}

export async function loadFromSupabase(sb: SupabaseClient, today: string = todayPT()): Promise<ReviewState> {
  const missingTables: string[] = []
  const core = async <T>(table: string, q: PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>): Promise<T[]> => {
    const { data, error } = await q
    if (error) throw new Error(`${table}: ${error.message}`)
    return (data ?? []) as T[]
  }
  const optional = async <T>(table: string, q: PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>): Promise<T[]> => {
    const { data, error } = await q
    if (isMissingTable(error)) {
      missingTables.push(table)
      return []
    }
    if (error) throw new Error(`${table}: ${error.message}`)
    return (data ?? []) as T[]
  }

  const dialRows = await core<{ id: string; corridor: Record<string, unknown> | null }>("cycle_dials", sb.from("cycle_dials").select("id, corridor"))
  const dials = configDials(THESIS, Object.fromEntries(dialRows.map((d) => [d.id, d.corridor])))
  const seasonalIds = dials.filter((d) => d.band_rule === "seasonal_1sd").map((d) => d.id)
  const recentSince = shiftDays(today, -400)
  const seasonalSince = shiftDays(today, -6 * 366)
  const sel = "dial_id, as_of, value, source_url, raw"
  const [recent, older] = await Promise.all([
    paginate<Reading>((a, b) => sb.from("cycle_readings").select(sel).gte("as_of", recentSince).lte("as_of", today).order("as_of").order("id").range(a, b)),
    paginate<Reading>((a, b) => sb.from("cycle_readings").select(sel).in("dial_id", seasonalIds).gte("as_of", seasonalSince).lt("as_of", recentSince).order("as_of").order("id").range(a, b)),
  ])

  const [claims, checkpoints, weightMoves, calendar, owned, events, notes] = await Promise.all([
    core<Claim>("cycle_claims", sb.from("cycle_claims").select("*").order("id")),
    core<Checkpoint>("cycle_checkpoints", sb.from("cycle_checkpoints").select("*").order("date", { ascending: false }).order("created_at", { ascending: false }).limit(48)),
    core<WeightMove>("cycle_weight_moves", sb.from("cycle_weight_moves").select("*").order("date", { ascending: false }).order("id", { ascending: false }).limit(60)),
    core<CalendarEntry>("cycle_calendar", sb.from("cycle_calendar").select("date, label, dial_id, tentative").order("date")),
    core<OwnedProperty>("cycle_owned_properties", sb.from("cycle_owned_properties").select("address, zip, flag, bought_on, listed_on, sold_on").is("retired_at", null)),
    optional<TripwireEvent>("cycle_tripwire_events", sb.from("cycle_tripwire_events").select("*").order("fired_on", { ascending: false }).limit(200)),
    optional<CycleNote>("cycle_notes", sb.from("cycle_notes").select("*").order("date", { ascending: false }).limit(200)),
  ])

  const claimRows = claims.length ? claims.map((c) => ({ ...c, prob_initial: Number(c.prob_initial), prob_current: Number(c.prob_current) })) : configClaims()
  const latest = weightMoves[0]?.to_weights
  return {
    today,
    weights: latest ? { bear: Number(latest.bear), base: Number(latest.base), bull: Number(latest.bull) } : initialWeights(),
    dials,
    readings: groupReadings([...older, ...recent]),
    claims: claimRows,
    checkpoints,
    weightMoves,
    tripwireEvents: events,
    notes,
    calendar: calendar.length ? calendar : configCalendar(),
    ownedProperties: owned,
    missingTables,
  }
}

// ---------------------------------------------------------------- fixture
export interface Fixture {
  today?: string
  weights?: Weights
  dial_corridors?: Record<string, Record<string, unknown>>
  readings: Reading[]
  claims?: (Partial<Claim> & { id: string })[]
  checkpoints?: Checkpoint[]
  weight_moves?: WeightMove[]
  tripwire_events?: TripwireEvent[]
  notes?: CycleNote[]
  calendar?: CalendarEntry[]
  owned_properties?: OwnedProperty[]
}

export function stateFromFixture(fx: Fixture, todayOverride?: string): ReviewState {
  const overrides = new Map((fx.claims ?? []).map((c) => [c.id, c]))
  const claims = configClaims().map((c) => ({ ...c, ...(overrides.get(c.id) ?? {}) }) as Claim)
  return {
    today: todayOverride ?? fx.today ?? todayPT(),
    weights: fx.weights ?? fx.weight_moves?.[0]?.to_weights ?? initialWeights(),
    dials: configDials(THESIS, fx.dial_corridors ?? {}),
    readings: groupReadings(fx.readings ?? []),
    claims,
    checkpoints: fx.checkpoints ?? [],
    weightMoves: fx.weight_moves ?? [],
    tripwireEvents: fx.tripwire_events ?? [],
    notes: fx.notes ?? [],
    calendar: fx.calendar ?? configCalendar(),
    ownedProperties: fx.owned_properties ?? [
      { address: "5764 Halleck Dr, San Jose, CA 95123", zip: "95123", flag: "for_sale", listed_on: "2026-10-14" },
      { address: "2116 Quito Rd, San Jose, CA 95130", zip: "95130", flag: "for_sale", listed_on: "2026-10-22" },
      { address: null, zip: "95118", flag: "home" },
    ],
    missingTables: [],
  }
}

// ---------------------------------------------------------------- writes
export interface CheckpointWriter {
  insertCheckpoint(row: Omit<Checkpoint, "id" | "created_at">): Promise<string>
  insertWeightMove(row: Omit<WeightMove, "id">): Promise<void>
  updateClaims(rows: Claim[]): Promise<void>
  setTelegramMessageId(checkpointId: string, messageId: number): Promise<void>
  markTripwiresReviewed(ids: (string | number)[], at: string): Promise<void>
}

export function supabaseWriter(sb: SupabaseClient): CheckpointWriter {
  return {
    async insertCheckpoint(row) {
      const { data, error } = await sb.from("cycle_checkpoints").insert(row).select("id").single()
      if (error) throw new Error(`cycle_checkpoints insert: ${error.message}`)
      return (data as { id: string }).id
    },
    async insertWeightMove(row) {
      const { error } = await sb.from("cycle_weight_moves").insert(row)
      if (error) throw new Error(`cycle_weight_moves insert: ${error.message}`)
    },
    async updateClaims(rows) {
      for (const c of rows) {
        const { error } = await sb
          .from("cycle_claims")
          .update({
            prob_current: c.prob_current,
            status: c.status,
            resolution: c.resolution ?? null,
            resolved_at: c.resolved_at ? new Date(c.resolved_at + "T12:00:00Z").toISOString() : null,
            brier_live: c.brier_live ?? null,
            brier_initial: c.brier_initial ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", c.id)
        if (error) throw new Error(`cycle_claims ${c.id}: ${error.message}`)
      }
    },
    async setTelegramMessageId(checkpointId, messageId) {
      const { error } = await sb.from("cycle_checkpoints").update({ telegram_message_id: String(messageId) }).eq("id", checkpointId)
      if (error) throw new Error(`cycle_checkpoints telegram id: ${error.message}`)
    },
    async markTripwiresReviewed(ids, at) {
      if (!ids.length) return
      const { error } = await sb.from("cycle_tripwire_events").update({ reviewed_at: at }).in("id", ids)
      if (error && !isMissingTable(error)) throw new Error(`cycle_tripwire_events: ${error.message}`)
    },
  }
}

/** Disagree reply → ryan_note on the checkpoint whose card it answers.
 *  Appends (dated) when a note already exists. Returns the checkpoint date. */
export async function storeRyanNote(sb: SupabaseClient, cardMessageId: number, note: string): Promise<string | null> {
  const { data, error } = await sb.from("cycle_checkpoints").select("id, date, ryan_note").eq("telegram_message_id", String(cardMessageId)).maybeSingle()
  if (error || !data) return null
  const row = data as { id: string; date: string; ryan_note: string | null }
  const stamped = `[${todayPT()}] ${note.trim()}`
  const { error: upErr } = await sb.from("cycle_checkpoints").update({ ryan_note: row.ryan_note ? `${row.ryan_note}\n${stamped}` : stamped }).eq("id", row.id)
  if (upErr) throw new Error(upErr.message)
  return row.date
}

/** Is this Telegram message one of our checkpoint cards? */
export async function checkpointByCard(sb: SupabaseClient, cardMessageId: number): Promise<{ id: string; date: string } | null> {
  const { data, error } = await sb.from("cycle_checkpoints").select("id, date").eq("telegram_message_id", String(cardMessageId)).maybeSingle()
  if (error || !data) return null
  return data as { id: string; date: string }
}

export async function checkpointById(sb: SupabaseClient, id: string): Promise<{ id: string; date: string; telegram_message_id: string | null } | null> {
  const { data, error } = await sb.from("cycle_checkpoints").select("id, date, telegram_message_id").eq("id", id).maybeSingle()
  if (error || !data) return null
  return data as { id: string; date: string; telegram_message_id: string | null }
}
