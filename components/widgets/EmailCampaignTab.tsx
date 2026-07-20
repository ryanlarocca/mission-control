"use client"

import { useCallback, useEffect, useRef, useState } from "react"

// Agent email-drip campaign workspace (Phase 3 of
// briefs/EMAIL_DRIP_CAMPAIGN_2026-07-17.md). Mirrors the mockup Ryan
// approved 2026-07-17: Review queue (line items + summary, expand for full
// email, inline edit, batch approve) and Contacts (search + per-contact
// timeline + pause/resume/DNC). Engagement tab lands with Phase 5.
//
// Approving IS the send authorization: the Mac-mini engine's next pass
// sends approved rows inside the 9:00a–4:30p window with jitter. Nothing
// sends from the browser.

interface QueueSend {
  id: string
  touch_number: number
  subject: string
  body: string
  status: string
  edited: boolean
  error: string | null
  created_at: string
  contact: {
    id: string
    name: string | null
    email: string | null
    import_flags: string[]
    property_address: string | null
  } | null
}

interface QueueCounts {
  draft: number
  approved: number
  sent_today: number
  failed: number
  active_contacts: number
  due_contacts: number
}

interface ContactRow {
  id: string
  name: string | null
  email: string | null
  phone: string | null
  phone_bad: boolean
  status: string
  touch_number: number
  next_touch_at: string | null
  last_sent_at: string | null
  import_flags: string[]
  property_address: string | null
}

interface ContactDetail {
  contact: ContactRow & { crm_notes: string | null; alt_emails: string[] }
  sends: { id: string; touch_number: number; subject: string; status: string; sent_at: string | null; created_at: string; edited: boolean }[]
  events: { id: string; kind: string; body: string | null; ai_summary: string | null; triage: string | null; occurred_at: string }[]
}

const STATUS_BADGE: Record<string, string> = {
  active: "bg-emerald-950 text-emerald-300",
  paused: "bg-amber-950 text-amber-300",
  replied: "bg-sky-950 text-sky-300",
  bounced: "bg-red-950 text-red-300",
  unsubscribed: "bg-red-950 text-red-300",
  suppressed: "bg-red-950 text-red-300",
  bad_email: "bg-zinc-800 text-zinc-400",
  no_email: "bg-zinc-800 text-zinc-400",
  draft: "bg-sky-950 text-sky-300",
  approved: "bg-emerald-950 text-emerald-300",
  sent: "bg-zinc-800 text-zinc-400",
  failed: "bg-red-950 text-red-300",
  skipped: "bg-zinc-800 text-zinc-500",
}

function Badge({ children, tone }: { children: React.ReactNode; tone: string }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10.5px] font-semibold tracking-wide ${STATUS_BADGE[tone] ?? "bg-zinc-800 text-zinc-400"}`}>
      {children}
    </span>
  )
}

const EVENT_ICON: Record<string, string> = {
  email_out: "📤",
  email_reply: "✉️",
  sms_in: "💬",
  sms_out: "💬",
  call_answered: "📞",
  call_missed: "📞",
  voicemail: "🎙",
  note: "📝",
  bounce: "↩️",
  unsubscribe: "🚫",
}

export function EmailCampaignTab() {
  const [view, setView] = useState<"queue" | "contacts">("queue")
  const [toast, setToast] = useState("")
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ping = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(""), 2500)
  }, [])

  // ---------- queue state ----------
  const [sends, setSends] = useState<QueueSend[]>([])
  const [counts, setCounts] = useState<QueueCounts | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [openId, setOpenId] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; subject: string; body: string } | null>(null)
  const [loadingQueue, setLoadingQueue] = useState(true)
  const [busy, setBusy] = useState(false)

  const loadQueue = useCallback(async () => {
    try {
      const res = await fetch("/api/campaign/queue?status=pending", { cache: "no-store" })
      if (!res.ok) throw new Error(`${res.status}`)
      const data = await res.json()
      setSends(data.sends ?? [])
      setCounts(data.counts ?? null)
      setSelected((prev) => {
        const drafts = new Set<string>((data.sends ?? []).filter((s: QueueSend) => s.status === "draft").map((s: QueueSend) => s.id))
        return new Set(Array.from(prev).filter((id) => drafts.has(id)))
      })
    } catch {
      ping("Couldn't load the queue — retry")
    } finally {
      setLoadingQueue(false)
    }
  }, [ping])

  useEffect(() => {
    void loadQueue()
  }, [loadQueue])

  const drafts = sends.filter((s) => s.status === "draft")
  const approved = sends.filter((s) => s.status === "approved")

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const approveSelected = async () => {
    if (selected.size === 0 || busy) return
    setBusy(true)
    try {
      const res = await fetch("/api/campaign/approve-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selected) }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `${res.status}`)
      ping(`✓ ${data.approved} queued — engine sends 9:00a–4:30p with spacing`)
      setSelected(new Set())
      await loadQueue()
    } catch (e) {
      ping(`Approve failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(false)
    }
  }

  const rowAction = async (id: string, action: "skip" | "approve" | "unapprove") => {
    try {
      const res = await fetch(`/api/campaign/sends/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      })
      if (!res.ok) throw new Error(`${res.status}`)
      ping(action === "skip" ? "Skipped — removed from this batch" : action === "approve" ? "✓ Queued for send" : "Back to draft")
      await loadQueue()
    } catch {
      ping("Action failed — retry")
    }
  }

  const saveEdit = async () => {
    if (!editing) return
    try {
      const res = await fetch(`/api/campaign/sends/${editing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: editing.subject, body: editing.body }),
      })
      if (!res.ok) throw new Error(`${res.status}`)
      ping("✓ Draft updated")
      setEditing(null)
      await loadQueue()
    } catch {
      ping("Save failed — retry")
    }
  }

  // ---------- contacts state ----------
  const [q, setQ] = useState("")
  const [contacts, setContacts] = useState<ContactRow[]>([])
  const [buckets, setBuckets] = useState<Record<string, number>>({})
  const [total, setTotal] = useState(0)
  const [detail, setDetail] = useState<ContactDetail | null>(null)
  const [loadingContacts, setLoadingContacts] = useState(false)

  const loadContacts = useCallback(async (query: string) => {
    setLoadingContacts(true)
    try {
      const res = await fetch(`/api/campaign/contacts?q=${encodeURIComponent(query)}`, { cache: "no-store" })
      if (!res.ok) throw new Error(`${res.status}`)
      const data = await res.json()
      setContacts(data.contacts ?? [])
      setBuckets(data.buckets ?? {})
      setTotal(data.total ?? 0)
    } catch {
      ping("Couldn't load contacts")
    } finally {
      setLoadingContacts(false)
    }
  }, [ping])

  useEffect(() => {
    if (view !== "contacts") return
    const t = setTimeout(() => void loadContacts(q), q ? 300 : 0)
    return () => clearTimeout(t)
  }, [view, q, loadContacts])

  const openContact = async (id: string) => {
    try {
      const res = await fetch(`/api/campaign/contacts/${id}`, { cache: "no-store" })
      if (!res.ok) throw new Error(`${res.status}`)
      setDetail(await res.json())
    } catch {
      ping("Couldn't load contact")
    }
  }

  const contactAction = async (id: string, action: "pause" | "resume" | "dnc") => {
    if (action === "dnc" && !window.confirm("Add to master DNC? This stops ALL outreach everywhere.")) return
    try {
      const res = await fetch(`/api/campaign/contacts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      })
      if (!res.ok) throw new Error(`${res.status}`)
      ping(action === "dnc" ? "Added to master DNC — all outreach stopped" : action === "pause" ? "Removed from list + added to DNC" : "Back on the drip — DNC entry cleared")
      setDetail(null)
      await loadContacts(q)
    } catch {
      ping("Action failed — retry")
    }
  }

  // ---------- bulk list management (2026-07-20) ----------
  const [csel, setCsel] = useState<Set<string>>(new Set())
  const toggleCsel = (id: string) => {
    setCsel((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const bulkAction = async (action: "pause" | "resume") => {
    if (csel.size === 0) return
    try {
      const res = await fetch("/api/campaign/contacts/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(csel), action }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `${res.status}`)
      ping(action === "pause" ? `Removed ${data.changed} from the list + added to DNC` : `Re-added ${data.changed} — DNC entries cleared`)
      setCsel(new Set())
      await loadContacts(q)
    } catch (e) {
      ping(`Bulk action failed: ${e instanceof Error ? e.message : e}`)
    }
  }
  const togglable = (s: string) => s === "active" || s === "replied" || s === "paused"

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 text-zinc-100">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
        Agent outreach · sends as info@lrghomes.com · agents line (650) 910-4007
      </div>
      <h1 className="mb-4 text-xl font-semibold">Email Campaign</h1>

      {counts && (
        <div className="mb-5 flex flex-wrap gap-2">
          {[
            [counts.active_contacts, "active contacts"],
            [counts.due_contacts, "due for a touch"],
            [counts.draft, "drafts to review"],
            [counts.approved, "queued to send"],
            [`${counts.sent_today} / 200`, "sent today"],
            ...(counts.failed > 0 ? [[counts.failed, "failed ⚠"] as [number, string]] : []),
          ].map(([n, label]) => (
            <div key={String(label)} className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5">
              <div className="font-mono text-lg font-semibold">{n}</div>
              <div className="text-[11px] text-zinc-500">{label}</div>
            </div>
          ))}
        </div>
      )}

      <div className="mb-4 flex gap-1 border-b border-zinc-800">
        {(["queue", "contacts"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`px-3.5 py-2 text-sm font-semibold ${view === v ? "border-b-2 border-emerald-400 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
          >
            {v === "queue" ? `Review queue${drafts.length ? ` (${drafts.length})` : ""}` : "Contacts"}
          </button>
        ))}
        <span className="ml-auto self-center pb-1 text-[11px] text-zinc-600">Engagement tab arrives with reply tracking (Phase 5)</span>
      </div>

      {view === "queue" && (
        <div className="flex flex-col gap-2">
          <div className="mb-1 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 p-3">
            <button
              onClick={approveSelected}
              disabled={selected.size === 0 || busy}
              className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-40"
            >
              Queue {selected.size || ""} selected for send
            </button>
            <button
              onClick={() => setSelected(new Set(drafts.map((d) => d.id)))}
              disabled={drafts.length === 0}
              className="rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-300 disabled:opacity-40"
            >
              Select all {drafts.length}
            </button>
            <span className="text-xs text-zinc-500">
              Approved emails send automatically 9:00a–4:30p PT, spaced out — capped at 200/day.
              {approved.length > 0 && ` ${approved.length} currently queued.`}
            </span>
          </div>

          {loadingQueue && <div className="py-8 text-center text-sm text-zinc-500">Loading queue…</div>}
          {!loadingQueue && sends.length === 0 && (
            <div className="rounded-lg border border-dashed border-zinc-800 py-8 text-center text-sm text-zinc-500">
              No drafts waiting. The engine drafts due touches daily (200/day cap).
            </div>
          )}

          {sends.map((s) => {
            const flagged = s.contact?.import_flags?.includes("active_lead")
            const open = openId === s.id
            const isEditing = editing?.id === s.id
            return (
              <div key={s.id} className={`rounded-lg border bg-zinc-900 ${flagged ? "border-l-2 border-amber-500 border-y-zinc-800 border-r-zinc-800" : "border-zinc-800"}`}>
                <div
                  className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-zinc-800/50"
                  onClick={() => setOpenId(open ? null : s.id)}
                >
                  {s.status === "draft" ? (
                    <input
                      type="checkbox"
                      checked={selected.has(s.id)}
                      onChange={() => toggleSelect(s.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="h-4 w-4 accent-emerald-500"
                    />
                  ) : (
                    <span className="w-4 text-center text-emerald-400">✓</span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{s.contact?.name ?? "(unknown)"}</div>
                    <div className="truncate font-mono text-[11px] text-zinc-500">{s.contact?.email}</div>
                  </div>
                  <div className="hidden max-w-[38%] truncate text-xs text-zinc-500 md:block">{s.subject}</div>
                  <Badge tone="draft">T{s.touch_number}</Badge>
                  {flagged && <Badge tone="paused">⚠ active lead</Badge>}
                  {s.edited && <Badge tone="sent">edited</Badge>}
                  <Badge tone={s.status}>{s.status}</Badge>
                  <span className={`text-xs text-zinc-600 transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
                </div>
                {open && (
                  <div className="border-t border-zinc-800 px-4 py-3">
                    {isEditing ? (
                      <div className="flex flex-col gap-2">
                        <input
                          value={editing.subject}
                          onChange={(e) => setEditing({ ...editing, subject: e.target.value })}
                          className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                        />
                        <textarea
                          value={editing.body}
                          onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                          rows={10}
                          className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-[13px]"
                        />
                        <div className="flex gap-2">
                          <button onClick={saveEdit} className="rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-emerald-950">Save</button>
                          <button onClick={() => setEditing(null)} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm">Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="mb-2 max-w-2xl whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950 px-4 py-3 text-[13px] leading-relaxed text-zinc-300">
                          <div className="mb-2 font-semibold text-zinc-100">Subject: {s.subject}</div>
                          {s.body}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {s.status === "draft" && (
                            <button onClick={() => rowAction(s.id, "approve")} className="rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-emerald-950">
                              {flagged ? "Approve anyway" : "Approve"}
                            </button>
                          )}
                          {s.status === "approved" && (
                            <button onClick={() => rowAction(s.id, "unapprove")} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm">Back to draft</button>
                          )}
                          <button onClick={() => setEditing({ id: s.id, subject: s.subject, body: s.body })} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm">✎ Edit</button>
                          <button onClick={() => rowAction(s.id, "skip")} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-red-400">Skip this contact</button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {view === "contacts" && (
        <div>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${total || "…"} contacts by name, email, phone`}
            className="mb-2 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-sm placeholder:text-zinc-600"
          />
          <div className="mb-3 flex flex-wrap gap-1.5 text-[11px] text-zinc-500">
            {Object.entries(buckets)
              .filter(([, n]) => n > 0)
              .map(([s, n]) => (
                <span key={s} className="rounded-full border border-zinc-800 px-2 py-0.5">
                  {s.replace("_", " ")} <span className="font-mono">{n}</span>
                </span>
              ))}
          </div>
          {csel.size > 0 && (
            <div className="sticky top-2 z-10 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 p-2.5 shadow-lg">
              <span className="px-1 text-sm font-semibold">{csel.size} selected</span>
              <button onClick={() => void bulkAction("pause")} className="rounded-md bg-amber-500 px-3 py-1.5 text-sm font-semibold text-amber-950">
                ⏸ Remove from drip
              </button>
              <button onClick={() => void bulkAction("resume")} className="rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-emerald-950">
                ▶ Re-add to drip
              </button>
              <button onClick={() => setCsel(new Set())} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-400">
                Clear
              </button>
            </div>
          )}
          {loadingContacts && <div className="py-8 text-center text-sm text-zinc-500">Loading…</div>}
          <div className="flex flex-col gap-1.5">
            {contacts.map((c) => (
              <div key={c.id} className="rounded-lg border border-zinc-800 bg-zinc-900">
                <div
                  className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-zinc-800/50"
                  onClick={() => (detail?.contact.id === c.id ? setDetail(null) : void openContact(c.id))}
                >
                  {togglable(c.status) ? (
                    <input
                      type="checkbox"
                      checked={csel.has(c.id)}
                      onChange={() => toggleCsel(c.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="h-4 w-4 shrink-0 accent-emerald-500"
                      aria-label={`Select ${c.name ?? c.email}`}
                    />
                  ) : (
                    <span className="w-4 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{c.name ?? "(no name)"}</div>
                    <div className="truncate font-mono text-[11px] text-zinc-500">
                      {c.email ?? "—"}
                      {c.phone ? ` · ${c.phone}${c.phone_bad ? " ⚠" : ""}` : ""}
                    </div>
                  </div>
                  <Badge tone="sent">T{c.touch_number} of 11</Badge>
                  <Badge tone={c.status}>{c.status.replace("_", " ")}</Badge>
                  {(c.status === "active" || c.status === "replied") && (
                    <button
                      onClick={(e) => { e.stopPropagation(); void contactAction(c.id, "pause") }}
                      title="Remove from drip"
                      className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-amber-300 hover:bg-zinc-800"
                    >⏸</button>
                  )}
                  {c.status === "paused" && (
                    <button
                      onClick={(e) => { e.stopPropagation(); void contactAction(c.id, "resume") }}
                      title="Re-add to drip"
                      className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-emerald-300 hover:bg-zinc-800"
                    >▶</button>
                  )}
                </div>
                {detail?.contact.id === c.id && (
                  <div className="border-t border-zinc-800 px-4 py-3">
                    <ul className="mb-3 flex flex-col gap-1 text-[13px]">
                      {detail.events.length === 0 && detail.sends.length === 0 && (
                        <li className="text-zinc-500">No activity yet.</li>
                      )}
                      {[...detail.events.map((e) => ({
                        key: `e${e.id}`,
                        at: e.occurred_at,
                        text: `${EVENT_ICON[e.kind] ?? "•"} ${e.kind.replace("_", " ")}${e.ai_summary ? ` — ${e.ai_summary}` : e.body ? ` — ${e.body.slice(0, 120)}` : ""}`,
                      })), ...detail.sends.map((sd) => ({
                        key: `s${sd.id}`,
                        at: sd.sent_at ?? sd.created_at,
                        text: `${sd.status === "sent" ? "📤" : "📝"} T${sd.touch_number} ${sd.status} — ${sd.subject}${sd.edited ? " (edited)" : ""}`,
                      }))]
                        .sort((a, b) => (a.at < b.at ? 1 : -1))
                        .map((row) => (
                          <li key={row.key} className="flex gap-2 border-b border-dashed border-zinc-800/70 pb-1">
                            <span className="w-20 shrink-0 font-mono text-[11px] text-zinc-600">
                              {new Date(row.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                            </span>
                            <span className="text-zinc-300">{row.text}</span>
                          </li>
                        ))}
                    </ul>
                    {detail.contact.crm_notes && (
                      <details className="mb-3 text-[12px] text-zinc-500">
                        <summary className="cursor-pointer font-semibold">CRM history notes</summary>
                        <div className="mt-1 whitespace-pre-wrap">{detail.contact.crm_notes}</div>
                      </details>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {c.status === "active" ? (
                        <button onClick={() => contactAction(c.id, "pause")} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm">⏸ Pause drip</button>
                      ) : c.status === "paused" || c.status === "replied" ? (
                        <button onClick={() => contactAction(c.id, "resume")} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm">▶ Resume drip</button>
                      ) : null}
                      {c.status !== "suppressed" && c.status !== "unsubscribed" && (
                        <button onClick={() => contactAction(c.id, "dnc")} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-red-400">🚫 DNC</button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}
