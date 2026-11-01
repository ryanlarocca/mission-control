import { THESIS, type ThesisConfig } from "./config"
import { qualifyingBloc } from "./votes"
import { SCENARIOS, type Claim, type ClaimUpdate, type DialVote, type Proposal, type Scenario, type Weights } from "./types"

// vote_rules enforcement (brief §3.4). The model proposes; this decides.
//   • A weight move is allowed only if ≥3 dials from ≥2 categories voted the
//     move's direction, OR a claim resolved this checkpoint, OR a tripwire
//     event is pending (a fired tripwire is a qualifying vote on its own).
//   • Cap: 15 points (25 with a resolution or a tripwire). "Points" = the
//     largest single-scenario change, which with three weights summing to
//     100 equals the total weight transferred. Over-cap moves are scaled
//     down (clamped), not rejected.
//   • Weights are integers 0..100 summing to 100.
//   • The log row cites ≥2 readings (dials with a reading in hand) and has a
//     non-empty opposite case naming a disagreeing reading: `opposite_reading`
//     must be a dial with a reading that did NOT vote the move's direction,
//     and if any dial voted the opposite direction it must be one of those.

export interface RulesInput {
  before: Weights
  proposal: Proposal
  votes: DialVote[]
  claims: Claim[]
  today: string
  tripwirePending: boolean
}

export interface RulesVerdict {
  ok: boolean
  weights: Weights // what to apply: clamped proposal when ok, `before` when not
  moved: boolean
  direction: Scenario | null
  cap: number
  claimResolved: boolean
  validClaimUpdates: ClaimUpdate[]
  violations: string[]
  adjustments: string[]
}

const sameWeights = (a: Weights, b: Weights) => SCENARIOS.every((s) => a[s] === b[s])

/** Scale deltas so the largest |Δ| equals `cap`, rounding by largest
 *  remainder so the result still sums to 100. */
export function clampMove(before: Weights, after: Weights, cap: number): Weights {
  const delta = SCENARIOS.map((s) => after[s] - before[s])
  const maxAbs = Math.max(...delta.map(Math.abs))
  if (maxAbs <= cap) return { ...after }
  const scaled = delta.map((d) => (d * cap) / maxAbs)
  const floored = scaled.map((d) => Math.trunc(d))
  let rem = -floored.reduce((a, b) => a + b, 0) // integer residue to hand out (keeps Σ = 0)
  const order = scaled.map((d, i) => ({ i, frac: d - floored[i] })).sort((a, b) => (rem > 0 ? b.frac - a.frac : a.frac - b.frac))
  for (const { i } of order) {
    if (rem === 0) break
    const step = rem > 0 ? 1 : -1
    if (Math.abs(floored[i] + step) > cap) continue
    floored[i] += step
    rem -= step
  }
  const out = { ...before }
  SCENARIOS.forEach((s, i) => (out[s] = before[s] + floored[i]))
  return out
}

export function moveDirection(before: Weights, after: Weights): Scenario | null {
  if (sameWeights(before, after)) return null
  const d = after.bear - before.bear - (after.bull - before.bull)
  return d > 0 ? "bear" : d < 0 ? "bull" : "base"
}

export function validateClaimUpdates(updates: ClaimUpdate[], claims: Claim[], today: string, tripwirePending: boolean): { valid: ClaimUpdate[]; violations: string[] } {
  const byId = new Map(claims.map((c) => [c.id, c]))
  const valid: ClaimUpdate[] = []
  const violations: string[] = []
  for (const u of updates) {
    const c = byId.get(u.id)
    if (!c) { violations.push(`claim ${u.id}: unknown id`); continue }
    if (c.status !== "open") { violations.push(`claim ${u.id}: already ${c.status}`); continue }
    if (u.action === "reprob") {
      if (typeof u.value !== "number" || !(u.value >= 0 && u.value <= 100)) { violations.push(`claim ${u.id}: reprob value must be 0..100`); continue }
    } else if (u.action === "resolve") {
      if (typeof u.value !== "boolean" && u.value !== "void") { violations.push(`claim ${u.id}: resolve value must be true, false or "void"`); continue }
      // Early resolution only when its falsifier/truth condition fired — the
      // claim_early tripwire — so a pending tripwire is the licence.
      if (c.resolves_on > today && !tripwirePending) { violations.push(`claim ${u.id}: not due until ${c.resolves_on} and no tripwire is pending`); continue }
    } else { violations.push(`claim ${u.id}: unknown action`); continue }
    if (!u.reason?.trim()) { violations.push(`claim ${u.id}: empty reason`); continue }
    valid.push(u)
  }
  return { valid, violations }
}

export function checkProposal(input: RulesInput, cfg: ThesisConfig = THESIS): RulesVerdict {
  const { before, proposal, votes, claims, today, tripwirePending } = input
  const violations: string[] = []
  const adjustments: string[] = []

  const claimCheck = validateClaimUpdates(proposal.claim_updates ?? [], claims, today, tripwirePending)
  violations.push(...claimCheck.violations)
  const claimResolved = claimCheck.valid.some((u) => u.action === "resolve")
  const cap = claimResolved || tripwirePending ? cfg.vote_rules.cap_points.claim_resolved_or_tripwire : cfg.vote_rules.cap_points.monthly

  const pw = proposal.proposed_weights
  const shapeOk = !!pw && SCENARIOS.every((s) => typeof pw[s] === "number" && Number.isFinite(pw[s]))
  if (!shapeOk) {
    violations.push("proposed_weights must have numeric bear, base, bull")
    return { ok: false, weights: { ...before }, moved: false, direction: null, cap, claimResolved, validClaimUpdates: claimCheck.valid, violations, adjustments }
  }
  const after: Weights = { bear: pw.bear, base: pw.base, bull: pw.bull }
  if (SCENARIOS.some((s) => !Number.isInteger(after[s]) || after[s] < 0 || after[s] > 100)) violations.push("weights must be whole numbers 0..100")
  const sum = after.bear + after.base + after.bull
  if (sum !== 100) violations.push(`weights sum to ${sum}, must be 100`)

  const direction = moveDirection(before, after)
  if (direction && violations.length === 0) {
    // Gate
    const bloc = direction === "base" ? { dials: 0, categories: 0, qualifies: false } : qualifyingBloc(votes, direction)
    if (!bloc.qualifies && !claimResolved && !tripwirePending) {
      violations.push(
        `move gate: ${bloc.dials} ${direction} vote(s) from ${bloc.categories} categor${bloc.categories === 1 ? "y" : "ies"}; needs ≥3 dials from ≥2 categories, a claim resolution, or a pending tripwire`,
      )
    }
    // Cites ≥2 readings in hand
    const inHand = new Set(votes.filter((v) => v.reading).map((v) => v.dial_id))
    const cited = Array.from(new Set((proposal.dials_moved ?? []).map((d) => d.dial_id)))
    const bogus = cited.filter((id) => !inHand.has(id))
    if (bogus.length) violations.push(`cited dial(s) with no reading in hand: ${bogus.join(", ")}`)
    if (cited.filter((id) => inHand.has(id)).length < 2) violations.push("a move must cite ≥2 readings")
    // Opposite case
    if (!proposal.opposite_case?.trim()) violations.push("opposite case is empty")
    const opp = proposal.opposite_reading
    if (!opp?.dial_id) {
      violations.push("opposite case must name a disagreeing reading (opposite_reading)")
    } else {
      const v = votes.find((x) => x.dial_id === opp.dial_id)
      const opposite: Scenario | null = direction === "bear" ? "bull" : direction === "bull" ? "bear" : null
      const opposers = opposite ? votes.filter((x) => x.vote === opposite).map((x) => x.dial_id) : []
      if (!v || !v.reading) violations.push(`opposite_reading ${opp.dial_id} has no reading in hand`)
      else if (v.vote === direction) violations.push(`opposite_reading ${opp.dial_id} voted ${direction}, the same way as the move`)
      else if (opposers.length && !opposers.includes(opp.dial_id)) violations.push(`opposite_reading must be one of the ${opposite} votes (${opposers.join(", ")}) — the strongest disagreeing reading`)
    }
  }

  if (violations.length) {
    return { ok: false, weights: { ...before }, moved: false, direction, cap, claimResolved, validClaimUpdates: claimCheck.valid, violations, adjustments }
  }
  let weights = after
  if (direction) {
    const maxAbs = Math.max(...SCENARIOS.map((s) => Math.abs(after[s] - before[s])))
    if (maxAbs > cap) {
      weights = clampMove(before, after, cap)
      adjustments.push(`clamped a ${maxAbs}-point move to the ${cap}-point cap: ${SCENARIOS.map((s) => `${s} ${after[s]}→${weights[s]}`).join(", ")}`)
    }
  }
  return { ok: true, weights, moved: !!direction, direction, cap, claimResolved, validClaimUpdates: claimCheck.valid, violations, adjustments }
}

/** The fallback when a proposal fails twice: keep the weights, keep only
 *  the claim updates that passed on their own, log the violations. */
export function noMoveProposal(before: Weights, base: Partial<Proposal>, validClaimUpdates: ClaimUpdate[], violations: string[]): Proposal {
  return {
    proposed_weights: { ...before },
    argument: `No move: the proposal broke the vote rules (${violations.slice(0, 2).join("; ")}).`,
    opposite_case: base.opposite_case ?? "",
    opposite_reading: base.opposite_reading ?? null,
    reverses_if: null,
    dials_moved: base.dials_moved ?? [],
    claim_updates: validClaimUpdates,
    next_dates: base.next_dates ?? [],
  }
}
