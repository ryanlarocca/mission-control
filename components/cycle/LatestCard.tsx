import type { BetSigns, CheckedStamp, LatestGroup } from "@/lib/marketCycle/latest"
import type { Tone } from "@/lib/marketCycle/view"

// "Latest numbers" — top of /cycle (Ryan 2026-11-19: the page looked frozen
// between reviews). Server component: what the collectors brought in, by how
// often each source really changes, and the live up/down count. Phone first.

const TONE: Record<Tone, string> = { good: "#4ade80", bad: "#f87171", flat: "#9aa6c0" }
const UP = "#4ade80"
const DOWN = "#f87171"
const MIDDLE = "#a78bfa"

const signs = (n: number, dir: string, first: boolean) => (first ? `${n} ${n === 1 ? "sign points" : "signs point"} ${dir}` : n === 0 ? `none ${dir}` : `${n} ${n === 1 ? "points" : "point"} ${dir}`)

export interface BetSignsView extends BetSigns {
  title: string
}

function SignList({ items, color, mark }: { items: { dialId: string; text: string; when: string }[]; color: string; mark: string }) {
  if (!items.length) return null
  return (
    <ul className="mt-0.5 space-y-0.5">
      {items.map((s) => (
        <li key={s.dialId} className="flex gap-1.5 text-[12.5px] leading-snug text-zinc-300">
          <span className="shrink-0" style={{ color }}>
            {mark}
          </span>
          <span>
            {s.text} {s.when && <span className="text-[10.5px] text-zinc-500">· {s.when}</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}

export default function LatestCard({ stamp, bets, groups, alarm, nextReview }: { stamp: CheckedStamp; bets: BetSignsView[]; groups: LatestGroup[]; alarm: { value: string; note: string; tone: Tone }; nextReview: string | null }) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Latest numbers</h2>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${stamp.stale ? "bg-amber-950 text-amber-300" : "bg-emerald-950 text-emerald-300"}`}>{stamp.stale ? "not checked lately" : "fresh"}</span>
      </div>
      <p className={`text-[13px] font-medium ${stamp.stale ? "text-amber-300" : "text-zinc-200"}`}>{stamp.text}</p>

      {bets.map((b) => {
        const order = [
          { n: b.up.length, dir: "up", color: UP },
          { n: b.down.length, dir: "down", color: DOWN },
          ...(b.middle.length ? [{ n: b.middle.length, dir: "to the middle case", color: MIDDLE }] : []),
        ]
        const leaning = [...b.leaningUp.map((t) => `▲ ${t}`), ...b.leaningDown.map((t) => `▼ ${t}`)]
        return (
          <div key={b.betId} className="mt-3 border-t border-zinc-800 pt-2">
            <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">{b.title}</p>
            <p className="text-[15px] font-semibold text-zinc-100">
              {order.map((o, i) => (
                <span key={o.dir}>
                  {i > 0 && <span className="text-zinc-600"> · </span>}
                  <span style={{ color: o.n ? o.color : "#9aa6c0" }}>{signs(o.n, o.dir, i === 0)}</span>
                </span>
              ))}
            </p>
            <SignList items={b.up} color={UP} mark="▲" />
            <SignList items={b.down} color={DOWN} mark="▼" />
            <SignList items={b.middle} color={MIDDLE} mark="●" />
            {leaning.length > 0 && <p className="mt-1 text-[11px] leading-snug text-zinc-500">Not counted yet, waiting on a second reading: {leaning.join(" · ")}</p>}
            <p className="mt-1 text-[12.5px] font-semibold text-sky-300">{b.tilt}</p>
          </div>
        )
      })}

      {groups.map((g) => (
        <div key={g.cadence} className="mt-3 border-t border-zinc-800 pt-2">
          <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">{g.title}</p>
          {g.items.map((it) => (
            <div key={it.id} className="py-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 text-[13px] leading-tight text-zinc-200">
                  {it.label}
                  {it.fresh && <span className="ml-1.5 rounded bg-sky-950 px-1 py-px align-[1px] text-[9.5px] font-semibold text-sky-300">new</span>}
                </span>
                <span className="shrink-0 text-[14px] font-semibold" style={{ color: TONE[it.tone] }}>
                  {it.value}
                </span>
              </div>
              <p className="text-[11px] leading-snug text-zinc-500">
                {it.note ? `${it.note} · ` : ""}
                {it.when}
              </p>
            </div>
          ))}
          {g.cadence === "daily" && (
            <div className="py-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] leading-tight text-zinc-200">Alarms</span>
                <span className="shrink-0 text-[14px] font-semibold" style={{ color: TONE[alarm.tone] }}>
                  {alarm.value}
                </span>
              </div>
              <p className="text-[11px] leading-snug text-zinc-500">{alarm.note}</p>
            </div>
          )}
        </div>
      ))}

      <p className="mt-2 border-t border-zinc-800 pt-1.5 text-[10.5px] text-zinc-600">
        Colours = what it means for SCC house prices. Odds update at the monthly review{nextReview ? ` (next ${nextReview})` : ""} · timing bars and &ldquo;how deep&rdquo; every 3 months.
      </p>
    </section>
  )
}
