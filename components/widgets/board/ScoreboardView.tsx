"use client"

import {
  QUOTAS,
  contactCounts,
  dgStats,
  draftTotals,
  eventsInWeekOf,
  formatOverPar,
  formatRate,
  formatWinRatePct,
  rollingOps,
  seasonStats,
  type BoardEvent,
  type BoardPeriod,
} from "@/lib/board"
import { SectionCard, StatRow } from "@/components/widgets/board/ui"

export function ScoreboardView({
  events,
  period,
  todayKey,
}: {
  events: BoardEvent[]
  period: BoardPeriod
  todayKey: string
}) {
  const week = eventsInWeekOf(events, todayKey)
  const weekContacts = contactCounts(week)
  const count = (pool: BoardEvent[], type: BoardEvent["event_type"]) =>
    pool.filter(e => e.event_type === type).length

  const allContacts = contactCounts(events)
  const drafts = draftTotals(events)
  const dg = dgStats(events)
  const games = events.filter(e => e.event_type === "softball_game")
  const sb = seasonStats(games)
  const last5 = rollingOps(games, 5)

  return (
    <div className="flex flex-col gap-3.5">
      <SectionCard title="This week vs targets" accent="border-t-amber-500/70">
        <StatRow label="Contacts" value={weekContacts.total} target={QUOTAS.contactsPerWeek} />
        <StatRow label="Offers written" value={count(week, "offer")} target={QUOTAS.offersPerWeek} />
        <StatRow label="Appointments" value={count(week, "appointment")} target={QUOTAS.appointmentsPerWeek} />
        <StatRow label="MTG drafts" value={count(week, "draft")} target={QUOTAS.draftsPerWeek} />
        <StatRow label="Disc golf rounds" value={count(week, "dg_round")} target={QUOTAS.dgRoundsPerWeek} />
        <StatRow label="Practice sessions" value={count(week, "dg_practice")} target={QUOTAS.dgPracticesPerWeek} />
        <StatRow label="Cage sessions" value={count(week, "cage")} target={QUOTAS.cagesPerWeek} />
        <p className="pt-2 text-[11px] text-zinc-600">Weeks run Monday → Sunday</p>
      </SectionCard>

      <SectionCard title="90-day cumulative" accent="border-t-sky-500/70">
        <StatRow label="Offers written" value={count(events, "offer")} target={QUOTAS.offersPer90} />
        <StatRow label="Appointments" value={count(events, "appointment")} />
        <StatRow label="Contacts — total" value={allContacts.total} />
        <StatRow label="Agent" value={allContacts.agent} />
        <StatRow label="Seller" value={allContacts.seller} />
        <StatRow label="Referral partner" value={allContacts.referral_partner} />
        <StatRow label="Key relationship" value={allContacts.key_relationship} />
        <StatRow
          label="Draft record"
          value={`${drafts.wins}–${drafts.losses} (${drafts.drafts} drafts)`}
        />
        <StatRow label="Draft win rate" value={formatWinRatePct(drafts.winRate)} />
        <StatRow label="DG rounds played" value={dg.rounds} />
        <StatRow label="DG avg over par" value={formatOverPar(dg.avgOverPar)} />
        <p className="pt-2 text-[11px] text-zinc-600">
          Offer floor for the block: {QUOTAS.offersFloor} · target {QUOTAS.offersPer90}
        </p>
      </SectionCard>

      <SectionCard title="Softball line" accent="border-t-red-500/70">
        <StatRow label="Games logged" value={games.length} />
        <StatRow
          label="Line"
          value={`${sb.hits}-for-${sb.ab}, ${sb.hr} HR, ${sb.bb} BB`}
        />
        <StatRow label="AVG" value={formatRate(sb.avg)} />
        <StatRow label="OBP" value={formatRate(sb.obp)} />
        <StatRow label="SLG" value={formatRate(sb.slg)} />
        <StatRow label="OPS" value={formatRate(sb.ops)} />
        <StatRow label="Strikeouts" value={sb.k} />
        <div className="mt-2 rounded-lg bg-zinc-950/60 px-3 py-2.5">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
            OPS trend
          </p>
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-zinc-400">Last 5 games</span>
            <span className="font-mono text-sm font-semibold text-zinc-100">{formatRate(last5)}</span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-zinc-400">Season</span>
            <span className="font-mono text-sm font-semibold text-zinc-100">{formatRate(sb.ops)}</span>
          </div>
          {last5 !== null && sb.ops !== null && (
            <p className="mt-1.5 text-right text-xs">
              {last5 >= sb.ops ? (
                <span className="text-green-400">▲ trending {formatRate(last5 - sb.ops)} above season</span>
              ) : (
                <span className="text-red-400">▼ trending {formatRate(sb.ops - last5)} below season</span>
              )}
            </p>
          )}
        </div>
      </SectionCard>

      <p className="px-2 text-center text-xs text-zinc-600">
        {period.starts_on} → {period.ends_on} · every number derives from the tap log — nothing is entered twice
      </p>
    </div>
  )
}
