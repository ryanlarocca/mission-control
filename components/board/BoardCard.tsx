"use client"

import type { KeyboardEvent } from "react"
import { Check, ExternalLink } from "lucide-react"
import { cn } from "@/lib/utils"
import { dueLabel, type BoardItem } from "@/lib/boardItems"
import { doneLabel, dueChipClass, linkHref, tagChipClass } from "./boardUi"

/** idle = normal · checked = circle filled, card dimmed · collapsing = fading out + height → 0. */
export type CardPhase = "idle" | "checked" | "collapsing"

type Props = {
  item: BoardItem
  today: string
  phase: CardPhase
  fresh: boolean
  onToggle: (item: BoardItem) => void
  onOpen: (item: BoardItem) => void
}

// One row. Phone: a Reminders-style row with a hairline under it. md+: a
// boxed card. The outer grid wrapper animates grid-template-rows 1fr → 0fr so
// the cards below slide up smoothly when this one leaves.
export function BoardCard({ item, today, phase, fresh, onToggle, onOpen }: Props) {
  // Mid-animation the server may already say "done"; keep the open look until it has left.
  const isDone = item.status === "done" && phase === "idle"
  const checked = isDone || phase !== "idle"
  const leaving = phase === "collapsing"

  const dateText = isDone ? doneLabel(item.done_at, today) : dueLabel(item.due_date, item.due_note, today)
  const dateClass = isDone ? "bg-signal-card2 text-signal-muted" : dueChipClass(item, today)
  const waitingOn = !isDone && item.lane === "waiting" && item.waiting_on ? item.waiting_on : null

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      onOpen(item)
    }
  }

  return (
    <div
      className="board-collapse grid"
      style={{ gridTemplateRows: leaving ? "0fr" : "1fr", opacity: leaving ? 0 : 1 }}
      aria-hidden={leaving || undefined}
    >
      <div className="min-h-0 overflow-hidden">
        <div className={cn("md:pb-2", fresh && "board-in")}>
          <div
            className={cn(
              "flex gap-3 md:gap-[11px] py-3 px-0.5 border-b border-signal-border",
              "md:px-2.5 md:py-[11px] md:rounded-xl md:border",
              isDone ? "md:bg-transparent md:border-dashed" : "md:bg-signal-card",
            )}
          >
            <button
              type="button"
              onClick={() => onToggle(item)}
              disabled={leaving}
              aria-label={isDone ? `Reopen: ${item.title}` : `Mark done: ${item.title}`}
              aria-pressed={checked}
              className="shrink-0 self-start -m-[10px] p-[10px] md:mt-[-9px] rounded-full touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-signal-accent/60"
            >
              <span
                key={checked ? "on" : "off"}
                className={cn(
                  "flex items-center justify-center w-[23px] h-[23px] md:w-[21px] md:h-[21px] rounded-full border-2 transition-colors duration-150",
                  checked ? "bg-signal-accent border-signal-accent" : "border-[#3a4a6b] active:border-signal-accent/70",
                  checked && !isDone && "board-pop",
                )}
              >
                {checked && <Check className="w-[14px] h-[14px] md:w-[13px] md:h-[13px] text-[#06231f]" strokeWidth={3.5} />}
              </span>
            </button>

            <div
              role="button"
              tabIndex={0}
              onClick={() => onOpen(item)}
              onKeyDown={onKey}
              className={cn(
                "board-dim min-w-0 flex-1 cursor-pointer rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-signal-accent/40",
                phase !== "idle" && "opacity-[.45]",
              )}
            >
              <div
                className={cn(
                  "text-base md:text-[14.5px] leading-[1.3] break-words",
                  isDone ? "text-signal-muted font-medium" : "text-signal-ink font-semibold",
                  phase !== "idle" && "line-through decoration-signal-accent decoration-2",
                )}
              >
                {item.title}
              </div>
              {!isDone && item.next_step && (
                <div className="mt-[3px] text-sm md:text-[13px] leading-[1.35] text-signal-muted break-words line-clamp-2">
                  {item.next_step}
                </div>
              )}
              {(dateText || item.tag || waitingOn) && (
                <div className="mt-[7px] flex flex-wrap items-center gap-1.5">
                  {dateText && (
                    <span className={cn("rounded-md px-[7px] py-0.5 text-[12.5px] md:text-[11.5px] font-semibold", dateClass)}>
                      {dateText}
                    </span>
                  )}
                  {item.tag && !isDone && (
                    <span className={cn("rounded-md px-[7px] py-0.5 text-[12.5px] md:text-[11.5px] font-semibold", tagChipClass(item.tag))}>
                      {item.tag}
                    </span>
                  )}
                  {waitingOn && (
                    <span className="text-[12.5px] md:text-[11.5px] text-signal-muted truncate max-w-full">
                      Waiting on: {waitingOn}
                    </span>
                  )}
                </div>
              )}
            </div>

            {item.link && (
              <a
                href={linkHref(item.link)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                aria-label={`Open link for ${item.title}`}
                className="shrink-0 self-start -m-[10px] p-[10px] md:mt-[-8px] text-signal-muted hover:text-signal-ink active:text-signal-accent"
              >
                <ExternalLink className="w-[17px] h-[17px] md:w-[15px] md:h-[15px]" />
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
