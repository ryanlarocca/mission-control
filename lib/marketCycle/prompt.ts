import { THESIS, type ThesisConfig } from "./config"
import { dueClaims, openClaims } from "./claims"
import { pendingTripwires } from "./schedule"
import { formatValue, tallyLine } from "./votes"
import { SCENARIOS, type CheckpointKind, type DialVote, type Proposal, type ReviewState, type Scenario, type Tally, type Weights } from "./types"

// The Opus review prompt (brief §3.5 / Part 4 Phase 2). It states the vote
// rules so the model proposes legal moves; rules.ts is still the enforcer.
// Output is STRICT JSON (lib/llm.ts has no tool/structured-output mode — the
// repo's pattern is JSON-only text + extractJsonObject).

export const PROPOSAL_SHAPE = `{
  "proposed_weights": {"bear": <int>, "base": <int>, "bull": <int>},
  "argument": "<= 2 short phone lines (max ~160 characters): why the weights are what they are",
  "opposite_case": "<= 2 short phone lines (max ~200 characters), written against the NEW weights, naming the strongest reading that disagrees",
  "opposite_reading": {"dial_id": "<id of that disagreeing dial>", "reading": "<its value + as-of>"},
  "reverses_if": "<one line: what would reverse this move, or null>",
  "dials_moved": [{"dial_id": "<id>", "reading": "<value + as-of>", "direction": "up|down", "scenario": "bear|base|bull"}],
  "claim_updates": [{"id": "C<n>", "action": "resolve|reprob", "value": <true|false|"void" for resolve; 0-100 for reprob>, "reason": "<one line>"}],
  "next_dates": ["<Mon D, YYYY label>", "..."]
}`

export interface PromptInput {
  state: ReviewState
  kind: CheckpointKind
  votes: DialVote[]
  tally: Tally
  tripwirePending: boolean
}

const w = (x: Weights) => SCENARIOS.map((s) => `${s} ${x[s]}`).join(" / ")

function voteLine(v: DialVote): string {
  const r = v.reading ? `${formatValue(v.reading.value)} @ ${v.reading.as_of}` : "no reading"
  return `- ${v.dial_id} [${v.category}] ${r}; band ${v.band}${v.z !== null ? `; z=${v.z}` : ""} → ${v.vote.toUpperCase()} (${v.reason})`
}

export function lastCheckpointDate(state: ReviewState): string | null {
  return state.checkpoints[0]?.date ?? null
}

export function buildReviewPrompt(input: PromptInput, cfg: ThesisConfig = THESIS): { system: string; prompt: string } {
  const { state, kind, votes, tally, tripwirePending } = input
  const cap = cfg.vote_rules.cap_points
  const system = [
    "You run the monthly review of Ryan LaRocca's written market-cycle thesis for Santa Clara County housing.",
    "You are disciplined and literal: you move weights only when the stored readings justify it under the rules below, and you always argue the other side.",
    "Reply with ONE JSON object and nothing else — no prose, no code fences.",
  ].join(" ")

  const scen = cfg.scenarios
    .map((s) => `- ${s.id} (${state.weights[s.id]}%): ${s.definition}. Typical markers: ${s.markers ?? "—"}`)
    .join("\n")
  const claims = openClaims(state.claims)
  const due = new Set(dueClaims(state.claims, state.today).map((c) => c.id))
  const claimLines = claims
    .map((c) => `- ${c.id}${due.has(c.id) ? " [DUE — resolve it]" : ""} (${c.category}, ${c.scenario_tag}) p=${c.prob_current} (initial ${c.prob_initial}), resolves ${c.resolves_on}: ${c.text}. Falsifier: ${c.falsifier}`)
    .join("\n")
  const voting = votes.filter((v) => v.vote !== "none")
  const inBand = votes.filter((v) => v.vote === "none" && v.reading && v.reason.startsWith("inside"))
  const watching = votes.filter((v) => v.vote === "none" && v.outside)
  const pending = pendingTripwires(state.tripwireEvents)
  const since = lastCheckpointDate(state)
  const notes = state.notes.filter((n) => !since || n.date > since)
  const ownedDials = state.dials.filter((d) => d.category === "owned_property" || /^mls_zip_/.test(d.id))
  const ownedLines = [
    ...state.ownedProperties.map((p) => `- ${p.flag}: ${p.address ?? "(address not set)"} ${p.zip}${p.listed_on ? `, listed ${p.listed_on}` : ""}`),
    ...ownedDials.flatMap((d) => {
      const rs = state.readings[d.id] ?? []
      const r = rs[rs.length - 1]
      return r ? [`- ${d.id} ${r.value ?? "—"} @ ${r.as_of}${r.raw ? ` — raw: ${String(r.raw).slice(0, 200)}` : ""}`] : []
    }),
    ...notes.filter((n) => /listed|property|showing|offer/i.test(n.kind ?? "")).map((n) => `- note ${n.date}: ${n.text.slice(0, 200)}`),
  ]
  const ryanNotes = state.checkpoints
    .filter((c) => c.ryan_note?.trim())
    .slice(0, 3)
    .map((c) => `- on the ${c.date} ${c.kind} checkpoint: ${c.ryan_note!.slice(0, 500)}`)
  const nextCal = state.calendar
    .filter((c) => !c.date || c.date > state.today)
    .sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"))
    .slice(0, 8)
    .map((c) => `- ${c.date ?? "TBD"}${c.tentative ? " (tentative)" : ""}: ${c.label}`)

  const prompt = `CHECKPOINT: ${kind} review on ${state.today}. Last checkpoint: ${since ?? "none (first review after weight move #0)"}.

SCENARIOS — a partition of one outcome (${cfg.scored_object.description}). Current weights: ${w(state.weights)}.
${scen}

RULES (code enforces these; an illegal proposal is rejected and the weights do not move):
1. Weights are whole numbers that sum to 100.
2. Weights may move only if (a) ≥3 dials from ≥2 categories voted the SAME direction as the move (the VOTES section is authoritative — do not re-litigate a dial's vote), or (b) a claim resolves at this checkpoint, or (c) a tripwire is pending. Otherwise propose the current weights unchanged.
3. Cap: the largest single-scenario change is ${cap.monthly} points, or ${cap.claim_resolved_or_tripwire} when a claim resolves or a tripwire is pending${tripwirePending ? " (a tripwire IS pending now)" : ""}.
4. A move cites ≥2 readings in dials_moved, each a dial that has a reading below.
5. The opposite case is written against the NEW weights with this month's data and must name the strongest reading that disagrees; put that dial in opposite_reading. If any dial voted against the move's direction, opposite_reading must be one of those dials.
6. Unexplained dials and listed properties are opposite-case material only — never a reason to move.
7. Claims: resolve every claim marked DUE (value true if the claim came true, false if its falsifier held, "void" only if the data cannot exist). You may re-probabilise any open claim (0-100) with a one-line reason. Claim text never changes here. Early resolution only when a tripwire is pending.
8. No move is a normal, good outcome. Do not move to look busy.

VOTES (tally: ${tallyLine(tally)})
${voting.length ? voting.map(voteLine).join("\n") : "- no dial passed the three tests this month"}

OUTSIDE ONCE (watching, not votes):
${watching.length ? watching.map(voteLine).join("\n") : "- none"}

IN BAND (candidates for the opposite case):
${inBand.length ? inBand.slice(0, 25).map(voteLine).join("\n") : "- none"}

PENDING TRIPWIRE EVENTS:
${pending.length ? pending.map((e) => `- ${e.tripwire_id} (${e.dial_id ?? "—"}) fired ${e.fired_on}: reading ${e.reading ?? "—"}; ${e.detail ?? ""}`).join("\n") : "- none"}

CLAIMS (open):
${claimLines || "- none"}

NOTES SINCE THE LAST CHECKPOINT:
${notes.length ? notes.map((n) => `- ${n.date}${n.dial_id ? ` [${n.dial_id}]` : ""}: ${n.text.slice(0, 300)}`).join("\n") : "- none"}

RYAN'S "DISAGREE" NOTES ON RECENT CHECKPOINTS (address them in the argument or opposite case):
${ryanNotes.length ? ryanNotes.join("\n") : "- none"}

LISTED PROPERTIES / OWNED ZIPS — ground truth, low weight, NEVER a vote (opposite case only):
${ownedLines.length ? ownedLines.join("\n") : "- none"}

DATA CALENDAR — next dates:
${nextCal.length ? nextCal.join("\n") : "- none loaded"}

Return exactly this JSON shape:
${PROPOSAL_SHAPE}`
  return { system, prompt }
}

export function buildRetryPrompt(original: string, previousJson: string, violations: string[]): string {
  return `${original}

YOUR PREVIOUS ANSWER broke these rules and was rejected:
${violations.map((v) => `- ${v}`).join("\n")}

Previous answer:
${previousJson}

Return a corrected JSON object (same shape). If no legal move exists, propose the current weights unchanged.`
}

// ---------------------------------------------------------------- parsing
const isScenario = (s: unknown): s is Scenario => s === "bear" || s === "base" || s === "bull"
const str = (x: unknown) => (typeof x === "string" ? x.trim() : "")

/** Parse + coerce the model's JSON. Throws on a shape it cannot use. */
export function parseProposal(json: string): Proposal {
  const o = JSON.parse(json) as Record<string, unknown>
  const pw = (o.proposed_weights ?? {}) as Record<string, unknown>
  const weights = { bear: Number(pw.bear), base: Number(pw.base), bull: Number(pw.bull) }
  if (SCENARIOS.some((s) => !Number.isFinite(weights[s]))) throw new Error("proposed_weights missing or not numeric")
  const opp = o.opposite_reading as Record<string, unknown> | null | undefined
  return {
    proposed_weights: weights,
    argument: str(o.argument),
    opposite_case: str(o.opposite_case),
    opposite_reading: opp && str(opp.dial_id) ? { dial_id: str(opp.dial_id), reading: str(opp.reading) } : null,
    reverses_if: str(o.reverses_if) || null,
    dials_moved: (Array.isArray(o.dials_moved) ? o.dials_moved : []).flatMap((d: Record<string, unknown>) =>
      str(d?.dial_id) && isScenario(d.scenario)
        ? [{ dial_id: str(d.dial_id), reading: str(d.reading), direction: d.direction === "down" ? ("down" as const) : ("up" as const), scenario: d.scenario }]
        : [],
    ),
    claim_updates: (Array.isArray(o.claim_updates) ? o.claim_updates : []).flatMap((u: Record<string, unknown>) => {
      const action = u?.action === "resolve" || u?.action === "reprob" ? u.action : null
      if (!action || !str(u.id)) return []
      const raw = u.value
      const value =
        action === "reprob" ? Number(raw) : raw === true || raw === "true" ? true : raw === false || raw === "false" ? false : raw === "void" ? ("void" as const) : NaN
      return [{ id: str(u.id), action, value: value as boolean | number | "void", reason: str(u.reason) }]
    }),
    next_dates: (Array.isArray(o.next_dates) ? o.next_dates : []).map(String).slice(0, 6),
  }
}
