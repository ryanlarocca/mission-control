import { getLeadsClient } from "@/lib/leads"
import { THESIS, configCalendar, configClaims, configDials, initialWeights } from "@/lib/marketCycle/config"
import { brierByCategory } from "@/lib/marketCycle/claims"
import { categoryLabel, longDate } from "@/lib/marketCycle/card"
import { loadFromSupabase, todayPT } from "@/lib/marketCycle/data"
import { checkpointDue, nextCheckpoint, pendingTripwires } from "@/lib/marketCycle/schedule"
import { computeVotes, formatValue } from "@/lib/marketCycle/votes"
import type { Dial, DialVote, Reading, ReviewState, Scenario, VoteKind, WeightMove } from "@/lib/marketCycle/types"

// /cycle — the market-cycle details page the Telegram card's "Details"
// button opens (briefs/BRIEF_MARKET_CYCLE_TRACKER_2026-11-01.md §3.5).
// Phone-first: one column, stacked rows (no wide tables), dark zinc palette,
// no header row with controls. Auth = the global middleware cookie.

export const dynamic = "force-dynamic"
export const revalidate = 0

// Validated series hues on zinc-900 (memory: mission-control-dark-chart-palette).
const HUE: Record<Scenario, string> = { bear: "#d97706", base: "#7c3aed", bull: "#0284c7" }
const SPARK = "#a1a1aa" // zinc-400 — neutral line; the vote badge carries the colour

function configOnlyState(today: string): ReviewState {
  return {
    today,
    weights: initialWeights(),
    dials: configDials(),
    readings: {},
    claims: configClaims(),
    checkpoints: [],
    weightMoves: [],
    tripwireEvents: [],
    notes: [],
    calendar: configCalendar(),
    ownedProperties: [],
    missingTables: [],
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-zinc-500">{title}</h2>
      {children}
    </section>
  )
}

function VoteBadge({ vote }: { vote: VoteKind | null }) {
  if (!vote || vote === "none") return <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-zinc-500 ring-1 ring-zinc-700">no vote</span>
  if (vote === "unexplained") return <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-zinc-300 ring-1 ring-zinc-500">unexplained</span>
  return (
    <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold text-white" style={{ backgroundColor: HUE[vote] }}>
      {vote}
    </span>
  )
}

function Sparkline({ rows }: { rows: Reading[] }) {
  const pts = rows.filter((r) => r.value !== null).slice(-12)
  if (pts.length < 2) return <span className="inline-block w-24 shrink-0" />
  const vals = pts.map((p) => p.value as number)
  const lo = Math.min(...vals)
  const hi = Math.max(...vals)
  const W = 96
  const H = 24
  const xy = vals.map((v, i) => `${((i / (vals.length - 1)) * (W - 4) + 2).toFixed(1)},${(hi === lo ? H / 2 : H - 2 - ((v - lo) / (hi - lo)) * (H - 4)).toFixed(1)}`)
  const last = xy[xy.length - 1].split(",")
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0" role="img" aria-label={`last ${vals.length} readings`}>
      <polyline points={xy.join(" ")} fill="none" stroke={SPARK} strokeWidth={1.5} strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r={2} fill="#e4e4e7" />
    </svg>
  )
}

function DialRow({ dial, vote, rows }: { dial: Dial; vote: DialVote | undefined; rows: Reading[] }) {
  const r = vote?.reading
  return (
    <div className="flex items-center gap-2 border-t border-zinc-800 py-1.5 first:border-t-0">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-zinc-200">{dial.name}</p>
        <p className="truncate text-xs text-zinc-500">
          {r ? `${formatValue(r.value)}${dial.units ? ` ${dial.units}` : ""} · ${longDate(r.as_of)}` : "no reading yet"}
          {vote?.z !== null && vote?.z !== undefined ? ` · z ${vote.z}` : ""}
        </p>
      </div>
      <Sparkline rows={rows} />
      <VoteBadge vote={vote?.vote ?? null} />
    </div>
  )
}

function weightsText(w: Partial<Record<Scenario, number | null>>): string {
  return (["bear", "base", "bull"] as const).map((s) => `${s} ${w[s] ?? "—"}`).join(" · ")
}

export default async function CyclePage() {
  const today = todayPT()
  let state: ReviewState
  let loadError: string | null = null
  try {
    state = await loadFromSupabase(getLeadsClient(), today)
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e)
    state = configOnlyState(today)
  }
  const votes = computeVotes(state.dials, state.readings, today)
  const voteById = new Map(votes.map((v) => [v.dial_id, v]))
  const due = checkpointDue(today, state.calendar, state.tripwireEvents)
  const next = nextCheckpoint(today, state.calendar)
  const pending = pendingTripwires(state.tripwireEvents)
  const lastCp = state.checkpoints[0] ?? null
  const notesSince = state.notes.filter((n) => !lastCp || n.date > lastCp.date)

  // Weight-move log: DB rows, or move #0 from the config before the bootstrap writes it.
  const m0 = THESIS.weight_moves[0]
  const moves: WeightMove[] = state.weightMoves.length
    ? state.weightMoves
    : [{ checkpoint_id: null, date: m0.date, from_weights: m0.from, to_weights: m0.to, readings_cited: { bootstrap: m0.readings_cited }, argument: m0.reason, opposite_case: m0.opposite_case, reverses_if: m0.reverses_if, bootstrap_exception: true }]

  const isPanel = (d: Dial) => (d.geography ?? "").startsWith("panel:")
  const isOwned = (d: Dial) => d.category === "owned_property" || (d.geography ?? "").startsWith("zip:") || d.id.startsWith("mls_zip_")
  const coreDials = state.dials.filter((d) => !isPanel(d) && !isOwned(d) && (state.readings[d.id]?.length ?? 0) > 0)
  const byCategory = new Map<string, Dial[]>()
  for (const d of coreDials) byCategory.set(d.category, [...(byCategory.get(d.category) ?? []), d])
  const panelDials = state.dials.filter((d) => isPanel(d))
  const ownedDials = state.dials.filter((d) => isOwned(d) && !(d.geography ?? "").endsWith("95118") && !d.id.includes("95118"))
  const homeDials = state.dials.filter((d) => d.id.includes("95118"))
  const briers = brierByCategory(state.claims)

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 pb-10">
      <div>
        <h1 className="text-lg font-semibold text-zinc-100">Market cycle</h1>
        <p className="text-xs text-zinc-500">
          Thesis v{THESIS.version} · {longDate(today)} · {due.due ? `review due today (${due.kind})` : next ? `next review ${longDate(next.date)} (${next.kind})` : "no review scheduled"}
        </p>
      </div>

      {loadError && (
        <p className="rounded-lg border border-amber-700/50 bg-amber-950/30 p-3 text-xs text-amber-200">
          Live data not available ({loadError}). Showing the committed thesis only.
        </p>
      )}
      {state.missingTables.length > 0 && <p className="text-xs text-zinc-500">Not set up yet: {state.missingTables.join(", ")}.</p>}

      <Section title="Weights">
        <p className="mb-2 text-xs text-zinc-400">{THESIS.scored_object.description}</p>
        <div className="flex flex-col gap-2">
          {THESIS.scenarios.map((s) => (
            <div key={s.id}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-sm text-zinc-200">{s.name}</span>
                <span className="shrink-0 text-sm font-semibold text-zinc-100">{state.weights[s.id]}%</span>
              </div>
              <div className="mt-1 h-2 w-full rounded bg-zinc-800">
                <div className="h-2 rounded" style={{ width: `${state.weights[s.id]}%`, backgroundColor: HUE[s.id] }} />
              </div>
              <p className="mt-1 text-xs text-zinc-500">{s.definition}</p>
            </div>
          ))}
        </div>
      </Section>

      {pending.length > 0 && (
        <Section title="Tripwires pending review">
          {pending.map((e, i) => (
            <div key={`${e.tripwire_id}-${i}`} className="border-t border-zinc-800 py-1.5 text-sm first:border-t-0">
              <p className="text-zinc-200">
                {e.tripwire_id} · {longDate(e.fired_on)}
              </p>
              <p className="text-xs text-zinc-500">
                {e.dial_id ?? "—"} · reading {e.reading ?? "—"}
                {e.detail ? ` · ${e.detail}` : ""}
              </p>
            </div>
          ))}
        </Section>
      )}

      {lastCp && (
        <Section title={`Last checkpoint — ${longDate(lastCp.date)} (${lastCp.kind})`}>
          <p className="text-sm text-zinc-300">{lastCp.argument ?? "—"}</p>
          <p className="mt-1 text-xs text-zinc-400">Opposite case: {lastCp.opposite_case ?? "—"}</p>
          {lastCp.ryan_note && <p className="mt-2 whitespace-pre-line text-xs text-amber-200">Your note: {lastCp.ryan_note}</p>}
        </Section>
      )}

      <Section title="Weight-move log">
        {moves.map((m, i) => (
          <div key={`${m.date}-${i}`} className="border-t border-zinc-800 py-2 first:border-t-0">
            <p className="text-sm text-zinc-200">
              {longDate(m.date)}
              {m.bootstrap_exception ? " · move #0 (bootstrap)" : ""}
            </p>
            <p className="text-xs text-zinc-400">
              {weightsText(m.from_weights)} → {weightsText(m.to_weights)}
            </p>
            <p className="mt-1 text-xs text-zinc-300">{m.argument}</p>
            <p className="mt-1 text-xs text-zinc-400">Opposite case: {m.opposite_case}</p>
            {m.reverses_if && <p className="mt-1 text-xs text-zinc-500">Reverses if: {m.reverses_if}</p>}
            <p className="mt-1 break-words text-[11px] text-zinc-500">
              Readings cited:{" "}
              {Array.isArray(m.readings_cited)
                ? (m.readings_cited as { dial_id?: string; reading?: string }[]).map((r) => `${r.dial_id} ${r.reading ?? ""}`).join(" · ")
                : typeof m.readings_cited === "object" && m.readings_cited
                  ? Object.values(m.readings_cited as Record<string, unknown>).map(String).join(" · ")
                  : "—"}
            </p>
          </div>
        ))}
      </Section>

      <Section title="Dials">
        {coreDials.length === 0 && <p className="text-xs text-zinc-500">No readings stored yet.</p>}
        {Array.from(byCategory.entries()).map(([cat, ds]) => (
          <div key={cat} className="mb-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{categoryLabel(cat)}</p>
            {ds.map((d) => (
              <DialRow key={d.id} dial={d} vote={voteById.get(d.id)} rows={state.readings[d.id] ?? []} />
            ))}
          </div>
        ))}
      </Section>

      <Section title="Home — 95118">
        {homeDials.some((d) => state.readings[d.id]?.length) ? (
          homeDials.map((d) => <DialRow key={d.id} dial={d} vote={voteById.get(d.id)} rows={state.readings[d.id] ?? []} />)
        ) : (
          <p className="text-xs text-zinc-500">No 95118 readings yet.</p>
        )}
      </Section>

      <Section title="Panels and owned zips (never a vote)">
        {panelDials.filter((d) => state.readings[d.id]?.length).map((d) => (
          <DialRow key={d.id} dial={d} vote={voteById.get(d.id)} rows={state.readings[d.id] ?? []} />
        ))}
        {ownedDials.filter((d) => state.readings[d.id]?.length).map((d) => (
          <DialRow key={d.id} dial={d} vote={voteById.get(d.id)} rows={state.readings[d.id] ?? []} />
        ))}
        {state.ownedProperties.map((p, i) => (
          <p key={i} className="border-t border-zinc-800 py-1.5 text-xs text-zinc-400 first:border-t-0">
            {p.flag.replace("_", " ")} · {p.address ?? "home"} · {p.zip}
            {p.listed_on ? ` · listed ${longDate(p.listed_on)}` : ""}
          </p>
        ))}
        {!panelDials.some((d) => state.readings[d.id]?.length) && state.ownedProperties.length === 0 && (
          <p className="text-xs text-zinc-500">The weekly collector has not written panel or owned-zip readings yet.</p>
        )}
      </Section>

      <Section title="Claims">
        {Object.keys(briers).length > 0 && (
          <p className="mb-2 text-xs text-zinc-400">
            Mean Brier (live / initial):{" "}
            {Object.entries(briers)
              .map(([c, b]) => `${c} ${b.live.toFixed(3)} / ${b.initial.toFixed(3)} (n=${b.n})`)
              .join(" · ")}
          </p>
        )}
        {state.claims.map((c) => (
          <div key={c.id} className="border-t border-zinc-800 py-2 first:border-t-0">
            <div className="flex items-baseline gap-2">
              <span className="shrink-0 text-xs font-semibold text-zinc-300">{c.id}</span>
              <span className="min-w-0 flex-1 text-xs text-zinc-200">{c.text}</span>
            </div>
            <p className="mt-0.5 text-[11px] text-zinc-500">
              {c.prob_initial}% → {c.prob_current}% · resolves {longDate(c.resolves_on)} · {c.status}
              {c.status === "resolved" ? ` (${c.resolution ? "true" : "false"})` : ""}
              {c.brier_live != null ? ` · Brier ${c.brier_live} live / ${c.brier_initial} initial` : ""}
            </p>
          </div>
        ))}
      </Section>

      <Section title={lastCp ? `Notes since ${longDate(lastCp.date)}` : "Notes"}>
        {notesSince.length === 0 ? (
          <p className="text-xs text-zinc-500">None.</p>
        ) : (
          notesSince.map((n, i) => (
            <p key={i} className="border-t border-zinc-800 py-1.5 text-xs text-zinc-300 first:border-t-0">
              <span className="text-zinc-500">{longDate(n.date)}{n.dial_id ? ` · ${n.dial_id}` : ""} — </span>
              {n.text}
            </p>
          ))
        )}
      </Section>
    </div>
  )
}
