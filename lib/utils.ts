import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Phone display formatter. Our phones live as E.164 (+1xxxxxxxxxx), but
// older data and edge cases (Anonymous, international) may slip in.
// Strategy: strip to digits, take last 10, format US-style; if that
// doesn't yield 10 digits, return the input unchanged so the user sees
// what's there instead of a misleading dash. Returns null when the
// input is null/undefined so call-sites that chain with `||` or `??`
// can fall through to email/etc.
export function formatPhone(p: string | null | undefined): string | null {
  if (!p) return null
  const digits = p.replace(/\D/g, "")
  const last10 = digits.length > 10 ? digits.slice(-10) : digits
  if (last10.length !== 10) return p
  return `(${last10.slice(0, 3)}) ${last10.slice(3, 6)}-${last10.slice(6)}`
}
