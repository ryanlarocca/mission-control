"use client"

import { useState } from "react"
import {
  Mail, Users, Home, BookUser, TrendingUp,
  Check, X, Send, Search, Phone, ChevronDown, ChevronRight, SkipForward, Network,
} from "lucide-react"
import { CRMSTab } from "./CRMSTab"

// ══════════════════════════════════════════════════════════════════════════════
// MOCK DATA
// ══════════════════════════════════════════════════════════════════════════════

const agentEmails = [
  { id: "ae1", agent: "Sarah Mitchell", brokerage: "Compass", property: "1842 Maple Grove Ct", price: "$485k", status: "draft", subject: "Your buyer's listing on Maple Grove — quick note", preview: "Hi Sarah, I noticed you represent a buyer currently under contract on 1842 Maple Grove. I have a client who toured last week and is still very interested — wanted to reach out directly in case anything changes on your end. Happy to work together.", sent: null },
  { id: "ae2", agent: "James Okafor", brokerage: "Redfin", property: "3301 Stonewall Dr", price: "$620k", status: "draft", subject: "Stonewall listing — buyer interest", preview: "Hi James, reaching out about your listing at 3301 Stonewall. I have a pre-approved buyer in the $600-650k range who toured yesterday and is ready to move quickly. Would love to connect.", sent: null },
  { id: "ae3", agent: "Lisa Tran", brokerage: "KW", property: "5610 Balcones Dr", price: "$755k", status: "sent", subject: "Offer interest — 5610 Balcones Dr", preview: "Hi Lisa, following up on our offer submitted yesterday on Balcones. My client is highly motivated and we're flexible on timeline. Let me know if there's anything we can do to strengthen the offer.", sent: "Mar 28" },
  { id: "ae4", agent: "Derek Wu", brokerage: "Redfin", property: "908 Ridgemont Ave", price: "$399k", status: "draft", subject: "New listing — buyer inquiry", preview: "Hi Derek, just saw your new listing at 908 Ridgemont hit the market this morning. I have a first-time buyer in the $375-425k range who's actively looking in Cedar Park — would love to schedule a showing.", sent: null },
  { id: "ae5", agent: "Monica Reyes", brokerage: "Coldwell", property: "214 Westlake Hills Blvd", price: "$1.1M", status: "bounced", subject: "Westlake Hills listing inquiry", preview: "Hi Monica, reaching out about 214 Westlake Hills. I represent a buyer relocating from the Bay Area with a $1.2M budget — this listing checks every box.", sent: "Mar 27" },
  { id: "ae6", agent: "Tyler Brooks", brokerage: "eXp", property: "4821 Shoal Creek Blvd", price: "$540k", status: "draft", subject: "Shoal Creek — pre-approved buyer ready", preview: "Hi Tyler, I have a buyer who specifically requested Shoal Creek area and your listing fits perfectly. Pre-approved, flexible close, motivated to move before school year.", sent: null },
  { id: "ae7", agent: "Amanda Price", brokerage: "Redfin", property: "720 Cloverleaf Dr", price: "$468k", status: "queued", subject: "Cloverleaf listing — showing request", preview: "Hi Amanda, would love to schedule a showing for 720 Cloverleaf this week. Buyer is pre-approved at $500k, closing in 30 days.", sent: null },
]

type EmailStatus = "draft" | "queued" | "sent" | "bounced"
const emailStatusStyle: Record<EmailStatus, string> = {
  draft:   "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
  queued:  "bg-amber-500/20 text-amber-400 border-amber-500/30",
  sent:    "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  bounced: "bg-red-500/20 text-red-400 border-red-500/30",
}

const coiContacts = [
  { id: "c1",  name: "John & Mary Smith",  tier: "A", phone: "512-555-0101", email: "jsmith@email.com",  lastContact: "28d ago", status: "due",     type: "Past Client",      notes: "Bought 2022, referred 2 deals" },
  { id: "c2",  name: "David Torres",       tier: "A", phone: "512-555-0182", email: "dtorres@gmail.com", lastContact: "31d ago", status: "overdue", type: "Past Client",      notes: "Builder contact, golf buddy" },
  { id: "c3",  name: "Amanda Chen",        tier: "A", phone: "512-555-0293", email: "achen@work.com",    lastContact: "21d ago", status: "overdue", type: "Referral Source",  notes: "Refers 1-2 clients/year" },
  { id: "c4",  name: "Marcus Webb",        tier: "B", phone: "512-555-0374", email: "mwebb@email.com",   lastContact: "5d ago",  status: "sent",    type: "COI",              notes: "Contractor, good referral" },
  { id: "c5",  name: "Jennifer Park",      tier: "B", phone: "512-555-0451", email: "jpark@gmail.com",   lastContact: "3d ago",  status: "replied", type: "Agent",            notes: "Redfin buyer's agent, Maple Grove" },
  { id: "c6",  name: "Lisa Johnson",       tier: "B", phone: "512-555-0562", email: "ljohnson@corp.com", lastContact: "26d ago", status: "due",     type: "Lender",           notes: "Works with first-time buyers" },
  { id: "c7",  name: "Bob Wilson",         tier: "C", phone: "512-555-0623", email: "bwilson@mail.com",  lastContact: "80d ago", status: "pending", type: "Neighbor",         notes: "" },
  { id: "c8",  name: "Sarah Lee",          tier: "C", phone: "512-555-0714", email: "slee@email.com",    lastContact: "58d ago", status: "pending", type: "Past Client",      notes: "Sold 2021" },
  { id: "c9",  name: "Mike Davis",         tier: "C", phone: "512-555-0885", email: "mdavis@work.com",   lastContact: "30d ago", status: "pending", type: "COI",              notes: "" },
  { id: "c10", name: "Tom Brown",          tier: "C", phone: "512-555-0996", email: "tbrown@gmail.com",  lastContact: "101d ago",status: "pending", type: "Friend",           notes: "" },
]

const messageTemplates = {
  A: [
    { label: "A", text: "Hey [Name]! Hope you're doing great. Just checking in — been a busy market lately. If you know anyone thinking about buying or selling, I'd love the introduction. Coffee's on me 😊" },
    { label: "B", text: "Hey [Name], quick check-in from my end. Spring market is moving fast — prices up, inventory tight. If anyone in your circle is thinking about making a move, now's a great time to talk. Let me know!" },
    { label: "C", text: "Hi [Name]! Just thinking of you. Had a client close on a great deal in your area last week — market is really active right now. Would love to catch up if you have time soon." },
  ],
  B: [
    { label: "A", text: "Hi [Name], hope things are going well! Just wanted to stay in touch. Real estate is moving fast in Austin right now — great time to be connected. Let me know if I can ever be a resource." },
    { label: "B", text: "Hey [Name]! Quick check-in. Markets are shifting and I've been busy with buyers and sellers. If you or anyone you know has real estate needs, I'm here. Hope all is well!" },
    { label: "C", text: "Hi [Name], it's Ryan LaRocca with LRG Homes. Just reaching out to stay connected. Exciting things happening in the market — happy to share what I'm seeing if you're ever curious." },
  ],
  C: [
    { label: "A", text: "Hi [Name], Ryan LaRocca with LRG Homes here. Just reaching out to say hello and stay on your radar. If real estate ever comes up in conversation, I hope you'll think of me!" },
    { label: "B", text: "Hey [Name], hope all is well! This is Ryan LaRocca, your local real estate resource. Just checking in and wishing you a great spring. Feel free to reach out anytime." },
    { label: "C", text: "Hi [Name], Ryan LaRocca here with LRG Homes. Just a friendly check-in — if you ever have questions about the market or real estate in general, don't hesitate to reach out!" },
  ],
}

// Redfin outreach mock data
const redfinEligible = [
  { id: "rf1", address: "5610 Balcones Dr, Austin TX 78731",   agent: "Lisa Tran",     daysOverdue: 12, lastContact: "Mar 19" },
  { id: "rf2", address: "3301 Stonewall Dr, Austin TX 78731",  agent: "James Okafor",  daysOverdue: 9,  lastContact: "Mar 22" },
  { id: "rf3", address: "908 Ridgemont Ave, Cedar Park TX",    agent: "Derek Wu",      daysOverdue: 7,  lastContact: "Mar 24" },
  { id: "rf4", address: "4821 Shoal Creek Blvd, Austin TX",   agent: "Tyler Brooks",  daysOverdue: 5,  lastContact: "Mar 26" },
  { id: "rf5", address: "720 Cloverleaf Dr, Austin TX 78704",  agent: "Amanda Price",  daysOverdue: 3,  lastContact: "Mar 28" },
]

const redfinAllProperties = [
  { id: "p1",  address: "5610 Balcones Dr",       agent: "Lisa Tran",    cadenceDay: 28, cadenceTotal: 30, nextFollowup: "Apr 2" },
  { id: "p2",  address: "3301 Stonewall Dr",       agent: "James Okafor", cadenceDay: 22, cadenceTotal: 30, nextFollowup: "Apr 8" },
  { id: "p3",  address: "1842 Maple Grove Ct",     agent: "Sarah Mitchell",cadenceDay: 15, cadenceTotal: 30, nextFollowup: "Apr 15" },
  { id: "p4",  address: "908 Ridgemont Ave",       agent: "Derek Wu",     cadenceDay: 8,  cadenceTotal: 30, nextFollowup: "Apr 22" },
  { id: "p5",  address: "214 Westlake Hills Blvd", agent: "Monica Reyes", cadenceDay: 6,  cadenceTotal: 60, nextFollowup: "May 20" },
  { id: "p6",  address: "4821 Shoal Creek Blvd",  agent: "Tyler Brooks",  cadenceDay: 18, cadenceTotal: 30, nextFollowup: "Apr 12" },
  { id: "p7",  address: "720 Cloverleaf Dr",       agent: "Amanda Price",  cadenceDay: 12, cadenceTotal: 30, nextFollowup: "Apr 18" },
  { id: "p8",  address: "402 Bridle Path Ln",      agent: "Chris Evans",   cadenceDay: 3,  cadenceTotal: 30, nextFollowup: "Apr 27" },
]

const redfinSent = [
  { id: "s1", date: "Mar 28", agent: "Lisa Tran",     address: "5610 Balcones Dr",       msgType: "Initial" },
  { id: "s2", date: "Mar 27", agent: "James Okafor",  address: "3301 Stonewall Dr",       msgType: "Initial" },
  { id: "s3", date: "Mar 26", agent: "Sarah Mitchell", address: "1842 Maple Grove Ct",    msgType: "30-Day" },
  { id: "s4", date: "Mar 25", agent: "Tyler Brooks",  address: "4821 Shoal Creek Blvd",  msgType: "Initial" },
  { id: "s5", date: "Mar 24", agent: "Amanda Price",  address: "720 Cloverleaf Dr",       msgType: "60-Day" },
]

const leads = [
  { id: "l1",  name: "Kevin Hart",      phone: "512-555-1001", source: "Google Ads",      status: "hot",   date: "Today",  budget: "$450-550k", notes: "Called from ad, wants Buda/Kyle area. Pre-qual in progress." },
  { id: "l2",  name: "Priya Sharma",    phone: "737-555-2044", source: "Google Ads",      status: "warm",  date: "Today",  budget: "$600-700k", notes: "Submitted lead form, wants 4BR in North Austin." },
  { id: "l3",  name: "Carlos Vega",     phone: "512-555-3192", source: "Agent Referral",  status: "hot",   date: "Mar 29", budget: "$500k+",    notes: "Referred by Jennifer Park. Pre-approved, closing in 45 days." },
  { id: "l4",  name: "Danielle Moore",  phone: "512-555-4023", source: "Direct Mail",     status: "warm",  date: "Mar 28", budget: "Unknown",   notes: "Responded to mailer, thinking about selling in 6 months." },
  { id: "l5",  name: "Eric Thompson",   phone: "737-555-5187", source: "Google Ads",      status: "cold",  date: "Mar 27", budget: "$350-400k", notes: "Clicked ad, no response to follow-up texts yet." },
  { id: "l6",  name: "Janet Wu",        phone: "512-555-6204", source: "Agent Referral",  status: "warm",  date: "Mar 26", budget: "$800k+",    notes: "Referred by past client. Relocating from Seattle, cash buyer." },
  { id: "l7",  name: "Mark Peterson",   phone: "512-555-7330", source: "Direct Mail",     status: "cold",  date: "Mar 25", budget: "Unknown",   notes: "Called about mailer, just curious about market value." },
  { id: "l8",  name: "Yolanda Cruz",    phone: "737-555-8901", source: "Google Ads",      status: "hot",   date: "Mar 24", budget: "$550-650k", notes: "3rd follow-up scheduled Thursday 2pm. Very motivated." },
  { id: "l9",  name: "Brian Nelson",    phone: "512-555-9012", source: "Agent Referral",  status: "warm",  date: "Mar 22", budget: "$400-500k", notes: "First-time buyer, referred by lender Lisa Johnson." },
  { id: "l10", name: "Rachel Kim",      phone: "737-555-0123", source: "Direct Mail",     status: "cold",  date: "Mar 15", budget: "$725k",     notes: "Inquired about market value in her area." },
]

// ══════════════════════════════════════════════════════════════════════════════
// SHARED STYLES
// ══════════════════════════════════════════════════════════════════════════════

const tierStyle: Record<string, string> = {
  A: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  B: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  C: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
}

const coiStatusStyle: Record<string, string> = {
  due:     "bg-amber-500/20 text-amber-400 border-amber-500/30",
  overdue: "bg-red-500/20 text-red-400 border-red-500/30",
  sent:    "bg-blue-500/20 text-blue-400 border-blue-500/30",
  replied: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  pending: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
}

function InnerTabBar({ tabs, active, setActive }: { tabs: string[]; active: string; setActive: (t: string) => void }) {
  return (
    <div className="flex items-center gap-1 bg-zinc-800/60 border border-zinc-700 rounded-lg p-1 w-fit mb-4">
      {tabs.map(t => (
        <button key={t} onClick={() => setActive(t)}
          className={`px-3 py-1 rounded text-xs transition-colors whitespace-nowrap ${active === t ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}>
          {t}
        </button>
      ))}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: AGENT EMAILS
// ══════════════════════════════════════════════════════════════════════════════

function AgentEmailsTab() {
  const [emails, setEmails] = useState(agentEmails)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [skipped, setSkipped] = useState<Set<string>>(new Set())

  function skip(id: string) {
    setSkipped(prev => new Set(prev).add(id))
    setExpanded(null)
  }

  function send(id: string) {
    setEmails(p => p.map(e => e.id === id ? { ...e, status: "sent", sent: "Today" } : e))
    setExpanded(null)
  }

  const draftCount = emails.filter(e => e.status === "draft" && !skipped.has(e.id)).length

  return (
    <div className="space-y-3">
      {/* Top bar */}
      <div className="flex items-center gap-3">
        <button
          disabled={draftCount === 0}
          className="flex items-center gap-2 text-xs text-emerald-400 hover:text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 hover:border-emerald-500/40 px-3 py-1.5 rounded transition-colors disabled:opacity-40"
        >
          <Send className="w-3.5 h-3.5" />
          Send All Drafts
          {draftCount > 0 && (
            <span className="bg-emerald-500 text-zinc-950 text-xs font-bold px-1.5 py-0.5 rounded-full leading-none">
              {draftCount}
            </span>
          )}
        </button>
        <p className="text-xs text-zinc-600">{emails.length} total emails</p>
      </div>

      {emails.map(email => {
        if (skipped.has(email.id)) return null
        return (
          <div key={email.id} className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
            <div className="px-4 py-3 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                  <p className="text-sm font-semibold text-zinc-100">{email.agent}</p>
                  <span className="text-xs text-zinc-600">{email.brokerage}</span>
                  <span className={`ml-auto text-xs px-1.5 py-0.5 rounded border ${emailStatusStyle[email.status as EmailStatus]}`}>
                    {email.status}{email.sent ? ` · ${email.sent}` : ""}
                  </span>
                </div>
                <p className="text-xs text-zinc-500 truncate">{email.property} · {email.price}</p>
                <p className="text-xs text-zinc-400 mt-1 truncate italic">"{email.subject}"</p>
              </div>
              <button onClick={() => setExpanded(expanded === email.id ? null : email.id)}
                className="text-zinc-600 hover:text-zinc-300 shrink-0 transition-colors mt-0.5">
                {expanded === email.id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </button>
            </div>

            {expanded === email.id && (
              <div className="border-t border-zinc-800 px-4 py-3 bg-zinc-950/40">
                <p className="text-xs text-zinc-300 leading-relaxed mb-3">{email.preview}</p>
                <div className="flex gap-2 flex-wrap">
                  {(email.status === "draft" || email.status === "queued") && (
                    <button onClick={() => send(email.id)}
                      className="flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 px-3 py-1.5 rounded transition-colors">
                      <Send className="w-3.5 h-3.5" /> Send
                    </button>
                  )}
                  {email.status !== "sent" && email.status !== "bounced" && (
                    <button onClick={() => skip(email.id)}
                      className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800 border border-zinc-700 px-3 py-1.5 rounded transition-colors">
                      <SkipForward className="w-3.5 h-3.5" /> Skip
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: COI OUTREACH
// ══════════════════════════════════════════════════════════════════════════════

function COIOutreachTab() {
  const [contacts, setContacts] = useState(coiContacts)
  const [selectedVariant, setSelectedVariant] = useState<Record<string, string>>({})
  const [sent, setSent] = useState<Set<string>>(new Set())

  const dueContacts = contacts.filter(c => (c.status === "due" || c.status === "overdue") && !sent.has(c.id))

  function selectVariant(contactId: string, variant: string) {
    setSelectedVariant(prev => {
      // toggle off if already selected
      if (prev[contactId] === variant) {
        const next = { ...prev }
        delete next[contactId]
        return next
      }
      return { ...prev, [contactId]: variant }
    })
  }

  function sendApproved() {
    const ids = Object.keys(selectedVariant)
    ids.forEach(id => {
      setSent(prev => new Set(prev).add(id))
      setContacts(p => p.map(c => c.id === id ? { ...c, status: "sent", lastContact: "Today" } : c))
    })
    setSelectedVariant({})
  }

  const approvedCount = Object.keys(selectedVariant).length

  return (
    <div className="space-y-3">
      {/* Header bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="bg-amber-500/10 border border-amber-500/20 rounded px-3 py-1.5">
          <p className="text-xs text-amber-400 font-medium">{dueContacts.length} contacts due today</p>
        </div>
        <button
          onClick={sendApproved}
          disabled={approvedCount === 0}
          className="flex items-center gap-2 text-xs text-emerald-400 hover:text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 px-3 py-1.5 rounded transition-colors disabled:opacity-40"
        >
          <Send className="w-3.5 h-3.5" />
          Send Approved
          {approvedCount > 0 && (
            <span className="bg-emerald-500 text-zinc-950 text-xs font-bold px-1.5 py-0.5 rounded-full leading-none">
              {approvedCount}
            </span>
          )}
        </button>
      </div>

      {dueContacts.length === 0 && (
        <div className="text-center py-12">
          <p className="text-sm text-zinc-500">No COI contacts due today</p>
        </div>
      )}

      {contacts.map(contact => {
        if (sent.has(contact.id)) return null
        if (contact.status !== "due" && contact.status !== "overdue") return null

        const templates = messageTemplates[contact.tier as keyof typeof messageTemplates]
        const chosenVariant = selectedVariant[contact.id]
        const isSelected = !!chosenVariant
        const selectedTemplate = templates.find(t => t.label === chosenVariant)
        const personalizedText = selectedTemplate
          ? selectedTemplate.text.replace(/\[Name\]/g, contact.name.split(" ")[0])
          : null

        return (
          <div key={contact.id}
            className={`bg-zinc-900 border rounded-lg overflow-hidden transition-all ${
              isSelected ? "border-emerald-500/40 ring-1 ring-emerald-500/20" : "border-zinc-800"
            }`}
          >
            <div className="px-4 py-3 flex items-center gap-3">
              <span className={`text-xs font-bold px-1.5 py-0.5 rounded border ${tierStyle[contact.tier]}`}>{contact.tier}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-zinc-100">{contact.name}</p>
                <p className="text-xs text-zinc-500">{contact.type} · {contact.lastContact}</p>
              </div>
              {/* Variant pill buttons */}
              <div className="flex items-center gap-1 shrink-0">
                {templates.map(t => (
                  <button
                    key={t.label}
                    onClick={() => selectVariant(contact.id, t.label)}
                    className={`min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 flex items-center justify-center text-xs font-bold px-2.5 py-1 rounded border transition-colors ${
                      chosenVariant === t.label
                        ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/40"
                        : "text-zinc-500 border-zinc-700 hover:text-zinc-300 hover:border-zinc-600"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Preview when variant selected */}
            {personalizedText && (
              <div className="border-t border-zinc-800 px-4 py-3 bg-zinc-950/40">
                <div className="bg-zinc-900 border border-zinc-700 rounded px-3 py-2.5 mb-3">
                  <p className="text-xs text-zinc-300 leading-relaxed">{personalizedText}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1.5 text-xs text-zinc-500">
                    <Phone className="w-3 h-3" />{contact.phone}
                  </span>
                  {contact.notes && (
                    <span className="text-xs text-zinc-600 truncate">· {contact.notes}</span>
                  )}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: REDFIN FIXER
// ══════════════════════════════════════════════════════════════════════════════

function CadenceBar({ day, total }: { day: number; total: number }) {
  const pct = Math.min((day / total) * 100, 100)
  const color = pct >= 90 ? "bg-red-500" : pct >= 60 ? "bg-amber-500" : "bg-emerald-500"
  return (
    <div className="flex items-center gap-2 w-28">
      <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-zinc-500 shrink-0 w-12 text-right">{day}/{total}d</span>
    </div>
  )
}

function RedfinFixerTab() {
  const [inner, setInner] = useState("Eligible")
  const [skipped, setSkipped] = useState<Set<string>>(new Set())

  return (
    <div>
      <InnerTabBar tabs={["Eligible", "All Properties", "Sent"]} active={inner} setActive={setInner} />

      {inner === "Eligible" && (
        <div className="space-y-2">
          {redfinEligible.filter(e => !skipped.has(e.id)).length === 0 && (
            <div className="text-center py-12">
              <p className="text-sm text-zinc-500">No agents due for outreach today ✓</p>
            </div>
          )}
          {redfinEligible
            .filter(e => !skipped.has(e.id))
            .sort((a, b) => b.daysOverdue - a.daysOverdue)
            .map(e => (
              <div key={e.id} className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-zinc-100 truncate">{e.address}</p>
                  <p className="text-xs text-zinc-500">{e.agent} · Last: {e.lastContact}</p>
                </div>
                <span className="text-xs px-1.5 py-0.5 rounded border bg-red-500/20 text-red-400 border-red-500/30 shrink-0">
                  {e.daysOverdue}d overdue
                </span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1.5 rounded transition-colors">
                    <Send className="w-3 h-3" /> Send
                  </button>
                  <button onClick={() => setSkipped(p => new Set(p).add(e.id))}
                    className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 bg-zinc-800 border border-zinc-700 px-2.5 py-1.5 rounded transition-colors">
                    <SkipForward className="w-3 h-3" /> Skip
                  </button>
                </div>
              </div>
            ))}
        </div>
      )}

      {inner === "All Properties" && (
        <div className="space-y-2">
          {redfinAllProperties.map(p => (
            <div key={p.id} className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-zinc-100 truncate">{p.address}</p>
                <p className="text-xs text-zinc-500">{p.agent}</p>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <CadenceBar day={p.cadenceDay} total={p.cadenceTotal} />
                <p className="text-xs text-zinc-600">Next: {p.nextFollowup}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {inner === "Sent" && (
        <div className="space-y-2">
          {redfinSent.map(s => (
            <div key={s.id} className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 flex items-center gap-3">
              <p className="text-xs text-zinc-600 w-16 shrink-0">{s.date}</p>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-zinc-100 truncate">{s.address}</p>
                <p className="text-xs text-zinc-500">{s.agent}</p>
              </div>
              <span className="text-xs px-1.5 py-0.5 rounded border bg-blue-500/20 text-blue-400 border-blue-500/30 shrink-0">
                {s.msgType}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: COI LIST
// ══════════════════════════════════════════════════════════════════════════════

function COIListTab() {
  const [query, setQuery] = useState("")
  const [tierFilter, setTierFilter] = useState<"all" | "A" | "B" | "C">("all")

  const filtered = coiContacts.filter(c => {
    const matchesSearch = !query || c.name.toLowerCase().includes(query.toLowerCase()) || c.type.toLowerCase().includes(query.toLowerCase())
    const matchesTier = tierFilter === "all" || c.tier === tierFilter
    return matchesSearch && matchesTier
  })

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex-1 flex items-center gap-2 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 min-w-48">
          <Search className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search contacts..."
            className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-600 outline-none" />
        </div>
        <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-lg p-1">
          {(["all", "A", "B", "C"] as const).map(t => (
            <button key={t} onClick={() => setTierFilter(t)}
              className={`px-2.5 py-1 rounded text-xs transition-colors ${tierFilter === t ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}>
              {t === "all" ? "All" : `Tier ${t}`}
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs text-zinc-600">{filtered.length} contacts</p>

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        {filtered.map((c, i) => (
          <div key={c.id} className={`flex items-center gap-3 px-4 py-3 ${i < filtered.length - 1 ? "border-b border-zinc-800" : ""}`}>
            <span className={`text-xs font-bold px-1.5 py-0.5 rounded border shrink-0 ${tierStyle[c.tier]}`}>{c.tier}</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-zinc-100 font-medium">{c.name}</p>
              <p className="text-xs text-zinc-500">{c.type}{c.notes ? ` · ${c.notes}` : ""}</p>
            </div>
            <div className="text-right shrink-0 hidden sm:block">
              <p className="text-xs text-zinc-400 font-mono">{c.phone}</p>
              <p className="text-xs text-zinc-600">Last: {c.lastContact}</p>
            </div>
            <span className={`text-xs px-1.5 py-0.5 rounded border shrink-0 ${coiStatusStyle[c.status] || coiStatusStyle.pending}`}>
              {c.status}
            </span>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="px-4 py-8 text-center text-xs text-zinc-600">No contacts found</div>
        )}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: LEADS
// ══════════════════════════════════════════════════════════════════════════════

const sourceStyle: Record<string, string> = {
  "Google Ads":     "bg-blue-500/10 text-blue-400 border border-blue-500/20",
  "Agent Referral": "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20",
  "Direct Mail":    "bg-amber-500/10 text-amber-400 border border-amber-500/20",
}

function LeadsTab() {
  const [inner, setInner] = useState("Hot")
  const [expandedLead, setExpandedLead] = useState<string | null>(null)

  const filtered = leads.filter(l => l.status === inner.toLowerCase())

  return (
    <div>
      <InnerTabBar tabs={["Hot", "Warm", "Cold"]} active={inner} setActive={setInner} />

      <div className="space-y-2">
        {filtered.length === 0 && (
          <div className="text-center py-12">
            <p className="text-sm text-zinc-500">No {inner.toLowerCase()} leads right now</p>
          </div>
        )}
        {filtered.map(lead => (
          <div key={lead.id} className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
            <button
              onClick={() => setExpandedLead(expandedLead === lead.id ? null : lead.id)}
              className="w-full px-4 py-3 flex items-center gap-3 text-left"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-0.5">
                  <p className="text-sm font-semibold text-zinc-100">{lead.name}</p>
                  <span className={`text-xs px-1.5 py-0.5 rounded ${sourceStyle[lead.source] || ""}`}>{lead.source}</span>
                </div>
                <p className="text-xs text-zinc-500 font-mono">{lead.phone} · {lead.date}</p>
              </div>
              {expandedLead === lead.id ? <ChevronDown className="w-4 h-4 text-zinc-600 shrink-0" /> : <ChevronRight className="w-4 h-4 text-zinc-600 shrink-0" />}
            </button>

            {expandedLead === lead.id && (
              <div className="border-t border-zinc-800 bg-zinc-950/40 px-4 py-3 space-y-2">
                {lead.budget !== "Unknown" && (
                  <p className="text-xs text-zinc-400">Budget: <span className="text-zinc-200 font-medium">{lead.budget}</span></p>
                )}
                <div>
                  <p className="text-xs text-zinc-600 mb-1">Notes</p>
                  <p className="text-xs text-zinc-300 leading-relaxed">{lead.notes}</p>
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <span className="flex items-center gap-1.5 text-xs text-zinc-500">
                    <Phone className="w-3 h-3" />{lead.phone}
                  </span>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// ROOT COMPONENT
// ══════════════════════════════════════════════════════════════════════════════

const tabs = [
  { id: "emails",   label: "Agent Emails",  icon: Mail },
  { id: "redfin",   label: "Redfin Fixer",  icon: Home },
  { id: "contacts", label: "COI List",      icon: BookUser },
  { id: "leads",    label: "Leads",         icon: TrendingUp },
  { id: "crms",     label: "Relationships", icon: Network },
]

export function RealEstateWidget() {
  const [activeTab, setActiveTab] = useState("emails")

  return (
    <div>
      {/* Tab bar */}
      <div className="flex items-center gap-0 border-b border-zinc-800 mb-5 overflow-x-auto">
        {tabs.map(tab => {
          const Icon = tab.icon
          const active = activeTab === tab.id
          return (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                active
                  ? "border-zinc-100 text-zinc-100"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}>
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* Tab content */}
      {activeTab === "emails"   && <AgentEmailsTab />}
      {activeTab === "redfin"   && <RedfinFixerTab />}
      {activeTab === "contacts" && <COIListTab />}
      {activeTab === "leads"    && <LeadsTab />}
      {activeTab === "crms"     && <CRMSTab />}
    </div>
  )
}
