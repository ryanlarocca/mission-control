"use client"

import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

// Small shared primitives for The Board. Everything is sized for one-thumb
// phone use: min 44px tap targets, big numerals, quota chips that flip green.

export function Chip({ n, target, label }: { n: number; target: number; label: string }) {
  const met = n >= target
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-mono text-xs font-semibold whitespace-nowrap",
        met
          ? "bg-green-500/15 text-green-400 border border-green-500/30"
          : "bg-zinc-800 text-zinc-300 border border-zinc-700"
      )}
    >
      {n}/{target} {label}
    </span>
  )
}

export function SectionCard({
  title,
  accent,
  chip,
  children,
}: {
  title: string
  accent: string // tailwind border-t color class
  chip?: ReactNode
  children: ReactNode
}) {
  return (
    <div className={cn("rounded-xl border border-zinc-800 border-t-2 bg-zinc-900/60 p-4", accent)}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-400">{title}</h2>
        <div className="flex flex-wrap justify-end gap-1.5">{chip}</div>
      </div>
      {children}
    </div>
  )
}

export function TapButton({
  onClick,
  disabled,
  children,
  variant = "solid",
  className,
}: {
  onClick: () => void
  disabled?: boolean
  children: ReactNode
  variant?: "solid" | "ghost" | "primary"
  className?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "min-h-11 rounded-lg px-3 text-sm font-medium transition-colors active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none",
        variant === "solid" && "bg-zinc-800 text-zinc-100 hover:bg-zinc-700",
        variant === "ghost" && "border border-zinc-700 text-zinc-300 hover:bg-zinc-800/60",
        variant === "primary" && "bg-zinc-100 text-zinc-900 hover:bg-white",
        className
      )}
    >
      {children}
    </button>
  )
}

export function Stepper({
  label,
  value,
  onChange,
  min,
  max,
  format,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  format?: (v: number) => string
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">{label}</span>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => onChange(Math.max(min, value - 1))}
          disabled={value <= min}
          aria-label={`decrease ${label}`}
          className="h-10 w-10 rounded-lg border border-zinc-700 text-lg text-zinc-300 hover:bg-zinc-800 active:scale-95 disabled:opacity-30"
        >
          −
        </button>
        <span className="min-w-12 text-center font-mono text-xl font-semibold text-zinc-100">
          {format ? format(value) : value}
        </span>
        <button
          onClick={() => onChange(Math.min(max, value + 1))}
          disabled={value >= max}
          aria-label={`increase ${label}`}
          className="h-10 w-10 rounded-lg border border-zinc-700 text-lg text-zinc-300 hover:bg-zinc-800 active:scale-95 disabled:opacity-30"
        >
          +
        </button>
      </div>
    </div>
  )
}

export function StatRow({
  label,
  value,
  target,
}: {
  label: string
  value: ReactNode
  target?: number | string
}) {
  const met =
    target !== undefined &&
    typeof value === "number" &&
    typeof target === "number" &&
    value >= target
  return (
    <div className="flex items-baseline justify-between border-b border-dashed border-zinc-800 py-2 last:border-0">
      <span className="text-sm text-zinc-400">{label}</span>
      <span className={cn("font-mono text-sm font-semibold", met ? "text-green-400" : "text-zinc-100")}>
        {value}
        {target !== undefined && <span className="text-zinc-500"> / {target}</span>}
      </span>
    </div>
  )
}
