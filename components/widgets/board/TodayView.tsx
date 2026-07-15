"use client"

import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import {
  QUOTAS,
  contactCounts,
  draftTotals,
  eventsInWeekOf,
  eventsOn,
  formatOverPar,
  formatWinRatePct,
  gameLineString,
  lastEvent,
  type Bucket,
  type BoardEvent,
  type PaOutcome,
} from "@/lib/board"
import type { BoardActions } from "@/components/widgets/board/BoardTab"
import { Chip, SectionCard, Stepper, TapButton } from "@/components/widgets/board/ui"

const BUCKET_LABELS: { key: Bucket; label: string }[] = [
  { key: "agent", label: "Agent" },
  { key: "seller", label: "Seller" },
  { key: "referral_partner", label: "Referral" },
]

const PA_BUTTONS: PaOutcome[] = ["1B", "2B", "3B", "HR", "BB", "SF", "K", "OUT"]

export function TodayView({
  events,
  confirmed,
  todayKey,
  actions,
  busy,
  withBusy,
  linkedNames,
}: {
  events: BoardEvent[]    // confirmed + optimistic pending (drives counts)
  confirmed: BoardEvent[] // server-confirmed only (drives undo targets)
  todayKey: string
  actions: BoardActions
  busy: Set<string>
  withBusy: (key: string, fn: () => Promise<unknown>) => Promise<void>
  linkedNames: Record<string, string>
}) {
  const today = eventsOn(events, todayKey)
  const week = eventsInWeekOf(events, todayKey)

  // financial
  const contacts = contactCounts(today)
  const offersWeek = week.filter(e => e.event_type === "offer").length
  const lastTouch = lastEvent(eventsOn(confirmed, todayKey), "contact_touch")
  const lastOffer = lastEvent(eventsOn(confirmed, todayKey), "offer")

  // mtg
  const draftsToday = today.filter(e => e.event_type === "draft").length
  const record = draftTotals(events)
  const lastDraft = lastEvent(eventsOn(confirmed, todayKey), "draft")
  const [draftW, setDraftW] = useState(0)
  const [draftL, setDraftL] = useState(0)

  // disc golf
  const roundsWeek = week.filter(e => e.event_type === "dg_round").length
  const practicesWeek = week.filter(e => e.event_type === "dg_practice").length
  const lastRound = lastEvent(eventsOn(confirmed, todayKey), "dg_round")
  const lastPractice = lastEvent(eventsOn(confirmed, todayKey), "dg_practice")
  const [overPar, setOverPar] = useState(0)

  // softball
  const cagesWeek = week.filter(e => e.event_type === "cage").length
  const lastCage = lastEvent(eventsOn(confirmed, todayKey), "cage")
  const lastGame = lastEvent(eventsOn(confirmed, todayKey), "softball_game")
  const [pas, setPas] = useState<PaOutcome[]>([])

  return (
    <div className="flex flex-col gap-3.5">
      {/* ------------------------------------------------ financial */}
      <SectionCard
        title="Financial"
        accent="border-t-amber-500/70"
        chip={<Chip n={contacts.total} target={QUOTAS.contactsPerDay} label="contacts" />}
      >
        <p className="mb-2.5 text-xs text-zinc-500">Contacts today — any mix counts toward 10</p>
        <div className="mb-2.5 grid grid-cols-3 gap-2">
          {BUCKET_LABELS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => actions.log("contact_touch", { bucket: key })}
              className="flex min-h-16 flex-col items-center justify-center gap-0.5 rounded-xl bg-zinc-800 transition-colors hover:bg-zinc-700 active:scale-[0.97]"
            >
              <span className="font-mono text-xl font-semibold text-zinc-100">{contacts[key]}</span>
              <span className="text-[11px] font-semibold uppercase tracking-widest text-zinc-400">
                + {label}
              </span>
            </button>
          ))}
        </div>
        <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-zinc-800">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              contacts.total >= QUOTAS.contactsPerDay ? "bg-green-500" : "bg-amber-500"
            )}
            style={{ width: `${Math.min(100, (contacts.total / QUOTAS.contactsPerDay) * 100)}%` }}
          />
        </div>

        {lastTouch && (
          <LinkTouchRow key={lastTouch.id} touch={lastTouch} actions={actions} linkedNames={linkedNames} />
        )}

        <div className="mt-1 flex items-center justify-between border-t border-dashed border-zinc-800 pt-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-zinc-300">Offers written</span>
            <Chip n={offersWeek} target={QUOTAS.offersPerWeek} label="this wk" />
          </div>
          <div className="flex items-center gap-2">
            {lastOffer && (
              <TapButton variant="ghost" onClick={() => actions.undo(lastOffer)} className="text-xs">
                Undo
              </TapButton>
            )}
            <TapButton
              variant="primary"
              disabled={busy.has("offer")}
              onClick={() => withBusy("offer", () => actions.log("offer", {}))}
            >
              + Log offer
            </TapButton>
          </div>
        </div>
        {lastTouch && (
          <div className="mt-2 text-right">
            <button
              onClick={() => actions.undo(lastTouch)}
              className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
            >
              Undo last contact
            </button>
          </div>
        )}
      </SectionCard>

      {/* ------------------------------------------------ mtg draft */}
      <SectionCard
        title="MTG Draft"
        accent="border-t-purple-500/70"
        chip={<Chip n={draftsToday} target={QUOTAS.draftsPerDay} label="today" />}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-5">
            <Stepper label="Wins" value={draftW} onChange={setDraftW} min={0} max={20} />
            <Stepper label="Losses" value={draftL} onChange={setDraftL} min={0} max={20} />
          </div>
          <TapButton
            variant="primary"
            disabled={busy.has("draft")}
            onClick={() =>
              withBusy("draft", async () => {
                const saved = await actions.log("draft", { wins: draftW, losses: draftL })
                if (saved) { setDraftW(0); setDraftL(0) }
              })
            }
          >
            Save draft
          </TapButton>
        </div>
        <div className="mt-3 flex items-center justify-between border-t border-dashed border-zinc-800 pt-2.5 text-xs text-zinc-500">
          <span>
            Record{" "}
            <span className="font-mono text-zinc-300">
              {record.wins}–{record.losses}
            </span>{" "}
            · Win rate{" "}
            <span className="font-mono text-zinc-300">{formatWinRatePct(record.winRate)}</span>
          </span>
          {lastDraft && (
            <button
              onClick={() => actions.undo(lastDraft)}
              className="text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
            >
              Undo last draft
            </button>
          )}
        </div>
      </SectionCard>

      {/* ------------------------------------------------ disc golf */}
      <SectionCard
        title="Disc Golf"
        accent="border-t-sky-500/70"
        chip={
          <>
            <Chip n={roundsWeek} target={QUOTAS.dgRoundsPerWeek} label="rnd wk" />
            <Chip n={practicesWeek} target={QUOTAS.dgPracticesPerWeek} label="prac wk" />
          </>
        }
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="mb-1.5 text-xs text-zinc-500">Round score vs par</p>
            <Stepper
              label="Over par"
              value={overPar}
              onChange={setOverPar}
              min={-20}
              max={60}
              format={v => formatOverPar(v, 0)}
            />
          </div>
          <div className="flex flex-col items-stretch gap-2">
            <TapButton
              variant="primary"
              disabled={busy.has("dg_round")}
              onClick={() =>
                withBusy("dg_round", async () => {
                  const saved = await actions.log("dg_round", { over_par: overPar })
                  if (saved) setOverPar(0)
                })
              }
            >
              Save round
            </TapButton>
            <TapButton
              variant="ghost"
              disabled={busy.has("dg_practice")}
              onClick={() => withBusy("dg_practice", () => actions.log("dg_practice", {}))}
            >
              + Practice session
            </TapButton>
          </div>
        </div>
        {(lastRound || lastPractice) && (
          <div className="mt-3 flex justify-end gap-3 border-t border-dashed border-zinc-800 pt-2.5 text-xs">
            {lastRound && (
              <button
                onClick={() => actions.undo(lastRound)}
                className="text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
              >
                Undo round ({formatOverPar(Number(lastRound.payload.over_par ?? 0), 0)})
              </button>
            )}
            {lastPractice && (
              <button
                onClick={() => actions.undo(lastPractice)}
                className="text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
              >
                Undo practice
              </button>
            )}
          </div>
        )}
      </SectionCard>

      {/* ------------------------------------------------ softball */}
      <SectionCard
        title="Softball"
        accent="border-t-red-500/70"
        chip={<Chip n={cagesWeek} target={QUOTAS.cagesPerWeek} label="cage wk" />}
      >
        <p className="mb-2.5 text-xs text-zinc-500">Tap one per plate appearance</p>
        <div className="mb-2.5 grid grid-cols-4 gap-2">
          {PA_BUTTONS.map(o => (
            <button
              key={o}
              onClick={() => setPas(p => [...p, o])}
              className={cn(
                "min-h-12 rounded-lg text-sm font-bold tracking-wider transition-colors active:scale-[0.96]",
                o === "HR"
                  ? "bg-amber-500/90 text-zinc-950 hover:bg-amber-400"
                  : o === "K" || o === "OUT"
                    ? "bg-zinc-800 text-red-300 hover:bg-zinc-700"
                    : "bg-zinc-800 text-zinc-100 hover:bg-zinc-700"
              )}
            >
              {o}
            </button>
          ))}
        </div>

        {pas.length > 0 && (
          <div className="mb-2.5 rounded-lg bg-zinc-950/60 px-3 py-2 font-mono text-xs text-zinc-300">
            {pas.join(" · ")}
            <span className="ml-2 text-zinc-500">—</span>{" "}
            <span className="text-zinc-100">{gameLineString(pas)}</span>
          </div>
        )}

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TapButton
              variant="ghost"
              disabled={busy.has("cage")}
              onClick={() => withBusy("cage", () => actions.log("cage", {}))}
            >
              + Cage
            </TapButton>
            {pas.length > 0 && (
              <TapButton variant="ghost" onClick={() => setPas(p => p.slice(0, -1))}>
                Undo PA
              </TapButton>
            )}
          </div>
          <TapButton
            variant="primary"
            disabled={pas.length === 0 || busy.has("softball_game")}
            onClick={() =>
              withBusy("softball_game", async () => {
                const saved = await actions.log("softball_game", { pa: pas })
                if (saved) setPas([])
              })
            }
          >
            Save game
          </TapButton>
        </div>
        {(lastGame || lastCage) && (
          <div className="mt-3 flex justify-end gap-3 border-t border-dashed border-zinc-800 pt-2.5 text-xs">
            {lastGame && (
              <button
                onClick={() => actions.undo(lastGame)}
                className="text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
              >
                Undo game ({gameLineString((lastGame.payload.pa as PaOutcome[]) ?? [])})
              </button>
            )}
            {lastCage && (
              <button
                onClick={() => actions.undo(lastCage)}
                className="text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
              >
                Undo cage
              </button>
            )}
          </div>
        )}
      </SectionCard>
    </div>
  )
}

// Optional link of the most recent contact touch to a relationships row —
// enables conversation-to-offer ratios later without adding tap friction now.
// Inline expanding panel, NOT a fixed overlay (iOS Safari dismissal gotcha).
function LinkTouchRow({
  touch,
  actions,
  linkedNames,
}: {
  touch: BoardEvent
  actions: BoardActions
  linkedNames: Record<string, string>
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<{ id: string; name: string; type: string }[]>([])
  const [searching, setSearching] = useState(false)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setResults([])
      return
    }
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(async () => {
      try {
        setSearching(true)
        const res = await fetch(`/api/relationships?name=${encodeURIComponent(query.trim())}`, {
          cache: "no-store",
        })
        const data = await res.json()
        setResults((data.matches ?? []).slice(0, 5))
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 300)
    return () => { if (debounce.current) clearTimeout(debounce.current) }
  }, [open, query])

  const bucket = String(touch.payload.bucket ?? "").replace("_", " ")
  const linkedName = touch.relationship_id ? linkedNames[touch.relationship_id] ?? "linked" : null

  return (
    <div className="rounded-lg bg-zinc-950/60 px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="capitalize text-zinc-400">
          Last: <span className="text-zinc-200">{bucket}</span> touch
          {linkedName && <span className="text-green-400"> · {linkedName}</span>}
        </span>
        {touch.relationship_id ? (
          <button
            onClick={() => actions.link(touch.id, null)}
            className="text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
          >
            Unlink
          </button>
        ) : (
          <button
            onClick={() => setOpen(o => !o)}
            className="text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline"
          >
            {open ? "Cancel" : "Link contact"}
          </button>
        )}
      </div>
      {open && !touch.relationship_id && (
        <div className="mt-2">
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search relationships…"
            autoFocus
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
          />
          {searching && <p className="mt-1.5 text-zinc-600">Searching…</p>}
          {results.map(r => (
            <button
              key={r.id}
              onClick={async () => {
                const ok = await actions.link(touch.id, r.id, r.name)
                if (ok) { setOpen(false); setQuery("") }
              }}
              className="mt-1.5 flex w-full items-center justify-between rounded-lg bg-zinc-800/70 px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-700"
            >
              <span>{r.name}</span>
              <span className="text-xs text-zinc-500">{r.type}</span>
            </button>
          ))}
          {!searching && query.trim().length >= 2 && results.length === 0 && (
            <p className="mt-1.5 text-zinc-600">No matches</p>
          )}
        </div>
      )}
    </div>
  )
}
