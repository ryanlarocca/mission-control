"use client"

import { useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"

interface MemoryEntry {
  date: string
  summary: string
  raw: string
}

const thadiusEntries: MemoryEntry[] = [
  {
    date: "2026-03-31",
    summary: "Fixed Redfin outreach skip-all bug. Contacts with blank N/P columns were reappearing daily because is_eligible() always returned true for Initial status. Added Q-column deferral and --mark-contacted command.",
    raw: `BUG: is_eligible() returned True when N/P cols blank → contacts with Initial status re-queued every run.
FIX: Added Q-column (deferred_until) check in is_eligible(). Added --mark-contacted flag that stamps today's date into the N col and writes "Contacted" to P col without sending.
TESTED: Ran with --dry-run, confirmed eligible list collapsed from 18 → 3 after marking.`,
  },
  {
    date: "2026-03-30",
    summary: "COI outreach v3 deployed. Added --delete, --rename, --set-phone, --set-email, letter variants, name override. SKILL.md updated with correct paths and Before Implementing section.",
    raw: `FEATURES ADDED:
--delete <name>: removes contact row from sheet
--rename <old> <new>: updates Display Name col
--set-phone <name> <phone>: normalizes + writes phone col
--set-email <name> <email>: writes email col
Letter variants: A/B/C message templates per tier, selectable via --variant flag
Name override: --name flag substitutes first name in template
No-contact grouping: contacts with do-not-contact flag grouped at bottom of report
SKILL.md: Updated paths (was pointing to v2 script). Added "Before Implementing" checklist.`,
  },
  {
    date: "2026-03-27",
    summary: "Physiq freeze issue partially resolved. dbOp retry logic added. SW cache cleared. REST migration still pending if retries prove insufficient.",
    raw: `ISSUE: App freezing on heavy DB writes — WebSocket timeout cascading to full UI lock.
PARTIAL FIX: Added dbOp() wrapper with exponential backoff retry (3x, 500/1000/2000ms).
SW CACHE: Cleared stale service worker cache that was serving old broken bundle.
PENDING: If retry insufficient → migrate all db.from() Supabase calls to plain fetch() REST API. Eliminates WebSocket dependency entirely.
NOTE: Timeout confirmation still needed from user test session.`,
  },
  {
    date: "2026-03-20",
    summary: "LRG Homes lead tunnel deployed. ngrok static domain wired to Vercel env. AW-11434036654 conversion tracking confirmed firing on thank-you page.",
    raw: `DEPLOYED: Lead tunnel webhook at /api/lead-notify
NGROK: Static domain configured, launchd plist installed for auto-start.
VERCEL ENV: NGROK_URL and TWILIO vars set in both preview + production.
GA CONVERSION: AW-11434036654/[label] tag fires on /thank-you load. Confirmed via Tag Assistant.
TESTED: Form submit → Twilio SMS to Ryan → Supabase insert → Telegram notify. All legs confirmed.`,
  },
  {
    date: "2026-03-15",
    summary: "Redfin scan v3 shipped. 18 South Bay regions. Firecrawl scraping + Claude Haiku vision scoring. Auto-adds 7.0+ listings to sheet.",
    raw: `REGIONS: 18 South Bay ZIP codes configured in scan config.
SCRAPING: Firecrawl used for JS-rendered page content. Rate limit: 2 req/s with jitter.
SCORING: Claude Haiku vision model analyzes listing photos + description. Outputs 0-10 score.
THRESHOLD: 7.0+ auto-appended to Redfin Fixer Google Sheet (tab: Eligible).
RUNTIME: ~4 min per full scan pass. Runs nightly at 3 AM via launchd.`,
  },
]

const codyEntries: MemoryEntry[] = [
  {
    date: "2026-03-31",
    summary: "Mission Control UI redesign pass v0.1. Added Projects tab (JSON-backed), Memory tab, Skills expandable cards. Redesigned RealEstate pipeline with 5 sub-tabs.",
    raw: `FILES CREATED:
- public/data/projects.json (version tracking)
- public/data/skills.json
- app/(dashboard)/projects/page.tsx
- app/(dashboard)/memory/page.tsx
- components/widgets/ProjectsWidget.tsx
- components/widgets/MemoryWidget.tsx

FILES MODIFIED:
- components/Sidebar.tsx (added Projects + Memory nav items)
- components/widgets/SkillsWidget.tsx (expandable accordion, JSON-backed)
- components/widgets/GoogleAdsWidget.tsx (Today's Summary card, Pause/Resume toggle)
- components/widgets/DocumentsWidget.tsx (File Browser coming soon callout)
- components/widgets/PhysiqWidget.tsx (added Workout Log section)`,
  },
  {
    date: "2026-03-28",
    summary: "Built Mission Control skeleton. Next.js 14, Tailwind, shadcn/ui, zinc dark theme. All 13 routes scaffolded with mock data.",
    raw: `STACK: Next.js 14 (App Router), Tailwind CSS, shadcn/ui, TypeScript.
THEME: zinc-950 background, zinc-900 cards, zinc-800 borders. Green pulse indicator in sidebar header.
ROUTES: /chat, /terminal, /agents, /macmini, /pipeline, /redfin, /physiq, /social, /ads, /stocks, /documents, /skills, /calendar.
SIDEBAR: Grouped nav with 5 sections. Active state via pathname match.
MOCK DATA: All widgets populated with realistic mock entries. No Supabase wiring yet.`,
  },
  {
    date: "2026-03-27",
    summary: "Physiq API: fixed macro calculation bug in Sonnet model. dbOp retry wrapper added to prevent WebSocket freeze on heavy DB writes.",
    raw: `MACRO BUG: Protein calc was using carb multiplier (4→4 OK, but fat was 4 not 9). Fixed in macro_calc() function.
RETRY WRAPPER: dbOp(fn, retries=3) wraps all Supabase calls. Exponential backoff: 500/1000/2000ms.
MODEL: Switched macro parsing from GPT-3.5 to Claude Sonnet — better accuracy on edge cases (e.g. "2 scoops whey").`,
  },
  {
    date: "2026-03-26",
    summary: "Agent email draft_batch.py v2. DNS MX validation, bounce cleanup, 50 drafts/run. Offset tracking for resumable batches.",
    raw: `FEATURES:
- DNS MX validation before drafting (skip unresolvable domains)
- Bounce cleanup: reads Gmail bounce labels, marks sheet rows as bounced
- 50 drafts per run (configurable via --limit)
- Offset tracking: --offset arg + last_offset.txt for resumable batches
- Draft subject lines now include property address for context
TESTED: 50 drafts created in Gmail drafts folder. MX check filtered out 3 bad domains.`,
  },
  {
    date: "2026-03-25",
    summary: "Redfin scan scoring refactor. 3x interior weight multiplier. Exclusion list for new construction keywords. Score threshold 7.0 for High Priority.",
    raw: `SCORING REFACTOR:
- Interior condition photos weighted 3x vs exterior
- Exclusion keywords: "new construction", "builder grade", "never lived in" → score capped at 6.0
- Threshold: 7.0+ = High Priority (auto-add to sheet), 5.0-6.9 = Watch, <5.0 = Skip
- Added "price per sqft vs neighborhood median" as scoring factor (underpriced = +1 point)
TESTED: Re-scored 40 historical listings. High Priority recall improved from 71% → 89%.`,
  },
]

function MemoryCard({ entry }: { entry: MemoryEntry }) {
  const [showRaw, setShowRaw] = useState(false)

  return (
    <div className="flex gap-2.5">
      {/* Timeline spine */}
      <div className="flex flex-col items-center pt-[5px] shrink-0">
        <div className="w-1 h-1 rounded-full bg-zinc-700" />
        <div className="w-px flex-1 bg-zinc-800/70 mt-1" />
      </div>

      {/* Content */}
      <div className="pb-3.5 flex-1 min-w-0">
        <p className="text-[9px] font-mono text-zinc-600 mb-0.5 tracking-wide">{entry.date}</p>
        <p className="text-[11px] text-zinc-500 leading-[1.5] tracking-wide">{entry.summary}</p>
        <button
          onClick={() => setShowRaw(!showRaw)}
          className="flex items-center gap-0.5 text-[9px] text-zinc-700 hover:text-zinc-500 transition-colors mt-1.5 tracking-wide"
        >
          {showRaw ? <ChevronDown className="w-2.5 h-2.5" /> : <ChevronRight className="w-2.5 h-2.5" />}
          {showRaw ? "hide" : "raw"}
        </button>
        {showRaw && (
          <div className="mt-1.5 bg-zinc-900/60 border border-zinc-800/60 rounded px-2.5 py-2">
            <pre className="text-[9px] text-zinc-600 font-mono leading-relaxed whitespace-pre-wrap">{entry.raw}</pre>
          </div>
        )}
      </div>
    </div>
  )
}

export default function MemoryWidget() {
  const [activeTab, setActiveTab] = useState<"thadius" | "cody">("thadius")

  const entries = activeTab === "thadius" ? thadiusEntries : codyEntries

  return (
    <div>
      {/* Header */}
      <div className="mb-5">
        <h1 className="text-lg font-semibold text-zinc-100">Memory</h1>
        <p className="text-xs text-zinc-500 mt-0.5">Session logs and key decisions per agent</p>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-lg p-1 w-fit mb-5">
        <button
          onClick={() => setActiveTab("thadius")}
          className={`px-3 py-1.5 rounded text-xs transition-colors ${
            activeTab === "thadius"
              ? "bg-amber-500/20 text-amber-400"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          Thadius
        </button>
        <button
          onClick={() => setActiveTab("cody")}
          className={`px-3 py-1.5 rounded text-xs transition-colors ${
            activeTab === "cody"
              ? "bg-blue-500/20 text-blue-400"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          Cody
        </button>
      </div>

      {/* Entries */}
      <div>
        {entries.map((entry, i) => (
          <MemoryCard key={i} entry={entry} />
        ))}
      </div>
    </div>
  )
}
