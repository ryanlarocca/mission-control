import { THESIS, claimBet } from "./config"
import { longDate } from "./card"
import { corridorSeries } from "./votes"
import type { BetDef, Claim, DialVote, ReviewState, TripwireEvent } from "./types"

// Which dials, claims and tripwires belong to which bet (thesis v1.2), and the
// "Now:" line each bet shows on the card and the page. Pure.

export const BET_EMOJI: Record<string, string> = { housing: "🏠", spx: "📈" }

export function betVotes(bet: BetDef, votes: DialVote[]): DialVote[] {
  return votes.filter((v) => bet.dialIn(v.dial_id))
}

export function betClaims(bet: BetDef, claims: Claim[]): Claim[] {
  return claims.filter((c) => claimBet(c) === bet.id)
}

/** A pending tripwire speaks to a bet when the tripwire names that bet, or —
 *  for the shared ones — when it's housing (the original thesis) or the
 *  tripwire's dial is one of the bet's dials. */
export function tripwireApplies(bet: BetDef, e: TripwireEvent & { bet_id?: string | null }): boolean {
  const def = (THESIS.tripwires.big as { id: string; dial_id: string | null; bet?: string }[]).find((t) => t.id === e.tripwire_id)
  const named = e.bet_id || def?.bet
  if (named) return named === bet.id
  return bet.id === "housing" || (!!e.dial_id && bet.dialIn(e.dial_id))
}

const monthYear = (iso: string) => longDate(iso).replace(/ \d+,/, "")
const pct = (v: number) => `${Math.abs(v).toFixed(1)}% ${v < 0 ? "below" : "above"}`

/** "3.4% below the Jan 2025 peak ($1.72M, Sep 2026)" / "1.7% below the Oct 6, 2026 high (7,689, Nov 4)". */
export function betNow(bet: BetDef, state: Pick<ReviewState, "dials" | "readings">): string | null {
  if (bet.id === "housing") {
    const dd = (state.readings["zhvi_scc_drawdown"] ?? []).filter((r) => r.value !== null).pop()
    const lvl = (state.readings["zhvi_scc"] ?? []).filter((r) => r.value !== null).pop()
    if (!dd) return null
    const peak = THESIS.scored_object.reference_peak
    const peakTxt = peak ? `the ${monthYear(peak.month + "-01")} peak` : "the peak"
    return `${pct(dd.value as number)} ${peakTxt}${lvl ? ` ($${((lvl.value as number) / 1e6).toFixed(2)}M, ${monthYear(lvl.as_of)})` : ` (${monthYear(dd.as_of)})`}`
  }
  const dial = state.dials.find((d) => d.id === bet.scored_dial)
  const rows = state.readings[bet.scored_dial] ?? []
  if (!dial || !rows.length) return null
  const series = corridorSeries(dial, rows)
  const last = series[series.length - 1]
  const lvl = rows.filter((r) => r.value !== null).pop()
  const anchor = /drawdown_from_(\d{4}-\d{2}-\d{2})_high/.exec(String((dial.corridor ?? {}).transform ?? ""))?.[1]
  if (!last || !lvl || !anchor) return null
  const day = longDate(lvl.as_of).replace(/, \d{4}$/, "")
  return `${pct(last.value)} the ${longDate(anchor)} high (${Math.round(lvl.value as number).toLocaleString("en-US")}, ${day})`
}

/** A claim in a few words for the card: its text up to the first clause. */
export function claimShort(c: Pick<Claim, "text">, n = 70): string {
  const t = c.text.replace(/\s*\([^)]*\)/g, "").split(/[:;]/)[0].trim()
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t
}
