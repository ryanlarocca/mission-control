import DisagreeButton from "@/components/cycle/DisagreeButton"
import { getLeadsClient } from "@/lib/leads"
import { BETS, configCalendar, configClaims, configDials, initialWeights } from "@/lib/marketCycle/config"
import { longDate } from "@/lib/marketCycle/card"
import { BET_EMOJI, betNow } from "@/lib/marketCycle/bets"
import { betWeightsFrom, loadFromSupabase, todayPT } from "@/lib/marketCycle/data"
import { DISPLAY, GROUP_ORDER, NEARBY, PRICE_BANDS, type DialDisplay } from "@/lib/marketCycle/display"
import { checkpointDue, mondayOnOrAfter, nextCheckpoint } from "@/lib/marketCycle/schedule"
import { computeVotes, corridorSeries } from "@/lib/marketCycle/votes"
import { dateLabel, formatValue, last12Months, previousReading, timelineX, trend, vsNormal, vsPeak, yearOverYear, type MonthSlot, type Tone } from "@/lib/marketCycle/view"
import type { BetDef, Checkpoint, Reading, ReviewState, Scenario, Weights } from "@/lib/marketCycle/types"

// /cycle — the market-cycle page (brief v2 Phase 3; Ryan's walkthrough Nov 7,
// 2026; target mockup PROJECTS/market-cycle-tracker/mockups/full-page-v2.png).
// Six cards, phone first: SCC houses · US stocks (each: when's the low, when's
// the rebound, how deep) · Dials (key numbers, price bands, scroll box) · My
// zip codes · Nearby markets · Reviews & odds moves.

export const dynamic = "force-dynamic"
export const revalidate = 0

const HUE: Record<Scenario, string> = { bear: "#f59e0b", base: "#8b5cf6", bull: "#3b82f6" }
const TONE: Record<Tone, string> = { good: "#4ade80", bad: "#f87171", flat: "#9aa6c0" }
const SC: Scenario[] = ["bear", "base", "bull"]
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const monthWord = (ym: string) => `${MON[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`
const valued = (rows: Reading[] | undefined) => (rows ?? []).filter((r): r is Reading & { value: number } => r.value !== null)
const latest = (rows: Reading[] | undefined) => valued(rows).pop() ?? null

function configOnlyState(today: string): ReviewState {
  return {
    today,
    weights: initialWeights(),
    betWeights: betWeightsFrom([]),
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

/** All-time high per dial (zip / area "vs peak" needs history the page window doesn't hold). */
/** SCC single-family inventory (realtor association, monthly since 2023), from the
 *  months-of-supply readings' raw numerator — the single-family yardstick for
 *  "homes for sale" (Ryan: single-family only). Full history for "vs normal". */
async function sfrInventory(): Promise<Reading[]> {
  const { data } = await getLeadsClient().from("cycle_readings").select("as_of, raw").eq("dial_id", "scc_months_supply").eq("variant", "").order("as_of")
  return ((data ?? []) as { as_of: string; raw: unknown }[]).flatMap((r) => {
    let raw = r.raw as Record<string, unknown> | string | null
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw) as Record<string, unknown>
      } catch {
        raw = null
      }
    }
    const v = raw && typeof raw === "object" ? Number(raw.sccaor_sfr_inventory) : NaN
    return Number.isFinite(v) ? [{ dial_id: "scc_sfr_inventory", as_of: r.as_of, value: v, source_url: "sccaor", raw: null }] : []
  })
}

async function peaks(ids: string[]): Promise<Record<string, { as_of: string; value: number }>> {
  const sb = getLeadsClient()
  const got = await Promise.all(
    ids.map(async (id) => {
      const { data } = await sb.from("cycle_readings").select("as_of, value").eq("dial_id", id).eq("variant", "").order("value", { ascending: false }).limit(1)
      const r = (data ?? [])[0] as { as_of: string; value: number } | undefined
      return [id, r ? { as_of: r.as_of, value: Number(r.value) } : null] as const
    }),
  )
  const out: Record<string, { as_of: string; value: number }> = {}
  for (const [id, v] of got) if (v) out[id] = v
  return out
}

/** The first Monday run a full week after the first weekly snapshot: when week-over-week numbers start. */
function fromDateLabel(firstWeek: string | undefined): string | null {
  if (!firstWeek) return null
  return longDate(mondayOnOrAfter(new Date(Date.parse(firstWeek + "T00:00:00Z") + 6 * 86_400_000).toISOString().slice(0, 10))).replace(/, \d{4}$/, "")
}

// ---------------------------------------------------------------- small pieces
function Card({ title, pill, accent, children }: { title: string; pill?: string; accent?: boolean; children: React.ReactNode }) {
  return (
    <section className={`rounded-xl border p-3 ${accent ? "border-sky-900 bg-zinc-900" : "border-zinc-800 bg-zinc-900"}`}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h2 className={`text-xs font-semibold uppercase tracking-widest ${accent ? "text-sky-300" : "text-zinc-500"}`}>{title}</h2>
        {pill && <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${accent ? "bg-sky-950 text-sky-300" : "bg-zinc-800 text-zinc-400"}`}>{pill}</span>}
      </div>
      {children}
    </section>
  )
}

function Spark({ slots }: { slots: MonthSlot[] }) {
  const W = 128
  const H = 34
  const pts = slots.map((s, i) => ({ i, v: s.value })).filter((p): p is { i: number; v: number } => p.v !== null)
  if (pts.length < 2) return <div className="w-32 shrink-0 rounded-md border border-dashed border-zinc-700 px-1 py-2 text-center text-[10px] text-zinc-600">chart after 4 weeks</div>
  const lo = Math.min(...pts.map((p) => p.v))
  const hi = Math.max(...pts.map((p) => p.v))
  const X = (i: number) => 4 + (i * (W - 8)) / 11
  const Y = (v: number) => (hi === lo ? H / 2 : 3 + (1 - (v - lo) / (hi - lo)) * (H - 8))
  const last = pts[pts.length - 1]
  return (
    <svg width={W} height={H + 12} viewBox={`0 0 ${W} ${H + 12}`} className="shrink-0" role="img" aria-label="last 12 months">
      <polyline points={pts.map((p) => `${X(p.i).toFixed(1)},${Y(p.v).toFixed(1)}`).join(" ")} fill="none" stroke="#818cf8" strokeWidth={1.6} strokeLinejoin="round" />
      <circle cx={X(last.i)} cy={Y(last.v)} r={2.4} fill="#e6edf7" />
      {slots.map((s, i) => (
        <text key={s.ym} x={X(i)} y={H + 10} textAnchor="middle" fontSize={8} fill="#7d8aa6">
          {s.letter}
        </text>
      ))}
    </svg>
  )
}

interface RowData {
  id: string
  label: string
  value: string
  tone: Tone
  arrow: string
  sub: string
  slots: MonthSlot[]
  chip: Scenario | null
}

function DialRow({ label, value, tone, arrow, sub, slots, chip }: RowData) {
  return (
    <div className="flex items-center gap-2 border-t border-zinc-800 py-2 first:border-t-0">
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-tight text-zinc-100">
          {label}
          {chip && (
            <span className="ml-1.5 rounded px-1.5 py-0.5 align-[1px] text-[9.5px] font-semibold text-white" style={{ backgroundColor: chip === "bull" ? "#2563eb" : chip === "bear" ? "#c2410c" : "#6d28d9" }}>
              {chip} vote
            </span>
          )}
        </p>
        <p className="text-[15px] font-semibold" style={{ color: TONE[tone] }}>
          {value} {arrow}
        </p>
        <p className="text-[11px] leading-snug text-zinc-500">{sub}</p>
      </div>
      <Spark slots={slots} />
    </div>
  )
}

function Timeline({ bet, weights }: { bet: BetDef; weights: Weights }) {
  const W = 330
  const L = 58
  const R = W - 6
  const ROW = 20
  const X = (ym: string, edge: "start" | "end") => L + timelineX(ym, edge) * (R - L)
  const ticks = ["2027-01", "2027-07", "2028-01", "2028-07"]
  return (
    <svg viewBox={`0 0 ${W} ${ROW * 3 + 22}`} className="mt-2 w-full max-w-[420px]" role="img" aria-label="when the low lands and when the rebound starts">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={X(t, "start")} y1={0} x2={X(t, "start")} y2={ROW * 3} stroke="#1d2840" />
          <text x={X(t, "start")} y={ROW * 3 + 14} fontSize={8.5} fill="#7d8aa6" textAnchor="middle">
            {monthWord(t)}
          </text>
        </g>
      ))}
      {SC.map((s, i) => {
        const t = bet.timing[s]
        const y = i * ROW + ROW / 2
        return (
          <g key={s}>
            <text x={0} y={y + 3.5} fontSize={10.5} fontWeight={600} fill="#e6edf7">
              {cap(s)} {weights[s]}%
            </text>
            <rect x={X(t.low[0], "start")} y={y - 4} width={X(t.low[1], "end") - X(t.low[0], "start")} height={8} rx={4} fill={HUE[s]} />
            {t.rebound ? (
              <rect x={X(t.rebound[0], "start")} y={y - 4} width={Math.min(X(t.rebound[1], "end"), R) - X(t.rebound[0], "start")} height={8} rx={4} fill="none" stroke={HUE[s]} strokeWidth={1.4} />
            ) : (
              <text x={(X(t.low[0], "start") + X(t.low[1], "end")) / 2} y={y + 3} fontSize={8} fontWeight={700} fill="#101829" textAnchor="middle">
                rebound after 2028 →
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

function BetCard({ bet, weights, now, accent, nextReview }: { bet: BetDef; weights: Weights; now: string | null; accent: boolean; nextReview: string }) {
  return (
    <Card title={bet.name} pill={bet.pill} accent={accent}>
      <p className="text-sm leading-snug text-zinc-100">{bet.question}</p>
      <p className="mt-1 text-xs text-zinc-400">Now: {now ? <b className="text-zinc-100">{now}</b> : "no reading yet"}</p>
      <p className="mt-3 text-[11px] font-bold uppercase tracking-wider text-zinc-400">When does the low land, and when does it turn back up?</p>
      <Timeline bet={bet} weights={weights} />
      <div className="mt-0.5 flex gap-4 text-[10px] text-zinc-500">
        <span>
          <i className="mr-1 inline-block h-[7px] w-3.5 rounded bg-zinc-400 align-middle" />
          low lands here
        </span>
        <span>
          <i className="mr-1 inline-block h-[7px] w-3.5 rounded border border-zinc-400 align-middle" />
          rebound starts here
        </span>
      </div>
      <p className="mt-3 text-[11px] font-bold uppercase tracking-wider text-zinc-400">How deep</p>
      {SC.map((s) => (
        <div key={s} className="mt-1.5">
          <div className="flex items-baseline justify-between">
            <span className="text-[15px] font-semibold text-zinc-100">{cap(s)}</span>
            <span className="text-base font-bold text-zinc-100">{weights[s]}%</span>
          </div>
          <div className="my-1 h-[7px] overflow-hidden rounded bg-zinc-800">
            <div className="h-full rounded" style={{ width: `${weights[s]}%`, backgroundColor: HUE[s] }} />
          </div>
          <p className="text-[12.5px] text-zinc-300">
            {bet.depth_lines[s]} · {bet.timing[s].analog}
          </p>
        </div>
      ))}
      <p className="mt-2 border-t border-zinc-800 pt-1.5 text-[10.5px] text-zinc-600">
        Rebound = {bet.rebound_definition} · odds move only at reviews, reason logged · next review {nextReview}
        {bet.id === "spx" ? " · watch only, never a buy or sell signal" : ""}
      </p>
    </Card>
  )
}

function AreaRow({ title, small, tag, value, yoy, peak, slots, when, big }: { title: string; small: string | null; tag: string | null; value: number; yoy: number | null; peak: { pct: number; month: string } | null; slots: MonthSlot[]; when: string; big?: boolean }) {
  const tone = (v: number | null) => (v === null ? TONE.flat : v >= 0.05 ? TONE.good : v <= -0.05 ? TONE.bad : TONE.flat)
  return (
    <div className="flex items-center gap-2 border-t border-zinc-800 py-2.5 first:border-t-0">
      <div className="min-w-0 flex-1">
        <p className={`font-bold leading-tight text-zinc-100 ${big ? "text-2xl" : "text-[17px]"}`}>
          {title}
          {tag && <span className="ml-1.5 rounded bg-zinc-700 px-1.5 py-0.5 align-[3px] text-[10px] font-semibold text-zinc-200">{tag}</span>}
        </p>
        {small && <p className="text-[11px] text-zinc-500">{small}</p>}
        <p className="mt-1 text-[13px] text-zinc-400">
          Typical home here: <b className="text-zinc-100">${Math.round(value).toLocaleString("en-US")}</b> <span className="text-[11px] text-zinc-600">({when})</span>
        </p>
        <div className="mt-0.5 flex gap-4 text-[13px]">
          <div>
            <span className="block text-[10px] uppercase tracking-wide text-zinc-500">vs last year</span>
            <b style={{ color: tone(yoy) }}>{yoy === null ? "—" : formatValue(yoy, "pct_signed")}</b>
          </div>
          <div>
            <span className="block text-[10px] uppercase tracking-wide text-zinc-500">vs peak{peak ? ` (${peak.month})` : ""}</span>
            <b style={{ color: tone(peak?.pct ?? null) }}>{peak ? formatValue(peak.pct, "pct_signed") : "—"}</b>
          </div>
        </div>
      </div>
      <Spark slots={slots} />
    </div>
  )
}

// ---------------------------------------------------------------- page
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
  const R = state.readings
  const dialById = new Map(state.dials.map((d) => [d.id, d]))
  const due = checkpointDue(today, { calendar: state.calendar, readings: R, checkpoints: state.checkpoints }, state.tripwireEvents)
  const next = nextCheckpoint(today, { calendar: state.calendar, checkpoints: state.checkpoints })
  const nextReview = next ? `~${longDate(next.date)} (${next.kind})` : "not scheduled"
  const votes = new Map(
    computeVotes(state.dials, R, today)
      .filter((v) => v.vote === "bear" || v.vote === "base" || v.vote === "bull")
      .map((v) => [v.dial_id, v.vote as Scenario]),
  )

  const zipDials = state.ownedProperties.length ? Array.from(new Set(state.ownedProperties.map((p) => p.zip))) : ["95118", "95123", "95130"]
  const peakIds = [...NEARBY.map((n) => n.dial), ...zipDials.map((z) => `zhvi_zip_${z}_level`)]
  const allTime: Record<string, { as_of: string; value: number }> = loadError ? {} : await peaks(peakIds).catch(() => ({}))
  const sfrInv = loadError ? [] : await sfrInventory().catch(() => [] as Reading[])
  R["scc_sfr_inventory"] = sfrInv

  // ---- one dial row
  const row = (id: string, opts: { sub?: string; chartId?: string } = {}): RowData | null => {
    const disp = DISPLAY[id] as DialDisplay | undefined
    const dial = dialById.get(id)
    const rows = R[id]
    const last = latest(rows)
    if (!disp || !dial || !last) return null
    const tr = trend(dial, rows ?? [], disp.format, disp.context)
    const when = `${dateLabel(last.as_of, dial.cadence)} · ${dial.cadence}`
    return {
      id,
      label: disp.label,
      value: formatValue(last.value, disp.format),
      tone: tr.tone,
      arrow: tr.arrow,
      sub: [disp.what, opts.sub, when].filter(Boolean).join(" · "),
      slots: last12Months(R[opts.chartId ?? id] ?? []),
      chip: votes.get(id) ?? null,
    }
  }
  const drawdownNote = (id: string, what = "its Oct 6 high") => {
    const d = dialById.get(id)
    if (!d) return undefined
    const s = corridorSeries(d, R[id] ?? [])
    const l = s[s.length - 1]
    return l ? `${Math.abs(l.value).toFixed(1)}% ${l.value < 0 ? "below" : "above"} ${what}` : undefined
  }
  // Homes for sale: our weekly single-family count, with the realtor association's
  // single-family inventory as the 12-month chart and the "normal" yardstick.
  const invLast = latest(sfrInv)
  const invDial = dialById.get("scc_months_supply")
  const invNormal = invDial && invLast ? vsNormal({ ...invDial, id: "scc_sfr_inventory", corridor: null }, sfrInv) : null
  const invNote = invLast ? `${MON[Number(invLast.as_of.slice(5, 7)) - 1]}: ${formatValue(invLast.value, "int")} listed${invNormal ? `, ${invNormal}` : ""}` : undefined
  // Price cuts need two weekly snapshots of the same listings: until then, say when it starts.
  const cutsRows = valued(R["mls_scc_price_cut_share"])
  const cutsReady = cutsRows.length >= 2
  const keyRows = [
    row("zhvi_scc_drawdown"),
    row("mls_scc_active_sfr", { sub: invNote, chartId: "scc_sfr_inventory" }),
    cutsReady
      ? row("mls_scc_price_cut_share")
      : { id: "mls_scc_price_cut_share", label: "Price cuts", value: "—", tone: "flat" as Tone, arrow: "", sub: `Single-family listings with a cut · first reading ${fromDateLabel(valued(R["mls_scc_active_sfr"])[0]?.as_of)}`, slots: [], chip: null },
    row("mls_scc_pending_ratio"),
    row("mortgage30"),
    row("brent"),
    row("sp500", { sub: drawdownNote("sp500") }),
    row("nasdaq", { sub: drawdownNote("nasdaq") }),
    row("sj_msa_nonfarm_yoy"),
  ].filter((x): x is RowData => !!x)
  const keyIds = new Set(Object.entries(DISPLAY).filter(([, d]) => d.key).map(([id]) => id))

  // ---- layoffs: last 30 days vs the 12-month average and the alarm line
  const warnMonthly = valued(R["scc_warn_workers"])
  const fullMonths = warnMonthly.filter((r) => r.as_of.slice(0, 7) < today.slice(0, 7)).slice(-12)
  const warnAvg = fullMonths.length ? fullMonths.reduce((a, b) => a + b.value, 0) / fullMonths.length : null
  const warnThisMonth = warnMonthly.find((r) => r.as_of.slice(0, 7) === today.slice(0, 7))
  const warnSub = [
    warnAvg !== null ? `12-mo avg ~${Math.round(warnAvg).toLocaleString("en-US")}` : null,
    "alarm at 1,588",
    warnThisMonth ? `${MON[Number(today.slice(5, 7)) - 1]} so far: ${Math.round(warnThisMonth.value).toLocaleString("en-US")}` : null,
  ]
    .filter(Boolean)
    .join(" · ")

  // ---- scroll box groups
  const groupRows = GROUP_ORDER.map((g) => ({
    group: g,
    rows: Object.entries(DISPLAY)
      .filter(([id, d]) => d.group === g && !keyIds.has(id))
      .map(([id]) => {
        if (id === "scc_warn_workers_30d") return row(id, { sub: warnSub, chartId: "scc_warn_workers" })

        if (id === "basket_index") return row(id, { sub: drawdownNote("basket_index") })
        return row(id)
      })
      .filter((x): x is RowData => !!x),
  })).filter((g) => g.rows.length)
  const scrollCount = groupRows.reduce((a, g) => a + g.rows.length, 0)

  // ---- price bands (this week vs a real prior week)
  const bandRows = PRICE_BANDS.map((b) => {
    const d = dialById.get(b.active)
    const rows = R[b.active] ?? []
    const l = latest(rows)
    const prev = d ? previousReading(d, rows) : null
    const cd = dialById.get(b.cuts)
    const cuts = latest(R[b.cuts])
    const cutsPrev = cd ? previousReading(cd, R[b.cuts] ?? []) : null
    return { label: b.label, forSale: l?.value ?? null, delta: l && prev ? l.value - prev.value : null, cuts: cuts && cutsPrev ? cuts.value : null }
  })
  const fromDate = fromDateLabel(valued(R["mls_scc_tier_1_3m_2m_active_sfr"])[0]?.as_of)
  const top = latest(R["zhvi_scc_top_yoy"])
  const bottom = latest(R["zhvi_scc_bottom_yoy"])
  // same rule as every change number: below zero red, above zero green (±0.05 flat)
  const toneOf = (v: number | undefined) => (v === undefined ? TONE.flat : v >= 0.05 ? TONE.good : v <= -0.05 ? TONE.bad : TONE.flat)

  // ---- zips + nearby markets
  const area = (dialId: string, title: string, small: string | null, tag: string | null) => {
    const rows = R[dialId] ?? []
    const l = latest(rows)
    if (!l) return null
    return { dialId, title, small, tag, value: l.value, yoy: yearOverYear(rows), peak: vsPeak(rows, allTime[dialId] ?? null), slots: last12Months(rows), when: dateLabel(l.as_of, "monthly") }
  }
  const zips = zipDials
    .map((z) => {
      const p = state.ownedProperties.find((x) => x.zip === z)
      const street = p?.address?.split(",")[0] ?? null
      const nick = p?.flag === "home" ? "Your home" : street ? street.replace(/^\d+\s+/, "").split(" ")[0] : null
      const tag = p?.flag === "home" ? "home" : p?.listed_on ? `listed ${longDate(p.listed_on).replace(/, \d{4}$/, "")}` : null
      return area(`zhvi_zip_${z}_level`, z, [nick, street].filter(Boolean).join(" · ") || null, tag)
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
  const nearby = NEARBY.map((n) => area(n.dial, n.label, n.note ?? null, null)).filter((x): x is NonNullable<typeof x> => !!x)

  // ---- reviews & odds moves: one list, newest first
  type Entry = { date: string; order: string; checkpoint: Checkpoint | null; alarm: boolean; bets: { bet: BetDef; before: Weights | null; after: Weights }[]; why: string; against: string | null; reverses: string | null }
  const betOf = (id: string | null | undefined) => BETS.find((b) => b.id === (id || "housing")) ?? BETS[0]
  const cpIds = new Set(state.checkpoints.map((c) => c.id))
  const entries: Entry[] = []
  for (const cp of state.checkpoints) {
    const moved = state.weightMoves.find((m) => m.checkpoint_id === cp.id)
    const per = cp.bets
      ? Object.entries(cp.bets).map(([id, b]) => ({ bet: betOf(id), before: b.weights_before, after: b.weights_after }))
      : cp.weights_after
        ? [{ bet: betOf("housing"), before: cp.weights_before, after: cp.weights_after }]
        : []
    entries.push({ date: cp.date, order: cp.created_at ?? cp.date, checkpoint: cp, alarm: cp.kind === "tripwire", bets: per, why: moved?.argument ?? cp.argument ?? "", against: moved?.opposite_case ?? cp.opposite_case, reverses: moved?.reverses_if ?? null })
  }
  for (const m of state.weightMoves.filter((x) => !x.checkpoint_id || !cpIds.has(x.checkpoint_id))) {
    entries.push({ date: m.date, order: m.date, checkpoint: null, alarm: false, bets: [{ bet: betOf(m.bet_id), before: null, after: m.to_weights }], why: `Starting odds. ${m.argument}`, against: m.opposite_case, reverses: m.reverses_if })
  }
  for (const b of BETS) {
    if (!state.weightMoves.some((m) => (m.bet_id || "housing") === b.id) && b.move0) {
      entries.push({ date: b.move0.date, order: b.move0.date, checkpoint: null, alarm: false, bets: [{ bet: b, before: null, after: b.move0.to }], why: `Starting odds. ${b.move0.reason}`, against: b.move0.opposite_case, reverses: b.move0.reverses_if })
    }
  }
  entries.sort((a, b) => b.date.localeCompare(a.date) || b.order.localeCompare(a.order))
  const oddsText = (before: Weights | null, after: Weights) => SC.map((s) => (before && before[s] !== after[s] ? `${cap(s)} ${before[s]} → ${after[s]}` : `${cap(s)} ${after[s]}`)).join(" · ")
  const betTag = (b: BetDef) => `${BET_EMOJI[b.id] ?? ""} ${b.id === "housing" ? "Houses" : "Stocks"}`

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 pb-10">
      <div>
        <h1 className="text-lg font-semibold text-zinc-100">Market cycle</h1>
        <p className="text-xs text-zinc-500">
          Thesis v1.2 · {longDate(today)} · {due.due ? `review due today (${due.kind})` : `next review ${nextReview}`}
        </p>
      </div>

      {loadError && <p className="rounded-lg border border-amber-800 bg-amber-950/40 p-2 text-xs text-amber-300">Couldn&apos;t load the stored data ({loadError}). Showing the thesis config only.</p>}

      {BETS.map((b) => (
        <BetCard key={b.id} bet={b} weights={state.betWeights[b.id] ?? b.initial_weights} now={betNow(b, state)} accent={b.id !== "housing"} nextReview={nextReview} />
      ))}

      <Card title="Dials">
        <p className="mb-2 text-[11px] leading-snug text-zinc-500">
          Charts = last 12 months · ▲▼ = direction · <b style={{ color: TONE.good }}>green</b> good / <b style={{ color: TONE.bad }}>red</b> bad / <b style={{ color: TONE.flat }}>gray</b> flat — for SCC house prices
        </p>
        <p className="mb-1 text-xs font-bold uppercase tracking-wider text-zinc-400">Key numbers</p>
        {keyRows.map((r) => (
          <DialRow key={r.id} {...r} />
        ))}

        <p className="mb-1.5 mt-4 text-xs font-bold uppercase tracking-wider text-zinc-400">By price band · this week</p>
        <div className="text-[13px]">
          <div className="grid grid-cols-[1.3fr_.8fr_.9fr_1fr] py-1 text-[10.5px] uppercase tracking-wide text-zinc-500">
            <span>Price band</span>
            <span>For sale</span>
            <span>vs last wk</span>
            <span>Price cuts</span>
          </div>
          {bandRows.map((b) => (
            <div key={b.label} className="grid grid-cols-[1.3fr_.8fr_.9fr_1fr] border-t border-zinc-800 py-1.5 text-zinc-200">
              <span>{b.label}</span>
              <span>{b.forSale !== null ? Math.round(b.forSale).toLocaleString("en-US") : "—"}</span>
              <span className={b.delta === null ? "text-[11px] text-zinc-600" : ""}>{b.delta === null ? (fromDate ? `from ${fromDate}` : "—") : `${b.delta > 0 ? "▲ +" : b.delta < 0 ? "▼ " : "▬ "}${Math.round(b.delta)}`}</span>
              <span className={b.cuts === null ? "text-[11px] text-zinc-600" : ""}>{b.cuts === null ? (fromDate ? `from ${fromDate}` : "—") : `${b.cuts.toFixed(1)}%`}</span>
            </div>
          ))}
          <p className="border-t border-zinc-800 pt-1.5 text-[11.5px] text-zinc-400">
            Home values vs last year: high-end <b style={{ color: toneOf(top?.value) }}>{top ? formatValue(top.value, "pct_signed") : "—"}</b> · low-end{" "}
            <b style={{ color: toneOf(bottom?.value) }}>{bottom ? formatValue(bottom.value, "pct_signed") : "—"}</b>
            {top ? ` (${dateLabel(top.as_of, "monthly")})` : ""}
          </p>
        </div>

        <div className="mb-1.5 mt-4 flex items-baseline justify-between">
          <p className="text-xs font-bold uppercase tracking-wider text-zinc-400">All dials ({scrollCount})</p>
          <span className="text-[11px] text-zinc-500">scroll ↕</span>
        </div>
        <div className="max-h-[60vh] overflow-y-auto overscroll-contain rounded-lg border border-zinc-700 bg-zinc-950/60 px-2.5">
          {groupRows.map((g) => (
            <div key={g.group}>
              <p className="sticky top-0 z-10 -mx-2.5 border-b border-zinc-800 bg-zinc-950 px-2.5 pb-1 pt-2.5 text-[11px] font-bold uppercase tracking-wider text-zinc-400">{g.group}</p>
              {g.rows.map((r) => (
                <DialRow key={r.id} {...r} />
              ))}
            </div>
          ))}
        </div>
        <p className="mt-1.5 text-center text-[11px] text-zinc-500">Scrolls inside the box — the rest of the page stays put</p>
      </Card>

      <Card title="My zip codes">
        <p className="mb-1 text-[11px] text-zinc-500">The typical single-family home in each zip (Zillow) — not your house&apos;s value · updates monthly</p>
        {zips.length === 0 && <p className="text-xs text-zinc-500">No zip readings stored yet.</p>}
        {zips.map((z) => (
          <AreaRow key={z.dialId} {...z} big />
        ))}
      </Card>

      <Card title="Nearby markets">
        <p className="mb-1 text-[11px] text-zinc-500">Typical single-family home (Zillow) · updates monthly · context only, never a vote</p>
        {nearby.length === 0 && <p className="text-xs text-zinc-500">No area readings stored yet.</p>}
        {nearby.map((a) => (
          <AreaRow key={a.dialId} {...a} />
        ))}
      </Card>

      <Card title="Reviews & odds moves">
        <p className="mb-2 text-[11px] leading-snug text-zinc-500">Newest first. Every move keeps its reason, the case against it, and what would reverse it. Tap one to open it.</p>
        {entries.map((e, i) => (
          <details key={`${e.date}-${i}`} open={i === 0} className={`group py-2 ${i === 0 ? "rounded-lg border border-zinc-700 bg-zinc-950/60 px-2.5" : "border-t border-zinc-800"}`}>
            <summary className="cursor-pointer list-none">
              <p className="text-[13px] font-semibold text-zinc-100">
                {longDate(e.date)}
                {e.bets.map((b) => (
                  <span key={b.bet.id} className="ml-1.5 rounded-full bg-zinc-800 px-1.5 py-0.5 align-[1px] text-[10px] font-semibold text-zinc-400">
                    {betTag(b.bet)}
                  </span>
                ))}
                {e.alarm && <span className="ml-1.5 rounded-full bg-orange-950 px-1.5 py-0.5 align-[1px] text-[10px] font-semibold text-orange-300">alarm fired</span>}
              </p>
              {e.bets.map((b) => (
                <p key={b.bet.id} className="text-xs text-zinc-300">
                  {e.bets.length > 1 ? `${b.bet.id === "housing" ? "Houses" : "Stocks"}: ` : ""}
                  {oddsText(b.before, b.after)}
                  {b.before && SC.every((s) => b.before![s] === b.after[s]) ? " (no change)" : ""}
                </p>
              ))}
              <p className="text-xs text-zinc-400 group-open:hidden">
                {e.why.length > 110 ? e.why.slice(0, 109) + "…" : e.why} <span className="text-zinc-600">more ▸</span>
              </p>
            </summary>
            <p className="mt-2 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Why</p>
            <p className="text-[12.5px] leading-snug text-zinc-300">{e.why || "—"}</p>
            {e.against && (
              <>
                <p className="mt-2 text-[10px] font-bold uppercase tracking-wider text-zinc-500">The case against</p>
                <p className="text-[12.5px] leading-snug text-zinc-300">{e.against}</p>
              </>
            )}
            {e.reverses && (
              <>
                <p className="mt-2 text-[10px] font-bold uppercase tracking-wider text-zinc-500">What reverses it</p>
                <p className="text-[12.5px] leading-snug text-zinc-300">{e.reverses}</p>
              </>
            )}
            {e.checkpoint && <DisagreeButton checkpointId={e.checkpoint.id} existing={e.checkpoint.ryan_note} />}
          </details>
        ))}
        <p className="mt-2 text-center text-[11px] text-zinc-500">Next review {nextReview} · claims and scoring live on the back end</p>
      </Card>
    </div>
  )
}
