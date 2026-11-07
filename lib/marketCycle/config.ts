import thesisJson from "@/config/market-cycle/thesis.v1.2.json"
import type { AutoRule, BetDef, CalendarEntry, Claim, Dial, Scenario, ScenarioDef, ScenarioTiming, Weights } from "./types"

// The committed thesis (config/market-cycle/thesis.v1.2.json). Pure: no I/O
// beyond the static JSON import, so it works in Next, vitest and tsx alike.

export interface ThesisConfig {
  version: string
  date: string
  scored_object: { dial_id: string; description: string; reference_peak?: { month: string; value: number } }
  scenarios: ScenarioDef[]
  partition_rule: string
  weight_moves: {
    n: number
    date: string
    from: Record<string, number | null>
    to: Weights
    readings_cited: string
    reason: string
    opposite_case: string
    reverses_if: string
    bootstrap_exception: boolean
  }[]
  claims: (Claim & { also_reads: string[]; bet?: string; auto?: AutoRule })[]
  bets: RawBet[]
  vote_rules: {
    weights_move_when: string
    cap_points: { monthly: number; claim_resolved_or_tripwire: number }
    move_requires: string
    seasonal_window_years: number
    persistence: string
  }
  tripwires: { big: { id: string; dial_id: string | null; rule: string }[] }
  dials: (Dial & { fetch?: string })[]
  calendar: { date: string; name: string; dial_id: string; tentative: boolean }[]
  checkpoint_schedule: {
    shakedown: string
    first_formal: string
    monthly: string
    quarterly_rewrite_months: string[]
  }
  geographies: {
    panels: { id: string; name: string }[]
    permanent_zips: string[]
    owned_zips_seed: string[]
  }
}

interface RawBet {
  id: string
  name: string
  pill: string
  question: string
  scored_dial: string
  scored_object?: { description: string }
  rebound_definition: string
  scenarios: ScenarioDef[] | string
  timing: Record<Scenario, ScenarioTiming>
  depth_lines: Record<Scenario, string>
  weight_moves?: ThesisConfig["weight_moves"]
  exclude_dials?: string[]
  dial_ids?: string[]
}

export const THESIS = thesisJson as unknown as ThesisConfig

/** The bets (v1.2): housing reads the top-level scenarios / weight moves
 *  (unchanged from v1.1); every other bet carries its own. */
export function configBets(cfg: ThesisConfig = THESIS): BetDef[] {
  return cfg.bets.map((b) => {
    const housing = b.id === "housing"
    const moves = housing ? cfg.weight_moves : (b.weight_moves ?? [])
    const last = moves[moves.length - 1]
    const scenarios = Array.isArray(b.scenarios) ? b.scenarios : cfg.scenarios
    const exclude = new Set(b.exclude_dials ?? [])
    const only = b.dial_ids ? new Set(b.dial_ids) : null
    return {
      id: b.id,
      name: b.name,
      pill: b.pill,
      question: b.question,
      scored_dial: b.scored_dial,
      description: housing ? cfg.scored_object.description : (b.scored_object?.description ?? b.name),
      rebound_definition: b.rebound_definition,
      scenarios,
      timing: b.timing,
      depth_lines: b.depth_lines,
      initial_weights: last ? { bear: last.to.bear, base: last.to.base, bull: last.to.bull } : { bear: 33, base: 34, bull: 33 },
      move0: last ? { date: last.date, to: last.to, reason: last.reason, opposite_case: last.opposite_case, reverses_if: last.reverses_if } : null,
      dialIn: (id: string) => (only ? only.has(id) : !exclude.has(id)),
    }
  })
}

export const BETS = configBets()
export const betById = (id: string): BetDef | undefined => BETS.find((b) => b.id === id)

/** The bet a claim belongs to: the DB row's bet_id, else the config's, else housing. */
export function claimBet(c: { id: string; bet_id?: string | null }, cfg: ThesisConfig = THESIS): string {
  return c.bet_id || cfg.claims.find((x) => x.id === c.id)?.bet || "housing"
}

/** The config's auto rule for a claim (never stored in the DB). */
export function claimAuto(id: string, cfg: ThesisConfig = THESIS): AutoRule | null {
  return cfg.claims.find((x) => x.id === id)?.auto ?? null
}

export function initialWeights(cfg: ThesisConfig = THESIS): Weights {
  const last = cfg.weight_moves[cfg.weight_moves.length - 1]
  return { bear: last.to.bear, base: last.to.base, bull: last.to.bull }
}

export function configClaims(cfg: ThesisConfig = THESIS): Claim[] {
  return cfg.claims.map((c) => ({
    id: c.id,
    text: c.text,
    category: c.category,
    scenario_tag: c.scenario_tag,
    prob_initial: c.prob_initial,
    prob_current: c.prob_current,
    resolves_on: c.resolves_on,
    falsifier: c.falsifier,
    data_source: c.data_source,
    bet_id: c.bet ?? "housing",
    status: c.status,
    resolution: null,
    resolved_at: null,
    brier_live: null,
    brier_initial: null,
  }))
}

export function configCalendar(cfg: ThesisConfig = THESIS): CalendarEntry[] {
  return cfg.calendar.map((c) => ({
    date: /^\d{4}-\d{2}-\d{2}$/.test(c.date) ? c.date : null,
    label: c.name,
    dial_id: c.dial_id,
    tentative: c.tentative,
  }))
}

/** Authored corridor keys (the config) always win; the DB row adds what the
 *  bootstrap computed (seasonal by_month stats, 2010-25 maxima, …) without
 *  overwriting an authored threshold (vote_rules.corridor_note). */
export function mergeCorridor(
  authored: Record<string, unknown> | null | undefined,
  stored: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!authored && !stored) return null
  return { ...(stored ?? {}), ...(authored ?? {}) }
}

export function configDials(cfg: ThesisConfig = THESIS, storedCorridors: Record<string, Record<string, unknown> | null> = {}): Dial[] {
  return cfg.dials.map((d) => ({
    id: d.id,
    name: d.name,
    cadence: d.cadence,
    category: d.category,
    band_rule: d.band_rule,
    direction_map: d.direction_map,
    corridor: mergeCorridor(d.corridor, storedCorridors[d.id]),
    votes: d.votes,
    has_history: d.has_history,
    units: d.units,
    transform: d.transform,
    geography: d.geography ?? null,
  }))
}

export function scenarioLabel(s: string): string {
  return s === "bear" ? "Bear" : s === "base" ? "Base" : s === "bull" ? "Bull" : s
}
