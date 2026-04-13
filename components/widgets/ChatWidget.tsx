"use client"

import { useEffect, useRef, useState } from "react"
import { Send, Hash, ChevronDown } from "lucide-react"
import type { ChatMessage } from "@/types"

// ── Thread definitions ────────────────────────────────────────────────────────

type ThreadId = "thadius-physiq" | "thadius-lrg" | "cody" | "group"

interface Thread {
  id: ThreadId
  label: string
  subtitle: string
  dot: string
  replyAgent: "thadius" | "cody"
  history: ChatMessage[]
}

const threadDefs: Thread[] = [
  {
    id: "thadius-physiq",
    label: "physiq",
    subtitle: "Physiq app & social engine",
    dot: "bg-amber-400",
    replyAgent: "thadius",
    history: [
      { id: "tp1", from: "thadius", text: "Physiq freeze is confirmed fixed as of this morning. Cody migrated all db.from() calls to plain REST — WebSocket dependency eliminated.", timestamp: "11:48 AM" },
      { id: "tp2", from: "ryan", text: "Yeah finally. What's left on physiq?", timestamp: "11:52 AM" },
      { id: "tp3", from: "thadius", text: "Two things open: (1) Google Ads call conversion tracking — you got a call off the ads and wanted to set it up. (2) The Mission Control Physiq portal could be wired to real Supabase data instead of mock entries.", timestamp: "11:53 AM" },
      { id: "tp4", from: "ryan", text: "Let's do the Google Ads conversion after Mission Control is sorted.", timestamp: "11:54 AM" },
      { id: "tp5", from: "thadius", text: "Noted. I'll hold that until you're ready. Social engine spec is also sitting in PHASE_2_SIMPLE_WORKFLOW.md whenever you want to pick it up — script generator → Sora → approval dashboard → auto-post.", timestamp: "11:54 AM" },
    ],
  },
  {
    id: "thadius-lrg",
    label: "lrg-homes",
    subtitle: "Real estate ops & outreach",
    dot: "bg-amber-400",
    replyAgent: "thadius",
    history: [
      { id: "tl1", from: "thadius", text: "Morning briefing: Redfin scan complete — 3 new listings flagged. Balcones Dr scored 9.1, highest this month. Offer in review.", timestamp: "9:30 AM" },
      { id: "tl2", from: "ryan", text: "Any movement on the Maple Grove showing?", timestamp: "9:44 AM" },
      { id: "tl3", from: "thadius", text: "Showing scheduled, no update yet. Jennifer Park replied to outreach — she's the Redfin agent on that listing. Moved to 'meeting' status.", timestamp: "9:45 AM" },
      { id: "tl4", from: "ryan", text: "Good. Hold COI batch until after lunch.", timestamp: "9:47 AM" },
      { id: "tl5", from: "thadius", text: "Held. 12 contacts queued for this afternoon — A-tier priority. Lead funnel is green: 2 overnight leads, one call scheduled Thursday.", timestamp: "9:47 AM" },
      { id: "tl6", from: "ryan", text: "What about the Google Ads campaigns?", timestamp: "10:05 AM" },
      { id: "tl7", from: "thadius", text: "Search campaign: $38 spent of $50 daily, 3 conversions. Call Ads: $22 spent, 2 phone calls. Retargeting is still paused — you never reactivated it after the GTM setup last week.", timestamp: "10:06 AM" },
    ],
  },
  {
    id: "cody",
    label: "Cody",
    subtitle: "Engineering & Deployment",
    dot: "bg-blue-400",
    replyAgent: "cody",
    history: [
      { id: "c1", from: "ryan", text: "Cody, take the physiq project and fix the freeze issue. Users are getting stuck after the screen turns off.", timestamp: "10:14 AM" },
      { id: "c2", from: "cody", text: "On it. Pulling the repo now.", timestamp: "10:14 AM" },
      { id: "c3", from: "cody", text: "Found it. All db.from() calls go through the Supabase JS client WebSocket. iOS kills that connection when the screen goes off — every query hangs on wake. Replacing with plain REST via sbFetch.", timestamp: "10:22 AM" },
      { id: "c4", from: "ryan", text: "How long?", timestamp: "10:23 AM" },
      { id: "c5", from: "cody", text: "Test suite running now. I'll confirm it works before touching any app code.", timestamp: "10:24 AM" },
      { id: "c6", from: "cody", text: "9/9 tests passed. Migrating all call sites now.", timestamp: "10:31 AM" },
      { id: "c7", from: "cody", text: "Done. SW bumped to v5, deployed to GitHub Pages. 26 sbFetch references confirmed live.", timestamp: "10:33 AM" },
      { id: "c8", from: "ryan", text: "freeze seems fixed finally", timestamp: "11:47 AM" },
      { id: "c9", from: "cody", text: "WebSocket was the culprit the whole time. HTTP is stateless — iOS can't kill it by sleeping.", timestamp: "11:48 AM" },
    ],
  },
  {
    id: "group",
    label: "Group",
    subtitle: "Thadius · Cody",
    dot: "bg-zinc-500",
    replyAgent: "thadius",
    history: [
      { id: "g1", from: "ryan", text: "Hey team — physiq freeze is confirmed fixed. Good work Cody.", timestamp: "11:49 AM" },
      { id: "g2", from: "thadius", text: "I'll update project memory and close out the freeze issue.", timestamp: "11:50 AM" },
      { id: "g3", from: "cody", text: "Next up if you want: wire the Physiq portal in Mission Control to real Supabase data.", timestamp: "11:50 AM" },
      { id: "g4", from: "thadius", text: "Also pending: Google Ads phone call conversion. Ryan got a call off the ads and wanted to track it.", timestamp: "11:51 AM" },
      { id: "g5", from: "ryan", text: "Yeah let's get to that. But first let's finish Mission Control.", timestamp: "11:52 AM" },
      { id: "g6", from: "cody", text: "On it.", timestamp: "11:52 AM" },
      { id: "g7", from: "thadius", text: "I'll monitor the COI batch while you two work on the dashboard.", timestamp: "11:52 AM" },
    ],
  },
]

// ── Styling ───────────────────────────────────────────────────────────────────

const agentStyle: Record<string, { bubble: string; label: string; dot: string }> = {
  thadius: { bubble: "bg-amber-500/10 border border-amber-500/20 text-zinc-100", label: "text-amber-400", dot: "bg-amber-400" },
  cody:    { bubble: "bg-blue-500/10 border border-blue-500/20 text-zinc-100",   label: "text-blue-400",  dot: "bg-blue-400"  },
  ryan:    { bubble: "bg-zinc-700/60 border border-zinc-600/40 text-zinc-100",   label: "text-zinc-400",  dot: "bg-zinc-400"  },
}
const agentName: Record<string, string> = { thadius: "Thadius", cody: "Cody", ryan: "Ryan" }

// ── Sub-components ────────────────────────────────────────────────────────────

function TypingIndicator({ agent }: { agent: "thadius" | "cody" }) {
  const s = agentStyle[agent]
  return (
    <div className="flex items-start gap-2.5 mb-3">
      <span className={`w-1.5 h-1.5 rounded-full mt-2 shrink-0 ${s.dot}`} />
      <div className="flex flex-col gap-1">
        <span className={`text-xs font-medium ${s.label}`}>{agentName[agent]}</span>
        <div className={`px-3 py-2 rounded-lg ${s.bubble}`}>
          <span className="flex gap-1 items-center h-4">
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce [animation-delay:0ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce [animation-delay:150ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce [animation-delay:300ms]" />
          </span>
        </div>
      </div>
    </div>
  )
}

function Bubble({ message, isNew }: { message: ChatMessage; isNew?: boolean }) {
  const s = agentStyle[message.from]
  const isRyan = message.from === "ryan"
  const [displayed, setDisplayed] = useState(isNew ? "" : message.text)

  useEffect(() => {
    if (!isNew) return
    let i = 0
    const iv = setInterval(() => {
      i++
      setDisplayed(message.text.slice(0, i))
      if (i >= message.text.length) clearInterval(iv)
    }, 16)
    return () => clearInterval(iv)
  }, [isNew, message.text])

  return (
    <div className={`flex items-start gap-2.5 mb-3 ${isRyan ? "flex-row-reverse" : ""}`}>
      <span className={`w-1.5 h-1.5 rounded-full mt-2 shrink-0 ${s.dot}`} />
      <div className={`flex flex-col gap-1 max-w-[78%] ${isRyan ? "items-end" : ""}`}>
        <div className="flex items-center gap-2">
          <span className={`text-xs font-medium ${s.label}`}>{agentName[message.from]}</span>
          <span className="text-xs text-zinc-600">{message.timestamp}</span>
        </div>
        <div className={`px-3 py-2 rounded-lg text-sm leading-relaxed ${s.bubble}`}>
          {displayed}
          {isNew && displayed.length < message.text.length && (
            <span className="inline-block w-0.5 h-3.5 bg-zinc-400 ml-0.5 animate-pulse align-middle" />
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

const autoReplies: Record<ThreadId, string> = {
  "thadius-physiq": "Got it — I'll keep that on my radar and loop in Cody if needed.",
  "thadius-lrg":    "Noted. I'll update the pipeline and let you know if anything changes.",
  "cody":           "On it. I'll report back when it's done.",
  "group":          "Heard. Cody and I will coordinate on that.",
}

export function ChatWidget() {
  const [activeId, setActiveId] = useState<ThreadId>("thadius-lrg")
  const [thadiusOpen, setThadiusOpen] = useState(true)
  const [messages, setMessages] = useState<Record<ThreadId, ChatMessage[]>>(
    Object.fromEntries(threadDefs.map(t => [t.id, t.history])) as Record<ThreadId, ChatMessage[]>
  )
  const [typing, setTyping] = useState<"thadius" | "cody" | null>(null)
  const [newIds, setNewIds] = useState<Set<string>>(new Set())
  const [input, setInput] = useState("")
  const bottomRef = useRef<HTMLDivElement>(null)

  const activeThread = threadDefs.find(t => t.id === activeId)!
  const currentMessages = messages[activeId]

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [currentMessages, typing, activeId])

  function handleSend() {
    if (!input.trim()) return
    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      from: "ryan",
      text: input.trim(),
      timestamp: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    }
    setMessages(prev => ({ ...prev, [activeId]: [...prev[activeId], userMsg] }))
    setInput("")

    const agent = activeThread.replyAgent
    setTimeout(() => setTyping(agent), 700)
    setTimeout(() => {
      setTyping(null)
      const reply: ChatMessage = {
        id: (Date.now() + 1).toString(),
        from: agent,
        text: autoReplies[activeId],
        timestamp: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      }
      setNewIds(prev => new Set(prev).add(reply.id))
      setMessages(prev => ({ ...prev, [activeId]: [...prev[activeId], reply] }))
    }, 2500)
  }

  const thadiusThreads = threadDefs.filter(t => t.id.startsWith("thadius"))
  const otherThreads   = threadDefs.filter(t => !t.id.startsWith("thadius"))

  return (
    <div className="flex h-[calc(100vh-140px)] bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">

      {/* ── Sidebar ── */}
      <div className="w-52 shrink-0 border-r border-zinc-800 flex flex-col bg-zinc-950/60">
        <div className="px-3 py-3 border-b border-zinc-800">
          <p className="text-xs font-semibold text-zinc-600 uppercase tracking-widest">Messages</p>
        </div>

        <nav className="flex-1 overflow-y-auto py-2">

          {/* Thadius group */}
          <button
            onClick={() => setThadiusOpen(p => !p)}
            className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left hover:bg-zinc-800/40 transition-colors group"
          >
            <ChevronDown className={`w-3 h-3 text-zinc-600 transition-transform ${thadiusOpen ? "" : "-rotate-90"}`} />
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
            <span className="text-xs font-semibold text-zinc-400 group-hover:text-zinc-300">Thadius</span>
          </button>

          {thadiusOpen && thadiusThreads.map(t => (
            <button
              key={t.id}
              onClick={() => setActiveId(t.id)}
              className={`w-full flex items-center gap-2 pl-7 pr-3 py-1.5 text-left transition-colors ${
                activeId === t.id ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/40"
              }`}
            >
              <Hash className="w-3 h-3 shrink-0 opacity-60" />
              <span className="text-sm truncate">{t.label}</span>
            </button>
          ))}

          {/* Divider */}
          <div className="mx-3 my-2 border-t border-zinc-800" />

          {/* Cody + Group */}
          {otherThreads.map(t => (
            <button
              key={t.id}
              onClick={() => setActiveId(t.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                activeId === t.id ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800/40"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${t.dot}`} />
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{t.label}</p>
                <p className="text-xs text-zinc-600 truncate">{t.subtitle}</p>
              </div>
            </button>
          ))}
        </nav>
      </div>

      {/* ── Chat area ── */}
      <div className="flex-1 flex flex-col min-w-0">

        {/* Header */}
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2.5">
          {activeId.startsWith("thadius") ? (
            <Hash className="w-4 h-4 text-zinc-500" />
          ) : (
            <span className={`w-2 h-2 rounded-full ${activeThread.dot}`} />
          )}
          <div>
            <p className="text-sm font-semibold text-zinc-100">
              {activeId.startsWith("thadius") ? `Thadius / ${activeThread.label}` : activeThread.label}
            </p>
            <p className="text-xs text-zinc-500">{activeThread.subtitle}</p>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {currentMessages.map(msg => (
            <Bubble key={msg.id} message={msg} isNew={newIds.has(msg.id)} />
          ))}
          {typing && <TypingIndicator agent={typing} />}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="px-4 py-3 border-t border-zinc-800">
          <div className="flex items-center gap-2 bg-zinc-800 rounded-lg px-3 py-2">
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleSend()}
              placeholder={`Message ${activeId.startsWith("thadius") ? `#${activeThread.label}` : activeThread.label}...`}
              className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-600 outline-none"
            />
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="text-zinc-500 hover:text-zinc-200 disabled:opacity-30 transition-colors"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
