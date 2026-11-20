"use client"

import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import { ExternalLink, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { BOARD_LANES, BOARD_TAGS, type BoardItem, type BoardLane } from "@/lib/boardItems"
import { LANE_DOT, linkHref, tagChipClass } from "./boardUi"

/** Fields the sheet can change (all PATCH-able). */
export type BoardEdit = Partial<
  Pick<BoardItem, "title" | "next_step" | "lane" | "due_date" | "due_note" | "tag" | "link" | "waiting_on">
>

const LANE_SHORT: Record<BoardLane, string> = { you: "Your move", waiting: "Waiting", me: "I'm handling" }

type Draft = {
  title: string
  next_step: string
  lane: BoardLane
  due_date: string
  due_note: string
  tag: string
  link: string
  waiting_on: string
}

function toDraft(i: BoardItem): Draft {
  return {
    title: i.title,
    next_step: i.next_step ?? "",
    lane: i.lane,
    due_date: i.due_date ?? "",
    due_note: i.due_note ?? "",
    tag: i.tag ?? "",
    link: i.link ?? "",
    waiting_on: i.waiting_on ?? "",
  }
}

/** Only the fields that changed; blank text → null. */
function diff(item: BoardItem, d: Draft): BoardEdit {
  const out: BoardEdit = {}
  const txt = (v: string) => (v.trim() === "" ? null : v.trim())
  if (d.title.trim() && d.title.trim() !== item.title) out.title = d.title.trim()
  if (d.lane !== item.lane) out.lane = d.lane
  const pairs: [keyof Omit<Draft, "title" | "lane">, string | null][] = [
    ["next_step", item.next_step],
    ["due_date", item.due_date],
    ["due_note", item.due_note],
    ["tag", item.tag],
    ["link", item.link],
    ["waiting_on", item.waiting_on],
  ]
  for (const [k, before] of pairs) {
    const after = txt(d[k])
    if (after !== (before ?? null)) out[k] = after
  }
  return out
}

const inputCls =
  "w-full min-h-[44px] rounded-lg bg-signal-bg border border-signal-border px-3 text-base md:text-sm text-signal-ink placeholder:text-signal-muted/70 focus:outline-none focus:border-signal-accent/60"

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[11px] uppercase tracking-[0.08em] font-semibold text-signal-muted">
        {label}
      </label>
      {children}
    </div>
  )
}

// Detail editor. Phone: bottom sheet. md+: centered modal.
export function BoardSheet({
  item,
  onClose,
  onSave,
}: {
  item: BoardItem
  onClose: () => void
  onSave: (item: BoardItem, edit: BoardEdit) => void
}) {
  const [d, setD] = useState<Draft>(() => toDraft(item))
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD(prev => ({ ...prev, [k]: v }))

  // Escape closes; lock the page behind the sheet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      window.removeEventListener("keydown", onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!d.title.trim()) return
    const edit = diff(item, d)
    if (Object.keys(edit).length > 0) onSave(item, edit)
    onClose()
  }

  const savedLink = d.link.trim()

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center" role="dialog" aria-modal="true" aria-label="Edit card">
      <div className="board-backdrop absolute inset-0 bg-black/60" onClick={onClose} />
      <form
        onSubmit={submit}
        className={cn(
          "board-sheet relative w-full flex flex-col bg-signal-card border-signal-border text-signal-ink",
          "max-h-[92dvh] rounded-t-2xl border-t",
          "md:max-w-lg md:max-h-[88vh] md:rounded-2xl md:border md:shadow-2xl",
        )}
      >
        {/* grabber (phone) */}
        <div className="md:hidden flex justify-center pt-2">
          <span className="w-9 h-[5px] rounded-full bg-signal-border" />
        </div>
        <div className="flex items-center justify-between pl-5 pr-2 pt-1 md:pt-3">
          <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-signal-muted">
            {item.status === "done" ? "Done card" : "Card"}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-11 h-11 flex items-center justify-center text-signal-muted hover:text-signal-ink"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 pb-4 space-y-4">
          <textarea
            value={d.title}
            onChange={e => set("title", e.target.value.replace(/\n/g, " "))}
            rows={d.title.length > 32 ? 2 : 1}
            maxLength={300}
            aria-label="Title"
            placeholder="Title"
            className="block w-full resize-none bg-transparent text-[20px] md:text-lg font-bold leading-snug text-signal-ink placeholder:text-signal-muted/60 focus:outline-none"
          />

          {/* Lane: three big segmented buttons */}
          <div className="grid grid-cols-3 gap-1 rounded-xl bg-signal-bg border border-signal-border p-1" role="group" aria-label="Lane">
            {BOARD_LANES.map(l => (
              <button
                key={l}
                type="button"
                onClick={() => set("lane", l)}
                aria-pressed={d.lane === l}
                className={cn(
                  "min-h-[46px] rounded-lg px-1 text-[14px] md:text-[13px] font-semibold flex items-center justify-center gap-1.5 transition-colors",
                  d.lane === l ? "bg-signal-card2 text-signal-ink shadow-[inset_0_0_0_1px_#2a3757]" : "text-signal-muted",
                )}
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: LANE_DOT[l] }} />
                <span className="truncate">{LANE_SHORT[l]}</span>
              </button>
            ))}
          </div>

          <Field label="Next step" htmlFor="board-next">
            <textarea
              id="board-next"
              value={d.next_step}
              onChange={e => set("next_step", e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="The very next thing to do"
              className={cn(inputCls, "py-2.5 resize-none")}
            />
          </Field>

          {d.lane === "waiting" && (
            <Field label="Waiting on" htmlFor="board-waiting">
              <input
                id="board-waiting"
                value={d.waiting_on}
                onChange={e => set("waiting_on", e.target.value)}
                placeholder="Who has the ball?"
                autoComplete="off"
                className={inputCls}
              />
            </Field>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-4 sm:gap-3">
            <Field label="Date" htmlFor="board-date">
              <div className="flex gap-1.5">
                <input
                  id="board-date"
                  type="date"
                  value={d.due_date}
                  onChange={e => set("due_date", e.target.value)}
                  className={cn(inputCls, "min-w-0 [color-scheme:dark]")}
                />
                {d.due_date && (
                  <button
                    type="button"
                    onClick={() => set("due_date", "")}
                    aria-label="Clear date"
                    className="shrink-0 w-11 min-h-[44px] rounded-lg border border-signal-border text-signal-muted flex items-center justify-center"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            </Field>
            <Field label="Time / note" htmlFor="board-note">
              <input
                id="board-note"
                value={d.due_note}
                onChange={e => set("due_note", e.target.value)}
                placeholder="1:30 PM, by 5…"
                autoComplete="off"
                className={inputCls}
              />
            </Field>
          </div>

          <Field label="Tag" htmlFor="board-tag">
            <input
              id="board-tag"
              value={d.tag}
              onChange={e => set("tag", e.target.value)}
              placeholder="Deal, Taxes, Bieber…"
              autoComplete="off"
              className={inputCls}
            />
            <div className="flex flex-wrap gap-1.5 pt-1">
              {BOARD_TAGS.map(t => {
                const on = d.tag.trim().toLowerCase() === t.toLowerCase()
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => set("tag", on ? "" : t)}
                    aria-pressed={on}
                    className={cn(
                      "min-h-[34px] px-2.5 rounded-lg text-[13px] font-semibold border",
                      tagChipClass(t),
                      on ? "border-current" : "border-transparent opacity-80",
                    )}
                  >
                    {t}
                  </button>
                )
              })}
            </div>
          </Field>

          <Field label="Link" htmlFor="board-link">
            <div className="flex gap-1.5">
              <input
                id="board-link"
                type="url"
                inputMode="url"
                value={d.link}
                onChange={e => set("link", e.target.value)}
                placeholder="Drive, Gmail, Mission Control page…"
                autoComplete="off"
                autoCapitalize="off"
                className={cn(inputCls, "min-w-0")}
              />
              {savedLink && (
                <a
                  href={linkHref(savedLink)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 inline-flex items-center gap-1.5 min-h-[44px] px-3 rounded-lg border border-signal-border text-sm font-semibold text-signal-accent"
                >
                  <ExternalLink className="w-4 h-4" /> Open link
                </a>
              )}
            </div>
          </Field>
        </div>

        <div
          className="flex gap-2 px-5 pt-3 border-t border-signal-border"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 12px)" }}
        >
          <button
            type="button"
            onClick={onClose}
            className="flex-1 min-h-[48px] rounded-xl border border-signal-border text-[15px] font-semibold text-signal-muted"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!d.title.trim()}
            className="flex-1 min-h-[48px] rounded-xl bg-signal-accent text-[#06231f] text-[15px] font-bold disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </form>
    </div>
  )
}
