"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import {
  Home, Phone, Users, Megaphone, Zap, Gauge, Folder, Lightbulb, Dumbbell, MoreHorizontal, X,
  type LucideIcon,
} from "lucide-react"

// Mission Control 2.0 navigation (2026-11-10, approved "Signal" mockup).
//   Desktop (md+): 220 px left sidebar, three groups.
//   Phone: fixed bottom tab bar — Today · Leads · People · Campaigns · More,
//   "More" opens a sheet with the rest.
// Retired from every menu (still reachable by URL): /board, /deal-flow.
// /leads-embed, /offer and /login live outside the (dashboard) group, so
// none of this renders there.

type NavItem = { href: string; label: string; icon: LucideIcon }

const navGroups: { label: string; items: NavItem[] }[] = [
  { label: "Daily", items: [{ href: "/today", label: "Today", icon: Home }] },
  {
    label: "Real estate",
    items: [
      { href: "/leads", label: "Leads", icon: Phone },
      { href: "/relationships", label: "Relationships", icon: Users },
      { href: "/campaigns", label: "Campaigns", icon: Megaphone },
      { href: "/email-campaign", label: "Email Drip", icon: Zap },
      { href: "/cycle", label: "Market Cycle", icon: Gauge },
    ],
  },
  {
    label: "Ops",
    items: [
      { href: "/projects", label: "Projects", icon: Folder },
      { href: "/hopper", label: "The Hopper", icon: Lightbulb },
    ],
  },
]

const tabs: NavItem[] = [
  { href: "/today", label: "Today", icon: Home },
  { href: "/leads", label: "Leads", icon: Phone },
  { href: "/relationships", label: "People", icon: Users },
  { href: "/campaigns", label: "Campaigns", icon: Megaphone },
]

const moreItems: NavItem[] = [
  { href: "/email-campaign", label: "Email Drip", icon: Zap },
  { href: "/cycle", label: "Market Cycle", icon: Gauge },
  { href: "/projects", label: "Projects", icon: Folder },
  { href: "/hopper", label: "The Hopper", icon: Lightbulb },
  { href: "/physiq/gym-tracker", label: "Gym tracker", icon: Dumbbell },
]

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/")
}

function todayLabel(): string {
  return new Date().toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", year: "numeric",
  })
}

// Desktop sidebar — hidden below md.
export function Sidebar() {
  const pathname = usePathname() ?? ""
  return (
    <aside className="hidden md:flex w-[220px] shrink-0 border-r border-signal-border bg-signal-bg flex-col h-screen sticky top-0 px-3 py-[18px]">
      <div className="flex items-center gap-2 px-2.5 pt-1 pb-[18px]">
        <span className="w-2 h-2 rounded-full bg-signal-accent shrink-0" />
        <span className="text-sm font-bold text-signal-ink truncate">Mission Control</span>
      </div>
      <nav className="flex-1 overflow-y-auto flex flex-col gap-0.5">
        {navGroups.map(group => (
          <div key={group.label} className="flex flex-col gap-0.5">
            <p className="text-[10px] uppercase tracking-[0.1em] text-signal-muted/70 px-2.5 pt-3.5 pb-1">
              {group.label}
            </p>
            {group.items.map(({ href, label, icon: Icon }) => {
              const active = isActive(pathname, href)
              return (
                <Link
                  key={href}
                  href={href}
                  className={cn(
                    "flex items-center gap-2.5 px-2.5 py-2 text-[13px] border-l-2 transition-colors",
                    active
                      ? "bg-signal-card text-signal-ink border-signal-accent rounded-r-lg"
                      : "text-signal-muted border-transparent rounded-lg hover:text-signal-ink hover:bg-signal-card/60",
                  )}
                >
                  <Icon className={cn("w-4 h-4 shrink-0", active && "text-signal-accent")} />
                  <span className="truncate">{label}</span>
                </Link>
              )
            })}
          </div>
        ))}
      </nav>
      <p className="mt-auto px-2.5 pt-2.5 text-[11px] text-signal-muted" suppressHydrationWarning>
        {todayLabel()}
      </p>
    </aside>
  )
}

// Phone bottom tab bar + "More" sheet — hidden at md and up.
export function TabBar() {
  const pathname = usePathname() ?? ""
  const [open, setOpen] = useState(false)

  // Close the sheet whenever the route changes (and on Escape).
  useEffect(() => { setOpen(false) }, [pathname])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  const moreActive = moreItems.some(i => isActive(pathname, i.href))

  return (
    <>
      <nav
        className="md:hidden fixed inset-x-0 bottom-0 z-40 border-t border-signal-border bg-signal-bg"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        aria-label="Main"
      >
        <div className="flex items-stretch justify-around px-2 pt-1.5 pb-1">
          {tabs.map(({ href, label, icon: Icon }) => {
            const active = isActive(pathname, href)
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex-1 min-w-0 min-h-[52px] flex flex-col items-center justify-center gap-1 text-[10px] font-semibold",
                  active ? "text-signal-accent" : "text-signal-muted",
                )}
              >
                <Icon className="w-[22px] h-[22px]" />
                <span className="truncate">{label}</span>
              </Link>
            )
          })}
          <button
            type="button"
            onClick={() => setOpen(v => !v)}
            aria-expanded={open}
            aria-haspopup="dialog"
            className={cn(
              "flex-1 min-w-0 min-h-[52px] flex flex-col items-center justify-center gap-1 text-[10px] font-semibold",
              open || moreActive ? "text-signal-accent" : "text-signal-muted",
            )}
          >
            <MoreHorizontal className="w-[22px] h-[22px]" />
            <span>More</span>
          </button>
        </div>
      </nav>

      {open && (
        <div className="md:hidden fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="More">
          <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} data-testid="more-backdrop" />
          <div
            className="absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-signal-border bg-signal-card"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 8px)" }}
          >
            <div className="flex items-center justify-between pl-5 pr-2 pt-2">
              <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-signal-muted">More</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="w-11 h-11 flex items-center justify-center text-signal-muted hover:text-signal-ink shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-2 pb-2 flex flex-col">
              {moreItems.map(({ href, label, icon: Icon }) => {
                const active = isActive(pathname, href)
                return (
                  <Link
                    key={href}
                    href={href}
                    onClick={() => setOpen(false)}
                    className={cn(
                      "flex items-center gap-3 px-3 min-h-[48px] text-[15px] border-l-2",
                      active
                        ? "bg-signal-card2 text-signal-ink border-signal-accent rounded-r-lg"
                        : "text-signal-ink/90 border-transparent rounded-lg active:bg-signal-card2",
                    )}
                  >
                    <Icon className={cn("w-5 h-5 shrink-0", active ? "text-signal-accent" : "text-signal-muted")} />
                    <span className="truncate">{label}</span>
                  </Link>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
