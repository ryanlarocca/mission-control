import { extractJsonObject as extractJson } from "@/lib/llm"
import { autoClaimUpdates } from "./autoclaims"
import { BET_EMOJI, betClaims, betNow, betVotes, claimShort, tripwireApplies } from "./bets"
import { applyClaimUpdates } from "./claims"
import { cycleBaseUrl, longDate, renderCard, type Card, type CardBullet } from "./card"
import { BETS, claimAuto } from "./config"
import { checkProposal, noMoveProposal, type RulesVerdict } from "./rules"
import { buildRetryPrompt, buildReviewPrompt, parseProposal } from "./prompt"
import { checkpointDue, nextCheckpoint, pendingTripwires, type DueResult } from "./schedule"
import { computeVotes, formatValue, qualifyingBloc, tallyLine, tallyVotes } from "./votes"
import type { CheckpointWriter } from "./data"
import type { BetDef, BetResultRow, Checkpoint, CheckpointKind, Claim, ClaimUpdate, Dial, DialVote, Proposal, ReviewState, Tally, WeightMove, Weights } from "./types"

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
  /** Send the card labelled PREVIEW without writing anything (implies a dry run). */
  preview?: boolean
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
  /** Housing's move (legacy); every bet's move is in weightMoves. */
  weightMove: Omit<WeightMove, "id"> | null
  weightMoves: Omit<WeightMove, "id">[]
  claims: Claim[]
  tripwiresReviewed: (string | number)[]
}

/** One bet's review result. */
export interface BetOutcome {
  bet: BetDef
  before: Weights
  after: Weights
  votes: DialVote[]
  tally: Tally
  proposalSource: "model" | "model-retry" | "model-fallback" | "stub"
  proposal: Proposal
  verdict: RulesVerdict
  /** Claims resolved by code from the readings. */
  autoUpdates: ClaimUpdate[]
  /** Everything applied for this bet: code resolutions + the model's valid updates. */
  claimUpdates: ClaimUpdate[]
  tripwirePending: boolean
  modelRaw: string[]
}

export interface ReviewResult {
  skipped: boolean
  reason: string
  due: DueResult
  kind: CheckpointKind | null
  votes: DialVote[]
  tally: Tally | null
  /** Housing (legacy fields); every bet is in `bets`. */
  proposalSource: "model" | "model-retry" | "model-fallback" | "stub" | null
  proposal: Proposal | null
  verdict: RulesVerdict | null
  bets: BetOutcome[]
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
export function stubProposal(weights: Weights, dials: Dial[], votes: DialVote[], tally: Tally): Proposal {
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
  const gate = bear.qualifies || bull.qualifies ? `the ${bear.qualifies ? "bear" : "bull"} side has enough votes to move, but a preview never moves` : "neither side has the 3 dials from 2 areas a move needs"
  return {
    proposed_weights: { ...weights },
    argument: `Preview without the model: ${tally.totals.bear} dials lean bear and ${tally.totals.bull} lean bull; ${gate}.`,
    opposite_case: opp
      ? `${shortName(dials.find((d) => d.id === opp.dial_id), opp.dial_id)} ${opp.reading ? formatValue(opp.reading.value) : ""} ${opp.vote === "none" ? `is past its ${other} line once (not yet a vote)` : `leans ${opp.vote}`}.`
      : "No reading leans against the votes this month.",
    opposite_reading: opp && opp.reading ? { dial_id: opp.dial_id, reading: `${formatValue(opp.reading.value)} @ ${opp.reading.as_of}` } : null,
    reverses_if: null,
    dials_moved: [],
    claim_updates: [],
    next_dates: [],
  }
}

interface BetContext {
  state: ReviewState
  kind: CheckpointKind
  allVotes: DialVote[]
  useModel: boolean
  callModel?: (system: string, prompt: string) => Promise<string>
  log: (line: string) => void
}

/** Votes → code-settled claims → proposal (model or stub) → rules, for one bet. */
export async function reviewBet(bet: BetDef, ctx: BetContext): Promise<BetOutcome> {
  const { state, kind, log } = ctx
  const today = state.today
  const before = state.betWeights[bet.id] ?? bet.initial_weights
  const votes = betVotes(bet, ctx.allVotes)
  const tally = tallyVotes(votes)
  const claims = betClaims(bet, state.claims)
  const autoIds = new Set(claims.filter((c) => claimAuto(c.id)).map((c) => c.id))
  const autoUpdates = autoClaimUpdates(claims, claimAuto, state.dials, state.readings, today)
  const tripwirePending = pendingTripwires(state.tripwireEvents).some((e) => tripwireApplies(bet, e))
  log(`[${bet.id}] votes: ${tallyLine(tally)}${autoUpdates.length ? `; code settled ${autoUpdates.map((u) => `${u.id}=${u.value}`).join(", ")}` : ""}`)
  const rulesFor = (p: Proposal) =>
    checkProposal({ before, proposal: p, votes, claims, today, tripwirePending, autoResolved: autoUpdates.length > 0, autoIds })

  const modelRaw: string[] = []
  let proposal: Proposal
  let verdict: RulesVerdict
  let source: BetOutcome["proposalSource"]
  if (ctx.useModel) {
    if (!ctx.callModel) throw new Error("model call requested but no callModel dependency was provided")
    const { system, prompt } = buildReviewPrompt({ state, kind, bet, weights: before, claims, votes, tally, tripwirePending, autoUpdates, autoIds })
    const ask = async (p: string) => {
      const raw = await ctx.callModel!(system, p)
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
      verdict = rulesFor(noMoveProposal(before, {}, [], violations))
    }
    if (parsed && verdict.ok) {
      proposal = parsed
      source = "model"
    } else {
      log(`[${bet.id}] proposal rejected (${violations.join("; ")}) — re-asking once`)
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
        proposal = noMoveProposal(before, parsed ?? {}, valid, violations)
        const fb = rulesFor(proposal)
        verdict = { ...fb, violations } // keep the reasons for the log; weights stay put
        source = "model-fallback"
      }
    }
  } else {
    proposal = stubProposal(before, state.dials, votes, tally)
    verdict = rulesFor(proposal)
    source = "stub"
  }
  // Code's resolutions first; the model may still re-probabilise those claims (never resolve them).
  const claimUpdates = [...autoUpdates, ...verdict.validClaimUpdates.filter((u) => !(u.action === "resolve" && autoIds.has(u.id)))]
  return { bet, before, after: verdict.weights, votes, tally, proposalSource: source, proposal, verdict, autoUpdates, claimUpdates, tripwirePending, modelRaw }
}

export async function runReview(opts: ReviewOptions, deps: ReviewDeps): Promise<ReviewResult> {
  const log = opts.log ?? (() => {})
  const dryRun = opts.dryRun || !!opts.preview
  const loaded = await deps.loadState()
  const state: ReviewState = opts.today ? { ...loaded, today: opts.today } : loaded
  const today = state.today
  const due = checkpointDue(today, { calendar: state.calendar, readings: state.readings, checkpoints: state.checkpoints }, state.tripwireEvents)
  const empty: ReviewResult = {
    skipped: true, reason: due.reason, due, kind: null, votes: [], tally: null, proposalSource: null, proposal: null,
    verdict: null, bets: [], modelRaw: [], rows: null, card: null, checkpointId: null, telegramMessageId: null,
  }
  if (opts.check && !due.due) return empty

  const pending = pendingTripwires(state.tripwireEvents)
  const kind: CheckpointKind = opts.kind ?? due.kind ?? (pending.length ? "tripwire" : "monthly")
  const allVotes = computeVotes(state.dials, state.readings, today)
  const ctx: BetContext = { state, kind, allVotes, useModel: !opts.dryRun || !!opts.llm, callModel: deps.callModel, log }
  const outcomes: BetOutcome[] = []
  for (const bet of BETS) outcomes.push(await reviewBet(bet, ctx))
  const housing = outcomes.find((o) => o.bet.id === "housing") ?? outcomes[0]

  // ---- rows
  const allUpdates = outcomes.flatMap((o) => o.claimUpdates)
  const changedClaims = applyClaimUpdates(state.claims, allUpdates, today, state.checkpoints)
  // the checkpoint being written now counts as this month's (once per month)
  const doneNow = kind === "tripwire" ? [] : [{ date: today, kind }]
  const nextCp = nextCheckpoint(today, { calendar: state.calendar, checkpoints: [...state.checkpoints, ...doneNow] })
  const calNext = state.calendar
    .filter((c) => c.date && c.date > today)
    .sort((a, b) => (a.date as string).localeCompare(b.date as string))
    .slice(0, 2)
    .map((c) => `${longDate(c.date as string)} ${c.label}`)
  const nextDates = [...(nextCp ? [`~${longDate(nextCp.date)} ${nextCp.kind} review`] : []), ...calNext]
  const votesRow = (o: BetOutcome) => o.votes.filter((v) => v.vote !== "none")
  const betsRow: Record<string, BetResultRow> = Object.fromEntries(
    outcomes.map((o) => [
      o.bet.id,
      {
        weights_before: o.before,
        weights_after: o.after,
        moved: o.verdict.moved,
        argument: o.proposal.argument,
        opposite_case: o.proposal.opposite_case,
        reverses_if: o.proposal.reverses_if ?? null,
        proposal_source: o.proposalSource,
        votes: votesRow(o).map((v) => ({ dial_id: v.dial_id, vote: v.vote, reading: v.reading })),
        claims_resolved: o.claimUpdates,
      },
    ]),
  )
  const checkpoint: PlannedRows["checkpoint"] = {
    date: today,
    kind,
    weights_before: housing.before,
    weights_after: housing.after,
    votes: {
      tally: housing.tally.byCategory,
      totals: housing.tally.totals,
      dials: votesRow(housing).map((v) => ({ dial_id: v.dial_id, category: v.category, vote: v.vote, reading: v.reading, band: v.band, z: v.z, reason: v.reason })),
      proposal_source: housing.proposalSource,
      violations: housing.verdict.violations,
      adjustments: housing.verdict.adjustments,
      opposite_reading: housing.proposal.opposite_reading,
      tripwires: pending.map((e) => e.tripwire_id),
    },
    argument: housing.proposal.argument,
    opposite_case: housing.proposal.opposite_case,
    claims_resolved: allUpdates,
    next_dates: nextDates,
    telegram_message_id: null,
    ryan_note: null,
    bets: betsRow,
  }
  const weightMoves: PlannedRows["weightMoves"] = outcomes
    .filter((o) => o.verdict.moved)
    .map((o) => ({
      checkpoint_id: null,
      date: today,
      from_weights: o.before,
      to_weights: o.after,
      readings_cited: o.proposal.dials_moved,
      argument: o.proposal.argument,
      opposite_case: o.proposal.opposite_case,
      reverses_if: o.proposal.reverses_if ?? null,
      bootstrap_exception: false,
      bet_id: o.bet.id,
    }))
  const rows: PlannedRows = {
    checkpoint,
    weightMove: weightMoves.find((m) => m.bet_id === "housing") ?? null,
    weightMoves,
    claims: changedClaims,
    tripwiresReviewed: pending.flatMap((e) => (e.id !== undefined ? [e.id] : [])),
  }

  // ---- card (plain English)
  const claimById = new Map(state.claims.map((c) => [c.id, c]))
  const settled = allUpdates
    .filter((u) => u.action === "resolve")
    .map((u) => {
      const c = claimById.get(u.id)
      return `${c ? claimShort(c) : u.id} ${u.value === true ? "✅" : u.value === false ? "❌" : "(void)"}${c ? ` (we said ${c.prob_current}%)` : ""}`
    })
  const reprobs = allUpdates
    .filter((u) => u.action === "reprob")
    .map((u) => {
      const c = claimById.get(u.id)
      return `${c ? claimShort(c, 50) : u.id}: ${c?.prob_current ?? "?"}% → ${u.value}%`
    })

  let checkpointId = DRY_RUN_CHECKPOINT_ID
  let telegramMessageId: number | null = null
  if (!dryRun) {
    if (!deps.writer) throw new Error("write requested but no writer dependency was provided")
    checkpointId = await deps.writer.insertCheckpoint(checkpoint)
    for (const m of weightMoves) await deps.writer.insertWeightMove({ ...m, checkpoint_id: checkpointId })
    if (changedClaims.length) await deps.writer.updateClaims(changedClaims)
  }
  const card = renderCard({
    date: today,
    kind,
    bets: outcomes.map((o) => ({
      emoji: BET_EMOJI[o.bet.id] ?? "•",
      name: o.bet.id === "housing" ? "SCC houses" : o.bet.id === "spx" ? "S&P 500" : o.bet.name,
      before: o.before,
      after: o.after,
      now: betNow(o.bet, state),
      why: o.proposal.argument,
      against: o.proposal.opposite_case,
    })),
    settled,
    reprobs,
    next: nextDates,
    checkpointId,
    baseUrl: cycleBaseUrl(),
    preview: !!opts.preview,
  })
  if (!dryRun) {
    if (deps.sendCard) {
      telegramMessageId = await deps.sendCard(card)
      if (telegramMessageId !== null) await deps.writer!.setTelegramMessageId(checkpointId, telegramMessageId)
    }
    await deps.writer!.markTripwiresReviewed(rows.tripwiresReviewed, new Date().toISOString())
  } else if (opts.preview && deps.sendCard) {
    telegramMessageId = await deps.sendCard(card)
  }
  return {
    skipped: false, reason: due.due ? due.reason : `forced (${due.reason})`, due, kind, votes: allVotes, tally: housing.tally,
    proposalSource: housing.proposalSource, proposal: housing.proposal, verdict: housing.verdict, bets: outcomes,
    modelRaw: outcomes.flatMap((o) => o.modelRaw), rows, card, checkpointId: dryRun ? null : checkpointId, telegramMessageId,
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
