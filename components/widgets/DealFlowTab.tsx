"use client"

import { useEffect, useMemo, useState } from "react"
import type { DealFlowData, DealFlowNote, DealFlowProperty, DealFlowScorecardRow } from "@/lib/dealFlow"

// Deal Flow — readable view over the deal-analysis snapshot + comments.
// Four views: Overview (what the numbers say), Properties (every pitched
// address, filterable, expandable, commentable), Senders, Investors.

type View = "overview" | "properties" | "senders" | "investors"

const OUTCOME_ORDER = [
  "FLIPPED", "FLIP IN PROGRESS", "LISTED (no sale yet)", "PENDING / possible mid-flip",
  "SOLD ONCE", "RESOLD (end user?)", "TOO EARLY", "NEVER SOLD", "NEVER SOLD (recent prior sale)",
  "NOT FOUND", "NOT TRACED", "CONFLICT",
]
const CHANNELS = ["Wholesaler", "Direct pitch", "Agent-recycled", "VA-prospecting", "Unclear"]

const num = (s: string | undefined | null) => {
  if (s === undefined || s === null || s === "") return null
  const n = Number(String(s).replace(/[$,]/g, ""))
  return Number.isFinite(n) ? n : null
}
const money = (s: string | number | null | undefined) => {
  const n = typeof s === "number" ? s : num(s ?? "")
  if (n === null) return "—"
  const abs = Math.abs(n)
  const txt = abs >= 1_000_000 ? `$${(abs / 1_000_000).toFixed(2)}M` : abs >= 1000 ? `$${Math.round(abs / 1000)}k` : `$${abs}`
  return n < 0 ? `−${txt}` : txt
}
const pct = (s: string | null | undefined) => { const n = num(s ?? ""); return n === null ? "—" : `${n}%` }

function outcomeTone(o: string) {
  if (o.startsWith("FLIPPED")) return "bg-amber-600/20 text-amber-300 border-amber-700/40"
  if (o.startsWith("FLIP IN PROGRESS") || o.startsWith("LISTED") || o.startsWith("PENDING")) return "bg-sky-600/20 text-sky-300 border-sky-700/40"
  if (o.startsWith("SOLD") || o.startsWith("RESOLD")) return "bg-violet-600/20 text-violet-300 border-violet-700/40"
  if (o.startsWith("NEVER")) return "bg-zinc-700/40 text-zinc-300 border-zinc-600/40"
  if (o.startsWith("NOT FOUND") || o.startsWith("NOT TRACED")) return "bg-zinc-800 text-zinc-500 border-zinc-700/60"
  return "bg-zinc-800 text-zinc-400 border-zinc-700"
}
function Pill({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none ${className}`}>{children}</span>
}
function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-zinc-100">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-zinc-500">{sub}</div>}
    </div>
  )
}

export function DealFlowTab({ data }: { data: DealFlowData }) {
  const [view, setView] = useState<View>("overview")
  const [notes, setNotes] = useState<DealFlowNote[]>([])
  const [notesError, setNotesError] = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/deal-flow/notes").then(r => r.json()).then(j => {
      if (j.error) setNotesError(j.error); else setNotes(j.notes ?? [])
    }).catch(e => setNotesError(String(e)))
  }, [])

  const notesByAddress = useMemo(() => {
    const m = new Map<string, DealFlowNote[]>()
    for (const n of notes) { const l = m.get(n.address) ?? []; l.push(n); m.set(n.address, l) }
    return m
  }, [notes])

  async function addNote(address: string, body: string) {
    const r = await fetch("/api/deal-flow/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address, body }) })
    const j = await r.json()
    if (j.note) setNotes(n => [...n, j.note]); else throw new Error(j.error ?? "save failed")
  }
  async function removeNote(id: string) {
    const r = await fetch("/api/deal-flow/notes", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) })
    const j = await r.json()
    if (j.ok) setNotes(n => n.filter(x => x.id !== id))
  }

  return (
    <div className="max-w-6xl">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Deal Flow</h1>
          <p className="mt-0.5 text-sm text-zinc-500">
            What happened to every property pitched to you, Jan 2024 → Aug 2026 · snapshot {data.generated}
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-1">
          {(["overview", "properties", "senders", "investors"] as View[]).map(v => (
            <button key={v} onClick={() => setView(v)}
              className={`rounded-md px-3 py-1.5 text-sm capitalize ${view === v ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}`}>
              {v}
            </button>
          ))}
        </div>
      </div>
      {notesError && <div className="mb-3 rounded border border-red-900/50 bg-red-950/30 p-2 text-xs text-red-300">Comments unavailable: {notesError}</div>}
      {view === "overview" && <Overview data={data} />}
      {view === "properties" && <Properties data={data} notesByAddress={notesByAddress} addNote={addNote} removeNote={removeNote} />}
      {view === "senders" && <Senders data={data} />}
      {view === "investors" && <Investors data={data} />}
    </div>
  )
}

// ---------------------------------------------------------------- Overview
function Overview({ data }: { data: DealFlowData }) {
  const p = data.properties
  const count = (f: (r: DealFlowProperty) => boolean) => p.filter(f).length
  const flips = p.filter(r => r.Outcome === "FLIPPED")
  const winners = flips.filter(r => r.Verdict?.startsWith("WINNER")).length
  const traced = count(r => !!r.Sources)
  const notFound = count(r => r.Outcome === "NOT FOUND")
  const quotes = p.filter(r => num(r.Your_Quote) && num(r.Sale1_Price))
  const atOrAbove = quotes.filter(r => (num(r.Your_Quote) ?? 0) >= (num(r.Sale1_Price) ?? 0) * 0.98).length
  const asks = p.filter(r => (num(r.Ask) ?? 0) > 100000 && num(r.Sale1_Price))
  const askDeltas = asks.map(r => ((num(r.Sale1_Price) ?? 0) - (num(r.Ask) ?? 0)) / (num(r.Ask) ?? 1)).sort((a, b) => a - b)
  const medAsk = askDeltas.length ? askDeltas[Math.floor(askDeltas.length / 2)] : null
  const over = askDeltas.filter(d => d < -0.02).length

  const byTier = (t: string) => {
    const L = flips.filter(r => r.Tier === t).map(r => num(r.Est_Net) ?? 0).sort((a, b) => a - b)
    return { n: L.length, pos: L.filter(x => x > 0).length, med: L.length ? L[Math.floor(L.length / 2)] : null }
  }
  const channelRows = data.scorecard.filter(r => r.Sender.startsWith("channel: "))

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Properties pitched" value={String(p.length)} sub={`${count(r => r.Cohort === "2024-25")} in 2024–25 · ${count(r => r.Cohort === "2026")} in 2026`} />
        <Tile label="Verified flips" value={String(flips.length)} sub={`${winners} pass your gates ($200k net + 10%/yr)`} />
        <Tile label="Traced to a record" value={`${traced} / ${p.length}`} sub={`${notFound} not found yet (coverage gap, not an outcome)`} />
        <Tile label="Asks vs. what it traded for" value={medAsk === null ? "—" : `${(medAsk * 100).toFixed(1)}%`} sub={`${over} of ${asks.length} priced deals quoted above the trade`} />
      </div>

      <Section title="The short version">
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-zinc-300">
          <li><b className="text-zinc-100">Zero of {flips.length} verified flips</b> clear both gates. Quick cosmetic turns make money but small (median net {money(byTier("QUICK").med)} on {byTier("QUICK").n}); deep remodels are a coin flip (median {money(byTier("DEEP").med)} on {byTier("DEEP").n}); new construction lost both times. Margin is gone at the entry auction.</li>
          <li><b className="text-zinc-100">Your bids were competitive.</b> On {quotes.length} deals where we have your quote and the actual trade, you were at or above the clearing price on {atOrAbove}. Passing was usually right.</li>
          <li><b className="text-zinc-100">Asks run high.</b> Median trade {medAsk === null ? "—" : `${(medAsk * 100).toFixed(1)}%`} vs. ask; {over} of {asks.length} priced deals were quoted above what they traded for.</li>
          <li><b className="text-zinc-100">Channels:</b> wholesaler inventory trades (~41%) but is already priced; direct pitches move fastest (median ~28 days); agent-recycled listings are dead weight. Madelyn/Dane&apos;s prospects mostly never sold — that list is the phase-two target pool.</li>
          <li><b className="text-zinc-100">Buyers:</b> many small LLCs taking thin margins; only Aron Homes LLC repeats. Nobody is crushing it in your flow.</li>
        </ul>
      </Section>

      <Section title="By channel" sub="How each kind of lead source actually performed. “Traded” = sold at least once after you were pitched.">
        <Table
          head={["Channel", "Sent", "Flipped", "In progress", "Sold once", "Pending / too early", "Never sold", "Not found", "Traded", "Ask vs actual (median)", "Days to sale (median)"]}
          rows={channelRows.map(r => [r.Sender.replace("channel: ", ""), r.Sent, r.Flipped, r.InProgress, r.SoldOnce, r.Pending, r.NeverSold, r.NotFound, pct(r["Traded%"]), r["Ask_vs_Actual_med%"] ? `${r["Ask_vs_Actual_med%"]}% (n=${r.n_ask})` : "—", r.Med_Days_To_Sale || "—"])}
        />
      </Section>

      <Section title="Verified flips — gross vs. estimated net" sub="Net uses your cost model: 1.5% buy close, build scaled to sale price by tier, 10% APR carry, 5–6.5% sell costs. Gross alone misleads.">
        <Table
          head={["Address", "Buyer", "Bought", "Sold", "Hold", "Gross", "Est. net", "Annualized", "Verdict"]}
          rows={[...flips].sort((a, b) => (num(b.Est_Net) ?? 0) - (num(a.Est_Net) ?? 0)).map(r => [
            `${r.Address}, ${r.City}`, r.Buyer || "—", money(r.Sale1_Price), money(r.Sale2_Price), r.Hold_Mo ? `${r.Hold_Mo} mo` : "—",
            money(r.Gross), money(r.Est_Net), r.Annualized ? `${r.Annualized}%` : "—", r.Verdict?.split(" ")[0] ?? "—",
          ])}
        />
      </Section>

      <Section title="Read the coverage honestly">
        <p className="text-sm text-zinc-400">
          {notFound} rows have no public record found <i>yet</i>. That is a tooling gap (deed aggregators lag 2026 sales; the search layer hit rate limits), not evidence that nothing happened — off-market closes are under-counted for every sender. The title-pull list sorted by sender lives in <code className="text-zinc-300">deal-analysis/TITLE_PULL_BY_SENDER.csv</code>.
        </p>
      </Section>
    </div>
  )
}

// ---------------------------------------------------------------- Properties
function Properties({ data, notesByAddress, addNote, removeNote }: {
  data: DealFlowData; notesByAddress: Map<string, DealFlowNote[]>
  addNote: (a: string, b: string) => Promise<void>; removeNote: (id: string) => Promise<void>
}) {
  const [q, setQ] = useState("")
  const [channel, setChannel] = useState("")
  const [outcome, setOutcome] = useState("")
  const [cohort, setCohort] = useState("")
  const [onlyNoted, setOnlyNoted] = useState(false)
  const [sort, setSort] = useState<"pitched" | "gross" | "net" | "address">("pitched")
  const [open, setOpen] = useState<string | null>(null)

  const outcomes = useMemo(() => {
    const s = new Set(data.properties.map(r => r.Outcome))
    return OUTCOME_ORDER.filter(o => s.has(o)).concat(Array.from(s).filter(o => !OUTCOME_ORDER.includes(o)))
  }, [data])

  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase()
    let L = data.properties.filter(r =>
      (!ql || `${r.Address} ${r.City} ${r.Sender_Name} ${r.Sender} ${r.Buyer} ${r.Listing_Agent}`.toLowerCase().includes(ql)) &&
      (!channel || r.Channel === channel) && (!outcome || r.Outcome === outcome) && (!cohort || r.Cohort === cohort) &&
      (!onlyNoted || notesByAddress.has(r.Address)))
    L = [...L].sort((a, b) => {
      if (sort === "pitched") return b.Pitched.localeCompare(a.Pitched)
      if (sort === "address") return a.Address.localeCompare(b.Address)
      const k = sort === "gross" ? "Gross" : "Est_Net"
      return (num(b[k]) ?? -1e12) - (num(a[k]) ?? -1e12)
    })
    return L
  }, [data, q, channel, outcome, cohort, onlyNoted, sort, notesByAddress])

  const sel = "rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200"
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search address, city, sender, buyer, agent…"
          className={`${sel} w-64 placeholder:text-zinc-600`} />
        <select value={channel} onChange={e => setChannel(e.target.value)} className={sel}>
          <option value="">All channels</option>{CHANNELS.map(c => <option key={c}>{c}</option>)}
        </select>
        <select value={outcome} onChange={e => setOutcome(e.target.value)} className={sel}>
          <option value="">All outcomes</option>{outcomes.map(o => <option key={o}>{o}</option>)}
        </select>
        <select value={cohort} onChange={e => setCohort(e.target.value)} className={sel}>
          <option value="">Both cohorts</option><option>2024-25</option><option>2026</option>
        </select>
        <select value={sort} onChange={e => setSort(e.target.value as typeof sort)} className={sel}>
          <option value="pitched">Newest pitched</option><option value="gross">Biggest gross</option>
          <option value="net">Best est. net</option><option value="address">Address A–Z</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm text-zinc-400">
          <input type="checkbox" checked={onlyNoted} onChange={e => setOnlyNoted(e.target.checked)} /> with comments
        </label>
        <span className="ml-auto text-xs text-zinc-500">{rows.length} of {data.properties.length}</span>
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-800">
        <div className="hidden grid-cols-[1.6fr_1fr_0.9fr_1fr_1fr_1fr_1.4fr] gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-2 text-[11px] uppercase tracking-wide text-zinc-500 md:grid">
          <div>Address</div><div>Pitched</div><div>Channel</div><div>Ask</div><div>Traded</div><div>Resold</div><div>Outcome</div>
        </div>
        {rows.map(r => {
          const isOpen = open === r.Address
          const n = notesByAddress.get(r.Address)?.length ?? 0
          return (
            <div key={r.Address} className="border-b border-zinc-800/70 last:border-b-0">
              <button onClick={() => setOpen(isOpen ? null : r.Address)}
                className="grid w-full grid-cols-2 gap-x-2 gap-y-1 px-3 py-2 text-left text-sm hover:bg-zinc-900/70 md:grid-cols-[1.6fr_1fr_0.9fr_1fr_1fr_1fr_1.4fr] md:gap-2">
                <div className="col-span-2 text-zinc-100 md:col-span-1">
                  {r.Address}<span className="text-zinc-500">, {r.City}</span>
                  {n > 0 && <span className="ml-2 rounded bg-amber-600/30 px-1.5 text-[10px] text-amber-200">{n} note{n > 1 ? "s" : ""}</span>}
                </div>
                <div className="text-zinc-400">{r.Pitched}</div>
                <div className="text-zinc-400">{r.Channel}</div>
                <div className="text-zinc-300">{money(r.Ask)}</div>
                <div className="text-zinc-300">{money(r.Sale1_Price)}{r.Sale1_Date && <span className="ml-1 text-[11px] text-zinc-500">{r.Sale1_Date.slice(0, 7)}</span>}</div>
                <div className="text-zinc-300">{money(r.Sale2_Price)}{r.Sale2_Date && <span className="ml-1 text-[11px] text-zinc-500">{r.Sale2_Date.slice(0, 7)}</span>}</div>
                <div className="col-span-2 md:col-span-1"><Pill className={outcomeTone(r.Outcome)}>{r.Outcome}</Pill></div>
              </button>
              {isOpen && <PropertyDetail r={r} notes={notesByAddress.get(r.Address) ?? []} addNote={addNote} removeNote={removeNote} />}
            </div>
          )
        })}
        {rows.length === 0 && <div className="p-6 text-center text-sm text-zinc-500">Nothing matches.</div>}
      </div>
    </div>
  )
}

function PropertyDetail({ r, notes, addNote, removeNote }: {
  r: DealFlowProperty; notes: DealFlowNote[]
  addNote: (a: string, b: string) => Promise<void>; removeNote: (id: string) => Promise<void>
}) {
  const [body, setBody] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const facts: [string, string][] = [
    ["Pitched", r.Pitched], ["Cohort", r.Cohort], ["Channel", r.Channel + (r.VA_Sub ? ` (${r.VA_Sub})` : "")],
    ["Sender", r.Sender_Name ? `${r.Sender_Name} · ${r.Sender}` : r.Sender], ["Sender type", [r.Sender_Type, r.Sender_Category].filter(Boolean).join(" / ")],
    ["Ask", money(r.Ask)], ["Your quote", money(r.Your_Quote)],
    ["Sale 1", r.Sale1_Price ? `${money(r.Sale1_Price)} on ${r.Sale1_Date}${r.Days_To_Sale ? ` (${r.Days_To_Sale} days after pitch)` : ""}` : "—"],
    ["Sale 2", r.Sale2_Price ? `${money(r.Sale2_Price)} on ${r.Sale2_Date}${r.Hold_Mo ? ` · ${r.Hold_Mo} mo hold` : ""}` : "—"],
    ["Gross / est. net", r.Gross ? `${money(r.Gross)} / ${money(r.Est_Net)}${r.Annualized ? ` (${r.Annualized}%/yr, ${r.Tier})` : ""}` : "—"],
    ["Verdict", r.Verdict || "—"], ["Buyer", r.Buyer ? `${r.Buyer} (${r.Buyer_Type})` : "—"], ["Listing agent", r.Listing_Agent || "—"],
    ["Confidence / sources", [r.Conf, r.Sources].filter(Boolean).join(" · ") || "—"], ["Tag rule", r.Tag_Rules || "—"],
    ["Other senders", r.Other_Senders || "—"], ["Notes from trace", r.Note || "—"],
  ]
  async function submit() {
    if (!body.trim()) return
    setBusy(true); setErr(null)
    try { await addNote(r.Address, body); setBody("") } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }
  return (
    <div className="grid gap-4 border-t border-zinc-800/70 bg-zinc-900/40 px-3 py-3 md:grid-cols-2">
      <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 text-sm">
        {facts.map(([k, v]) => (<><dt key={k + "k"} className="text-zinc-500">{k}</dt><dd key={k + "v"} className="text-zinc-200 break-words">{v}</dd></>))}
      </dl>
      <div>
        <div className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">Your comments</div>
        <div className="space-y-2">
          {notes.map(n => (
            <div key={n.id} className="group rounded-md border border-zinc-800 bg-zinc-950 p-2 text-sm text-zinc-200">
              <div className="whitespace-pre-wrap">{n.body}</div>
              <div className="mt-1 flex items-center justify-between text-[11px] text-zinc-500">
                <span>{new Date(n.created_at).toLocaleString()}</span>
                <button onClick={() => removeNote(n.id)} className="opacity-0 hover:text-red-300 group-hover:opacity-100">delete</button>
              </div>
            </div>
          ))}
          {notes.length === 0 && <div className="text-xs text-zinc-600">No comments yet.</div>}
        </div>
        <textarea value={body} onChange={e => setBody(e.target.value)} rows={3} placeholder="Add a comment — what you remember about this one, what to do next…"
          className="mt-2 w-full rounded-md border border-zinc-800 bg-zinc-950 p-2 text-sm text-zinc-100 placeholder:text-zinc-600"
          onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit() }} />
        <div className="mt-1 flex items-center gap-2">
          <button onClick={submit} disabled={busy || !body.trim()} className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-zinc-950 disabled:opacity-40">{busy ? "Saving…" : "Save comment"}</button>
          <span className="text-[11px] text-zinc-600">⌘↩ to save</span>
          {err && <span className="text-xs text-red-300">{err}</span>}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Senders
function Senders({ data }: { data: DealFlowData }) {
  const [minSent, setMinSent] = useState(3)
  const rows = data.scorecard.filter(r => !r.Sender.startsWith("channel: ") && !r.Sender.startsWith("type: ") && (num(r.Sent) ?? 0) >= minSent)
  const types = data.scorecard.filter(r => r.Sender.startsWith("type: "))
  const fmt = (r: DealFlowScorecardRow) => [
    r.Name ? r.Name.replace(/\s*\[[^\]]+\]/g, "") : <span className="text-zinc-500">{r.Sender}</span>,
    r.Type || "—", r.Sent, r.Flipped, r.InProgress, r.SoldOnce, r.NeverSold, r.NotFound, pct(r["Traded%"]),
    r["Ask_vs_Actual_med%"] ? `${r["Ask_vs_Actual_med%"]}% (n=${r.n_ask})` : "—", r.Med_Days_To_Sale || "—",
  ]
  return (
    <div className="space-y-5">
      <Section title="By sender type" sub="Classified from each sender's full message history (agent signatures vs. assignment/off-market language) plus your Relationships category.">
        <Table head={["Type", "", "Sent", "Flipped", "In progress", "Sold once", "Never sold", "Not found", "Traded", "Ask vs actual", "Days to sale"]}
          rows={types.map(r => fmt({ ...r, Name: r.Sender.replace("type: ", ""), Type: "" }))} />
      </Section>
      <Section title="By sender" sub="Who actually sends deals that go somewhere. Phone-number rows are senders we couldn't name — fill them in via Relationships.">
        <label className="mb-2 block text-xs text-zinc-500">Min sent: <input type="number" min={1} value={minSent} onChange={e => setMinSent(Number(e.target.value) || 1)} className="ml-1 w-14 rounded border border-zinc-800 bg-zinc-900 px-1 py-0.5 text-zinc-200" /></label>
        <Table head={["Sender", "Type", "Sent", "Flipped", "In progress", "Sold once", "Never sold", "Not found", "Traded", "Ask vs actual", "Days to sale"]} rows={rows.map(fmt)} />
      </Section>
    </div>
  )
}

// ---------------------------------------------------------------- Investors
function Investors({ data }: { data: DealFlowData }) {
  const buyers = useMemo(() => {
    const m = new Map<string, DealFlowProperty[]>()
    for (const r of data.properties) {
      const b = r.Buyer?.replace(/\s+/g, " ").trim()
      if (!b || /owner-occupant|end user|\(new build\)/i.test(b)) continue
      m.set(b.toUpperCase(), [...(m.get(b.toUpperCase()) ?? []), r])
    }
    return Array.from(m.entries()).map(([k, L]: [string, DealFlowProperty[]]) => {
      const resold = L.filter(r => num(r.Sale2_Price))
      const avg = (f: (r: DealFlowProperty) => number | null) => { const v = resold.map(f).filter((x): x is number => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
      return { buyer: k, type: L[0].Buyer_Type, bought: L.length, resold: resold.length, hold: avg(r => num(r.Hold_Mo)), gross: avg(r => num(r.Gross)), net: avg(r => num(r.Est_Net)), props: L.map(r => `${r.Address}, ${r.City}`).join("; ") }
    }).sort((a, b) => b.bought - a.bought || (b.gross ?? -1e12) - (a.gross ?? -1e12))
  }, [data])
  const agents = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of data.properties) if (r.Listing_Agent) m.set(r.Listing_Agent, (m.get(r.Listing_Agent) ?? 0) + 1)
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1])
  }, [data])
  return (
    <div className="space-y-5">
      <Section title="Who bought the deals you passed on" sub="Every buyer on a traced deed, most active first. LLC/entity = investor; individuals are usually end users unless they resold.">
        <Table head={["Buyer", "Type", "Bought", "Resold", "Avg hold", "Avg gross", "Avg est. net", "Properties"]}
          rows={buyers.map(b => [b.buyer, b.type, String(b.bought), String(b.resold), b.hold === null ? "—" : `${b.hold.toFixed(1)} mo`, money(b.gross), money(b.net), <span key={b.buyer} className="text-xs text-zinc-500">{b.props}</span>])} />
      </Section>
      <Section title="Listing agents on the deals that traded" sub="Only captured where an MLS record was found — thin until the search layer finishes.">
        <Table head={["Agent", "Listings"]} rows={agents.map(([a, n]) => [a, String(n)])} />
      </Section>
    </div>
  )
}

// ---------------------------------------------------------------- bits
function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
      <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
      {sub && <p className="mb-3 mt-0.5 text-xs text-zinc-500">{sub}</p>}
      {!sub && <div className="mb-3" />}
      {children}
    </section>
  )
}
function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500">{head.map((h, i) => <th key={i} className="pb-1.5 pr-3 font-medium">{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-zinc-800/70 text-zinc-300">
              {r.map((c, j) => <td key={j} className={`py-1.5 pr-3 align-top ${j === 0 ? "text-zinc-100" : ""}`}>{c}</td>)}
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={head.length} className="py-3 text-center text-zinc-600">No rows.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}
