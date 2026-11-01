// Market-cycle tracker types (briefs/BRIEF_MARKET_CYCLE_TRACKER_2026-11-01.md).
// Shapes mirror config/market-cycle/thesis.v1.1.json and the cycle_* tables
// in supabase/migrations/2026-11-01_market_cycle.sql.

export type Scenario = "bear" | "base" | "bull"
export const SCENARIOS: Scenario[] = ["bear", "base", "bull"]
export type Weights = Record<Scenario, number>
export type Side = Scenario | "neutral"
export type CheckpointKind = "shakedown" | "monthly" | "quarterly" | "tripwire"

export interface ScenarioDef {
  id: Scenario
  name: string
  definition: string
  weight: number
  drawdown_bounds_pct: { min: number | null; max: number | null }
  markers?: string
}

export interface Dial {
  id: string
  name: string
  cadence: "daily" | "weekly" | "monthly" | "quarterly" | "event"
  category: string
  band_rule: "seasonal_1sd" | "corridor" | "event"
  direction_map: { up?: Side; down?: Side }
  /** Authored thresholds (config) merged with bootstrap-computed stats (DB). */
  corridor: Record<string, unknown> | null
  votes: boolean
  has_history: boolean
  units?: string
  transform?: string
  geography?: string | null
}

export interface Reading {
  dial_id: string
  as_of: string // YYYY-MM-DD
  value: number | null
  source_url?: string
  raw?: string | null
}

export interface Claim {
  id: string
  text: string
  category: string
  scenario_tag: Scenario
  prob_initial: number
  prob_current: number
  resolves_on: string
  falsifier: string
  data_source: string
  status: "open" | "resolved" | "void"
  resolution?: boolean | null
  resolved_at?: string | null
  brier_live?: number | null
  brier_initial?: number | null
}

export interface ClaimUpdate {
  id: string
  action: "resolve" | "reprob"
  /** resolve: true | false | "void"; reprob: 0..100 */
  value: boolean | number | "void"
  reason: string
}

export interface Checkpoint {
  id: string
  date: string
  kind: CheckpointKind
  weights_before: Weights | null
  weights_after: Weights | null
  votes: unknown
  argument: string | null
  opposite_case: string | null
  /** Applied claim updates (resolutions + re-probabilisations). */
  claims_resolved: ClaimUpdate[] | null
  next_dates: string[] | null
  telegram_message_id: string | null
  ryan_note: string | null
  created_at?: string
}

export interface WeightMove {
  id?: number
  checkpoint_id: string | null
  date: string
  from_weights: Partial<Record<Scenario, number | null>>
  to_weights: Weights
  readings_cited: unknown
  argument: string
  opposite_case: string
  reverses_if: string | null
  bootstrap_exception: boolean
}

/** Sibling workstream table (defensive read: may not exist yet). */
export interface TripwireEvent {
  id?: string | number
  tripwire_id: string
  dial_id: string | null
  fired_on: string
  reading: number | string | null
  detail: string | null
  review_requested: boolean
  reviewed_at: string | null
}

/** Sibling workstream table (defensive read: may not exist yet). */
export interface CycleNote {
  date: string
  dial_id: string | null
  text: string
  kind: string | null
  surfaced_at: string | null
}

export interface CalendarEntry {
  date: string | null // null = TBD
  label: string
  dial_id: string | null
  tentative: boolean
}

export interface OwnedProperty {
  address: string | null
  zip: string
  flag: "for_sale" | "held" | "home"
  bought_on?: string | null
  listed_on?: string | null
  sold_on?: string | null
}

export type VoteKind = Scenario | "none" | "unexplained"

export interface DialVote {
  dial_id: string
  name: string
  category: string
  vote: VoteKind
  /** The reading the vote rests on (after any 10-day / 2-day read). */
  reading: { as_of: string; value: number } | null
  /** Human description of the band the reading was tested against. */
  band: string
  z: number | null
  outside: "up" | "down" | null
  /** Scenario an out-of-band reading points to, persistent or not (display + opposite case). */
  leaning: VoteKind | null
  persistent: boolean
  reason: string
}

export interface CategoryTally {
  bear: string[]
  base: string[]
  bull: string[]
  unexplained: string[]
}

export interface Tally {
  byCategory: Record<string, CategoryTally>
  totals: Record<VoteKind, number>
}

export interface DialMoved {
  dial_id: string
  reading: string
  direction: "up" | "down"
  scenario: Scenario
}

/** The strict JSON the review model returns (prompt.ts). */
export interface Proposal {
  proposed_weights: Weights
  argument: string
  opposite_case: string
  /** Machine-checkable pointer to the disagreeing reading the opposite case names. */
  opposite_reading: { dial_id: string; reading: string } | null
  reverses_if?: string | null
  dials_moved: DialMoved[]
  claim_updates: ClaimUpdate[]
  next_dates: string[]
}

/** Everything a review needs, loaded from Supabase or a fixture. */
export interface ReviewState {
  today: string
  weights: Weights
  dials: Dial[]
  readings: Record<string, Reading[]> // dial_id → ascending by as_of
  claims: Claim[]
  checkpoints: Checkpoint[] // newest first
  weightMoves: WeightMove[] // newest first
  tripwireEvents: TripwireEvent[]
  notes: CycleNote[]
  calendar: CalendarEntry[]
  ownedProperties: OwnedProperty[]
  /** Optional tables that could not be read (sibling migrations not applied yet). */
  missingTables: string[]
}
