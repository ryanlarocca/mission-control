import { extractJsonObject as extractJson } from "@/lib/llm"
import { applyClaimUpdates, dueClaims } from "./claims"
import { cycleBaseUrl, longDate, renderCard, type Card, type CardBullet } from "./card"
import { checkProposal, noMoveProposal, type RulesVerdict } from "./rules"
import { buildRetryPrompt, buildReviewPrompt, parseProposal } from "./prompt"
import { checkpointDue, nextCheckpoint, pendingTripwires, type DueResult } from "./schedule"
import { computeVotes, formatValue, qualifyingBloc, tallyLine, tallyVotes } from "./votes"
import type { CheckpointWriter } from "./data"
import type { Checkpoint, CheckpointKind, Claim, Dial, DialVote, Proposal, ReviewState, Tally, WeightMove } from "./types"

// Orchestrates one review: load → votes → prompt → model → rules → rows →
// card → send → mark tripwires reviewed. Everything with a side effect is
// injected, so dry runs and tests use the same path as the real job.
//   dryRun: no writes, no sends; no model call unless `llm` is set (a stub
//   "no move" proposal stands in, labelled as such on the card).

export interface ReviewOptions {
  dryRun: boolean
  kind?: CheckpointKind
  today?: string
  check?: boolean
  llm?: boolean
  log?: (line: string) => void
}

export interface ReviewDeps {
  loadState: () => Promise<ReviewState>
  /** Returns the model's raw text for (system, prompt). Required when the model is used. */
  callModel?: (system: string, prompt: string) => Promise<string>
  writer?: CheckpointWriter
  /** Posts the card; returns the Telegram message id. */
  sendCard?: (card: Card) => Promise<number | null>
}

export interface PlannedRows {
  checkpoint: Omit<Checkpoint, "id" | "created_at">
  weightMove: Omit<WeightMove, "id"> | null
  claims: Claim[]
  tripwiresReviewed: (string | number)[]
}

export interface ReviewResult {
  skipped: boolean
  reason: string
  due: DueResult
  kind: CheckpointKind | null
  votes: DialVote[]
  tally: Tally | null
  proposalSource: "model" | "model-retry" | "model-fallback" | "stub" | null
  proposal: Proposal | null
  verdict: RulesVerdict | null
  modelRaw: string[]
  rows: PlannedRows | null
  card: Card | null
  checkpointId: string | null
  telegramMessageId: number | null
}

export const DRY_RUN_CHECKPOINT_ID = "00000000-0000-0000-0000-000000000000"

function shortName(d: Dial | undefined, id: string): string {
  const n = d?.name ?? id
  const s = n.split(/[,(:]/)[0].trim()
  return s.length > 40 ? s.slice(0, 39) + "…" : s
}

const monthYear = (iso: string) => longDate(iso).replace(/ \d+,/, "")

export function voteBullet(v: DialVote, dial: Dial | undefined): CardBullet {
  const r = v.reading ? `${formatValue(v.reading.value)} (${dial?.cadence === "monthly" || dial?.cadence === "quarterly" ? monthYear(v.reading.as_of) : longDate(v.reading.as_of)})` : ""
  const z = v.z !== null ? `, ${Math.abs(v.z).toFixed(1)}σ ${v.outside === "up" ? "over" : "under"} its band` : ""
  return { label: `${shortName(dial, v.dial_id)} ${r}${z}`, category: v.category, scenario: v.vote === "unexplained" ? "unexplained" : (v.vote as CardBullet["scenario"]) }
}

/** The dry-run stand-in for the model: no move, an honest argument from the
 *  tally, and the strongest disagreeing reading as the opposite case. */
export function stubProposal(state: ReviewState, votes: DialVote[], tally: Tally): Proposal {
  const bear = qualifyingBloc(votes, "bear")
  const bull = qualifyingBloc(votes, "bull")
  const lead = tally.totals.bear >= tally.totals.bull ? "bear" : "bull"
  const other = lead === "bear" ? "bull" : "bear"
  // Strongest disagreeing reading: an opposite vote, else a reading already
  // beyond its opposite edge once (not yet a vote), else an unexplained move.
  const opp =
    votes.find((v) => v.vote === other) ??
    votes.find((v) => v.vote === "none" && v.leaning === other && v.reading) ??
    votes.find((v) => v.vote === "unexplained") ??
    null
  const gate = bear.qualifies || bull.qualifies ? `${bear.qualifies ? "bear" : "bull"} bloc clears the gate, but the stub never moves` : "no direction has ≥3 dials from ≥2 categories"
  return {
    proposed_weights: { ...state.weights },
    argument: `Stub, no model call: bear ${tally.totals.bear} / bull ${tally.totals.bull} votes; ${gate}.`,
    opposite_case: opp
      ? `${shortName(state.dials.find((d) => d.id === opp.dial_id), opp.dial_id)} ${opp.reading ? formatValue(opp.reading.value) : ""} ${opp.vote === "none" ? `is past its ${other} edge once (not yet a vote)` : `votes ${opp.vote}`}.`
      : "No reading leans against the votes this month.",
    opposite_reading: opp && opp.reading ? { dial_id: opp.dial_id, reading: `${formatValue(opp.reading.value)} @ ${opp.reading.as_of}` } : null,
    reverses_if: null,
    dials_moved: [],
    claim_updates: [],
    next_dates: [],
  }
}

export async function runReview(opts: ReviewOptions, deps: ReviewDeps): Promise<ReviewResult> {
  const log = opts.log ?? (() => {})
  const loaded = await deps.loadState()
  const state: ReviewState = opts.today ? { ...loaded, today: opts.today } : loaded
  const today = state.today
  const due = checkpointDue(today, state.calendar, state.tripwireEvents)
  const empty: ReviewResult = {
    skipped: true, reason: due.reason, due, kind: null, votes: [], tally: null, proposalSource: null, proposal: null,
    verdict: null, modelRaw: [], rows: null, card: null, checkpointId: null, telegramMessageId: null,
  }
  if (opts.check && !due.due) return empty

  const pending = pendingTripwires(state.tripwireEvents)
  const tripwirePending = pending.length > 0
  const kind: CheckpointKind = opts.kind ?? due.kind ?? (tripwirePending ? "tripwire" : "monthly")
  const votes = computeVotes(state.dials, state.readings, today)
  const tally = tallyVotes(votes)
  log(`votes: ${tallyLine(tally)}`)

  // ---- proposal
  const useModel = !opts.dryRun || !!opts.llm
  const modelRaw: string[] = []
  let proposal: Proposal
  let verdict: RulesVerdict
  let source: ReviewResult["proposalSource"]
  const rulesFor = (p: Proposal) => checkProposal({ before: state.weights, proposal: p, votes, claims: state.claims, today, tripwirePending })
  if (useModel) {
    if (!deps.callModel) throw new Error("model call requested but no callModel dependency was provided")
    const { system, prompt } = buildReviewPrompt({ state, kind, votes, tally, tripwirePending })
    const ask = async (p: string) => {
      const raw = await deps.callModel!(system, p)
      modelRaw.push(raw)
      return raw
    }
    let raw = await ask(prompt)
    let parsed: Proposal | null = null
    let violations: string[] = []
    try {
      parsed = parseProposal(extractJson(raw))
      verdict = rulesFor(parsed)
      violations = verdict.violations
    } catch (e) {
      violations = [`unparseable JSON: ${e instanceof Error ? e.message : String(e)}`]
      verdict = rulesFor(noMoveProposal(state.weights, {}, [], violations))
    }
    if (parsed && verdict.ok) {
      proposal = parsed
      source = "model"
    } else {
      log(`proposal rejected (${violations.join("; ")}) — re-asking once`)
      raw = await ask(buildRetryPrompt(prompt, raw, violations))
      try {
        parsed = parseProposal(extractJson(raw))
        verdict = rulesFor(parsed)
        violations = verdict.violations
      } catch (e) {
        parsed = null
        violations = [`unparseable JSON: ${e instanceof Error ? e.message : String(e)}`]
      }
      if (parsed && verdict.ok) {
        proposal = parsed
        source = "model-retry"
      } else {
        const valid = parsed ? verdict.validClaimUpdates : []
        proposal = noMoveProposal(state.weights, parsed ?? {}, valid, violations)
        const fb = rulesFor(proposal)
        verdict = { ...fb, violations } // keep the reasons for the log; weights stay put
        source = "model-fallback"
      }
    }
  } else {
    proposal = stubProposal(state, votes, tally)
    verdict = rulesFor(proposal)
    source = "stub"
  }

  // ---- rows
  const after = verdict.weights
  const claimUpdates = verdict.validClaimUpdates
  const changedClaims = applyClaimUpdates(state.claims, claimUpdates, today, state.checkpoints)
  const nextCp = nextCheckpoint(today, state.calendar)
  const calNext = state.calendar
    .filter((c) => c.date && c.date > today)
    .sort((a, b) => (a.date as string).localeCompare(b.date as string))
    .slice(0, 2)
    .map((c) => `${longDate(c.date as string)} ${c.label}`)
  const nextDates = proposal.next_dates.length ? proposal.next_dates : [...calNext, ...(nextCp ? [`${longDate(nextCp.date)} ${nextCp.kind} review`] : [])]
  const voting = votes.filter((v) => v.vote !== "none")
  const checkpoint: PlannedRows["checkpoint"] = {
    date: today,
    kind,
    weights_before: state.weights,
    weights_after: after,
    votes: {
      tally: tally.byCategory,
      totals: tally.totals,
      dials: voting.map((v) => ({ dial_id: v.dial_id, category: v.category, vote: v.vote, reading: v.reading, band: v.band, z: v.z, reason: v.reason })),
      proposal_source: source,
      violations: verdict.violations,
      adjustments: verdict.adjustments,
      opposite_reading: proposal.opposite_reading,
      tripwires: pending.map((e) => e.tripwire_id),
    },
    argument: proposal.argument,
    opposite_case: proposal.opposite_case,
    claims_resolved: claimUpdates,
    next_dates: nextDates,
    telegram_message_id: null,
    ryan_note: null,
  }
  const weightMove: PlannedRows["weightMove"] = verdict.moved
    ? {
        checkpoint_id: null,
        date: today,
        from_weights: state.weights,
        to_weights: after,
        readings_cited: proposal.dials_moved,
        argument: proposal.argument,
        opposite_case: proposal.opposite_case,
        reverses_if: proposal.reverses_if ?? null,
        bootstrap_exception: false,
      }
    : null
  const rows: PlannedRows = { checkpoint, weightMove, claims: changedClaims, tripwiresReviewed: pending.flatMap((e) => (e.id !== undefined ? [e.id] : [])) }

  // ---- card
  const dialById = new Map(state.dials.map((d) => [d.id, d]))
  const priorProb = new Map(state.claims.map((c) => [c.id, c.prob_current]))
  const bullets: CardBullet[] = verdict.moved
    ? proposal.dials_moved.map((m) => ({ label: `${shortName(dialById.get(m.dial_id), m.dial_id)} ${m.reading}`, category: dialById.get(m.dial_id)?.category ?? "—", scenario: m.scenario }))
    : voting.map((v) => voteBullet(v, dialById.get(v.dial_id)))
  const resolved = claimUpdates
    .filter((u) => u.action === "resolve")
    .map((u) => `${u.id} ${u.value === true ? "✅" : u.value === false ? "❌" : "void"} (we said ${priorProb.get(u.id)})`)
  const stillDue = dueClaims(state.claims, today).filter((c) => !claimUpdates.some((u) => u.id === c.id && u.action === "resolve"))
  if (stillDue.length) resolved.push(`due, unresolved: ${stillDue.map((c) => c.id).join(", ")}`)
  const reprobs = claimUpdates.filter((u) => u.action === "reprob").map((u) => `${u.id} ${priorProb.get(u.id)}→${u.value}`)

  let checkpointId = DRY_RUN_CHECKPOINT_ID
  let telegramMessageId: number | null = null
  if (!opts.dryRun) {
    if (!deps.writer) throw new Error("write requested but no writer dependency was provided")
    checkpointId = await deps.writer.insertCheckpoint(checkpoint)
    if (weightMove) await deps.writer.insertWeightMove({ ...weightMove, checkpoint_id: checkpointId })
    if (changedClaims.length) await deps.writer.updateClaims(changedClaims)
  }
  const card = renderCard({
    date: today,
    kind,
    before: state.weights,
    after,
    bullets,
    moved: verdict.moved,
    why: proposal.argument,
    opposite: proposal.opposite_case,
    resolved,
    reprobs,
    next: nextDates,
    checkpointId,
    baseUrl: cycleBaseUrl(),
  })
  if (!opts.dryRun) {
    if (deps.sendCard) {
      telegramMessageId = await deps.sendCard(card)
      if (telegramMessageId !== null) await deps.writer!.setTelegramMessageId(checkpointId, telegramMessageId)
    }
    await deps.writer!.markTripwiresReviewed(rows.tripwiresReviewed, new Date().toISOString())
  }
  return {
    skipped: false, reason: due.due ? due.reason : `forced (${due.reason})`, due, kind, votes, tally, proposalSource: source, proposal, verdict,
    modelRaw, rows, card, checkpointId: opts.dryRun ? null : checkpointId, telegramMessageId,
  }
}

/** Sends the card from the Marketing bot (same channel as the lead-status digest). */
export async function sendCardToTelegram(card: Card): Promise<number | null> {
  const { leadAlertBotToken } = await import("@/lib/leads")
  const token = leadAlertBotToken()
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) throw new Error("Telegram bot token / chat id missing")
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: card.text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: { inline_keyboard: card.buttons } }),
  })
  const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: { message_id?: number }; description?: string } | null
  if (!res.ok || !body?.ok) throw new Error(`Telegram ${res.status}: ${body?.description ?? "send failed"}`)
  return body.result?.message_id ?? null
}
