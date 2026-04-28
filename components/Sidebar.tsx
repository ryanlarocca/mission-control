"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import {
  Home, Activity, Calendar, MessageSquare, Terminal, Bot, Monitor,
  FileText, Zap, BarChart2, TrendingUp, Search, Dumbbell, FolderKanban,
  Brain, Menu, X, Bug, Users, Phone,
} from "lucide-react"

const navGroups = [
  {
    label: "Command",
    items: [
      { href: "/chat", label: "Chat", icon: MessageSquare },
      { href: "/terminal", label: "Terminal", icon: Terminal },
      { href: "/agents", label: "Agents", icon: Bot },
      { href: "/macmini", label: "Mac Mini", icon: Monitor },
    ],
  },
  {
    label: "Real Estate",
    items: [
      { href: "/pipeline", label: "Pipeline", icon: Home },
      { href: "/relationships", label: "Relationships", icon: Users },
      { href: "/leads", label: "Leads", icon: Phone },
      { href: "/redfin", label: "Redfin Search", icon: Search },
    ],
  },
  {
    label: "Physiq",
    items: [
      { href: "/physiq", label: "Portal", icon: Dumbbell },
      { href: "/social", label: "Social", icon: Activity },
    ],
  },
  {
    label: "Business",
    items: [
      { href: "/ads", label: "Google Ads", icon: BarChart2 },
      { href: "/stocks", label: "Stocks", icon: TrendingUp },
    ],
  },
  {
    label: "Resources",
    items: [
      { href: "/documents", label: "Documents", icon: FileText },
      { href: "/skills", label: "Skills", icon: Zap },
      { href: "/calendar", label: "Calendar", icon: Calendar },
      { href: "/projects", label: "Projects", icon: FolderKanban },
      { href: "/memory", label: "Memory", icon: Brain },
      { href: "/bugs", label: "Bugs", icon: Bug },
    ],
  },
]

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()
  return (
    <nav className="flex-1 py-3 px-2 flex flex-col gap-4 overflow-y-auto">
      {navGroups.map(group => (
        <div key={group.label}>
          <p className="text-[10px] font-semibold text-zinc-600 uppercase tracking-widest px-3 mb-1">
            {group.label}
          </p>
          <div className="flex flex-col gap-0.5">
            {group.items.map(({ href, label, icon: Icon }) => {
              const active = pathname === href || pathname.startsWith(href + "/")
              return (
                <Link
                  key={href}
                  href={href}
                  onClick={onNavigate}
                  className={cn(
                    "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors",
                    active
                      ? "bg-zinc-800 text-zinc-100"
                      : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50"
                  )}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  {label}
                </Link>
              )
            })}
          </div>
        </div>
      ))}
    </nav>
  )
}

// Desktop sidebar — hidden on mobile
export function Sidebar() {
  return (
    <aside className="hidden md:flex w-56 shrink-0 border-r border-zinc-800 bg-zinc-950 flex-col h-screen sticky top-0">
      <div className="px-4 py-4 border-b border-zinc-800 flex items-center gap-2.5">
        <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
        <span className="text-sm font-semibold text-zinc-100 tracking-tight">Mission Control</span>
      </div>
      <NavItems />
      <div className="px-4 py-3 border-t border-zinc-800">
        <p className="text-xs text-zinc-600">
          {new Date().toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}
        </p>
      </div>
    </aside>
  )
}

// Mobile top bar + slide-out drawer
export function MobileNav() {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()

  const allItems = navGroups.flatMap(g => g.items)
  const current = allItems.find(i => pathname === i.href || pathname.startsWith(i.href + "/"))

  return (
    <>
      {/* Top bar */}
      <header className="md:hidden flex items-center justify-between px-4 py-3 border-b border-zinc-800 bg-zinc-950 sticky top-0 z-40">
        <div className="flex items-center gap-2.5">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span className="text-sm font-semibold text-zinc-100 tracking-tight">
            {current?.label ?? "Mission Control"}
          </span>
        </div>
        <button
          onClick={() => setOpen(true)}
          className="p-2 -mr-2 text-zinc-400 hover:text-zinc-100 transition-colors"
          aria-label="Open menu"
        >
          <Menu className="w-5 h-5" />
        </button>
      </header>

      {/* Backdrop */}
      {open && (
        <div
          className="md:hidden fixed inset-0 bg-black/60 z-50"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Drawer */}
      <div className={cn(
        "md:hidden fixed top-0 right-0 h-full w-72 bg-zinc-950 border-l border-zinc-800 z-50 flex flex-col transition-transform duration-200",
        open ? "translate-x-0" : "translate-x-full"
      )}>
        <div className="flex items-center justify-between px-4 py-4 border-b border-zinc-800">
          <span className="text-sm font-semibold text-zinc-100">Navigation</span>
          <button
            onClick={() => setOpen(false)}
            className="p-1.5 text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <NavItems onNavigate={() => setOpen(false)} />
      </div>
    </>
  )
}
