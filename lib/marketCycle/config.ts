import thesisJson from "@/config/market-cycle/thesis.v1.1.json"
import type { CalendarEntry, Claim, Dial, ScenarioDef, Weights } from "./types"

// The committed thesis (config/market-cycle/thesis.v1.1.json). Pure: no I/O
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
  claims: (Claim & { also_reads: string[] })[]
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

export const THESIS = thesisJson as unknown as ThesisConfig

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
