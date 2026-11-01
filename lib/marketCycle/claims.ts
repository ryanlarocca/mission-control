import type { Checkpoint, Claim, ClaimUpdate } from "./types"

// Claims bookkeeping (brief §2.2 "Scoring"). Pure.
//   live Brier    = on the probability held at the last checkpoint before
//                   the resolution date (prob_initial if none moved it)
//   initial Brier = on prob_initial (did updating help?)

/** Open claims whose resolve-by date has arrived. */
export function dueClaims(claims: Claim[], today: string): Claim[] {
  return claims.filter((c) => c.status === "open" && c.resolves_on <= today)
}

export function openClaims(claims: Claim[]): Claim[] {
  return claims.filter((c) => c.status === "open")
}

/** Brier score for a probability in percent and a boolean outcome. */
export function brier(probPct: number, outcome: boolean): number {
  const p = probPct / 100
  return Math.round((p - (outcome ? 1 : 0)) ** 2 * 10_000) / 10_000
}

/** The probability a claim held at the last checkpoint strictly before
 *  `resolvedOn`: replay every re-probabilisation logged on earlier
 *  checkpoints, oldest first, starting from prob_initial. */
export function liveProbability(claim: Claim, checkpoints: Checkpoint[], resolvedOn: string): number {
  let p = claim.prob_initial
  const earlier = checkpoints.filter((c) => c.date < resolvedOn).sort((a, b) => a.date.localeCompare(b.date) || (a.created_at ?? "").localeCompare(b.created_at ?? ""))
  for (const cp of earlier) {
    for (const u of cp.claims_resolved ?? []) {
      if (u.id === claim.id && u.action === "reprob" && typeof u.value === "number") p = u.value
    }
  }
  return p
}

/** Resolve a claim: status, resolution, both Brier scores. "void" scores nothing. */
export function resolveClaim(claim: Claim, outcome: boolean | "void", resolvedOn: string, checkpoints: Checkpoint[]): Claim {
  if (outcome === "void") {
    return { ...claim, status: "void", resolution: null, resolved_at: resolvedOn, brier_live: null, brier_initial: null }
  }
  const live = liveProbability(claim, checkpoints, resolvedOn)
  return {
    ...claim,
    status: "resolved",
    resolution: outcome,
    resolved_at: resolvedOn,
    brier_live: brier(live, outcome),
    brier_initial: brier(claim.prob_initial, outcome),
  }
}

/** Apply validated claim updates; returns the changed claims only. */
export function applyClaimUpdates(claims: Claim[], updates: ClaimUpdate[], today: string, checkpoints: Checkpoint[]): Claim[] {
  const byId = new Map(claims.map((c) => [c.id, c]))
  const changed = new Map<string, Claim>()
  for (const u of updates) {
    const c = changed.get(u.id) ?? byId.get(u.id)
    if (!c || c.status !== "open") continue
    if (u.action === "reprob" && typeof u.value === "number") changed.set(u.id, { ...c, prob_current: u.value })
    if (u.action === "resolve" && (typeof u.value === "boolean" || u.value === "void")) changed.set(u.id, resolveClaim(c, u.value, today, checkpoints))
  }
  return Array.from(changed.values())
}

/** Running mean Brier by claim category (resolved claims only). */
export function brierByCategory(claims: Claim[]): Record<string, { n: number; live: number; initial: number }> {
  const out: Record<string, { n: number; live: number; initial: number }> = {}
  for (const c of claims) {
    if (c.status !== "resolved" || c.brier_live == null || c.brier_initial == null) continue
    const o = (out[c.category] ??= { n: 0, live: 0, initial: 0 })
    o.live = (o.live * o.n + c.brier_live) / (o.n + 1)
    o.initial = (o.initial * o.n + c.brier_initial) / (o.n + 1)
    o.n++
  }
  return out
}
