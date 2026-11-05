// Appointments on a lead (2026-11-05). Until now the Appointment milestone
// was only ever set by a tap on the card: a 31-minute seller call that ended
// "see you tomorrow at five" left the card without an appointment, nothing on
// the calendar, and the coach saying no meeting was set. Three ways in now,
// one write path:
//
//   • a call or text the analyzer read as ending in an agreed meeting
//     (bookAppointmentFromAnalysis, called by the analyzer's persisters)
//   • a Telegram message that names a lead ("appointment with Dana at 12 Oak
//     St tomorrow 5pm") — findLeadForEvent links the event to the card
//   • the card's own milestone tap (app/api/leads/[id]/milestone)
//
// appointment_at stays the funnel milestone (a date at noon UTC, so the
// Pacific day is stable); appointment_details carries the time, place and
// the calendar event the Undo button removes.
//
// Server only — this imports lib/leads, which must never reach the browser.

import type { SupabaseClient } from "@supabase/supabase-js"
import { createCalendarEvent, deleteCalendarEvent, formatWhen } from "@/lib/calendarIntake"
import { applyStatusChange, fetchClusterRows, stampBecameLead, statusAnchor } from "@/lib/leadStatus"
import { clusterKeyOrId, getLeadsClient, sendTelegramAlert } from "@/lib/leads"
import { formatPhone } from "@/lib/utils"
import { pacificDayOf, pacificRfc3339, type AnalyzedAppointment } from "@/lib/appointmentTime"

export { parseAnalyzedAppointment, pacificDayOf, pacificRfc3339, type AnalyzedAppointment } from "@/lib/appointmentTime"

export const APPT_UNDO_PREFIX = "apptundo:"
export const CAL_UNDO_PREFIX = "calundo:"

export interface AppointmentDetails {
  /** RFC3339 with the Pacific offset. */
  start: string
  end: string | null
  location: string | null
  with: string | null
  event_id: string | null
  html_link: string | null
  source: "call" | "text" | "telegram"
  set_at: string
}

function plusOneHour(start: string): string {
  // Same offset text, one hour later on the wall clock.
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):00([+-]\d{2}:\d{2})$/.exec(start)
  if (!m) return start
  const end = new Date(new Date(start).getTime() + 3600_000)
  const offMin = (m[4].startsWith("-") ? -1 : 1) * (Number(m[4].slice(1, 3)) * 60 + Number(m[4].slice(4, 6)))
  const wall = new Date(end.getTime() + offMin * 60_000).toISOString()
  return `${wall.slice(0, 10)}T${wall.slice(11, 16)}:00${m[4]}`
}

interface ClusterSeed { id: string; caller_phone: string | null; email: string | null; gmail_thread_id?: string | null }

async function seedRow(sb: SupabaseClient, leadId: string): Promise<ClusterSeed | null> {
  const { data, error } = await sb.from("leads").select("id, caller_phone, email, gmail_thread_id").eq("id", leadId).maybeSingle()
  if (error) throw new Error(`lead read failed: ${error.message}`)
  return (data as ClusterSeed | null) ?? null
}

/** Put an appointment on every row of the person: the milestone date, the
 *  details, "ever a lead", and Active unless they are DNC. Never throws on
 *  the details write — the column may not exist yet on an old schema. */
export async function setClusterAppointment(
  sb: SupabaseClient,
  leadId: string,
  a: { date: string; details: AppointmentDetails | null },
): Promise<{ ok: boolean; name: string | null; error?: string }> {
  try {
    const seed = await seedRow(sb, leadId)
    if (!seed) return { ok: false, name: null, error: "lead not found" }
    const rows = await fetchClusterRows(sb, seed)
    const ids = rows.map((r) => r.id)
    const { error } = await sb.from("leads").update({ appointment_at: `${a.date}T12:00:00Z` }).in("id", ids)
    if (error) return { ok: false, name: null, error: error.message }
    const { error: dErr } = await sb.from("leads").update({ appointment_details: a.details }).in("id", ids)
    if (dErr) console.error(`[appointments] appointment_details write failed (${leadId}): ${dErr.message}`)
    await stampBecameLead(sb, rows)
    const anchor = statusAnchor(rows)
    if (anchor && !rows.some((r) => r.is_dnc) && anchor.status !== "active") {
      await applyStatusChange(sb, { rows, anchor, to: "active", source: "milestone", reason: `appointment set ${a.date}${a.details ? ` (${a.details.source})` : ""}` })
    }
    return { ok: true, name: clusterName(rows) }
  } catch (e) {
    return { ok: false, name: null, error: e instanceof Error ? e.message : String(e) }
  }
}

function clusterName(rows: { name?: string | null; created_at: string }[]): string | null {
  const newestFirst = [...rows].sort((x, y) => new Date(y.created_at).getTime() - new Date(x.created_at).getTime())
  return newestFirst.map((r) => (r.name ?? "").trim()).find(Boolean) || null
}

/** The stored details of a person's appointment, if any. */
async function readDetails(sb: SupabaseClient, ids: string[]): Promise<AppointmentDetails | null> {
  const { data, error } = await sb.from("leads").select("appointment_details").in("id", ids).not("appointment_details", "is", null).limit(1)
  if (error) return null
  return ((data?.[0] as { appointment_details?: AppointmentDetails } | undefined)?.appointment_details) ?? null
}

/** The person's current appointment: its Pacific day and, when it was
 *  booked with a time and place, the details. null when there is none. */
export async function getClusterAppointment(sb: SupabaseClient, leadId: string): Promise<{ date: string; details: AppointmentDetails | null } | null> {
  try {
    const seed = await seedRow(sb, leadId)
    if (!seed) return null
    const rows = await fetchClusterRows(sb, seed)
    const at = rows.map((r) => r.appointment_at).find((v): v is string => !!v)
    if (!at) return null
    return { date: at.slice(0, 10), details: await readDetails(sb, rows.map((r) => r.id)) }
  } catch (e) {
    console.error("[appointments] appointment read failed:", e instanceof Error ? e.message : String(e))
    return null
  }
}

/** Undo: take the appointment off the card and delete its calendar event.
 *  The label is what the Telegram toast / reply says. */
export async function undoAppointment(sb: SupabaseClient, leadId: string): Promise<{ ok: boolean; label: string }> {
  try {
    const seed = await seedRow(sb, leadId)
    if (!seed) return { ok: false, label: "lead not found" }
    const rows = await fetchClusterRows(sb, seed)
    const name = clusterName(rows) ?? "the lead"
    if (!rows.some((r) => r.appointment_at)) return { ok: false, label: `no appointment on ${name}'s card` }
    const ids = rows.map((r) => r.id)
    const details = await readDetails(sb, ids)
    const { error } = await sb.from("leads").update({ appointment_at: null }).in("id", ids)
    if (error) return { ok: false, label: error.message }
    const { error: dErr } = await sb.from("leads").update({ appointment_details: null }).in("id", ids)
    if (dErr) console.error(`[appointments] appointment_details clear failed (${leadId}): ${dErr.message}`)
    if (!details?.event_id) return { ok: true, label: `appointment removed from ${name}'s card. No calendar event was tied to it; if one exists, delete it by hand` }
    const del = await deleteCalendarEvent(details.event_id)
    return {
      ok: true,
      label: del.success
        ? `appointment removed from ${name}'s card and your calendar`
        : `appointment removed from ${name}'s card. The calendar event is still there (${del.error})${details.html_link ? `: ${details.html_link}` : ""}`,
    }
  } catch (e) {
    return { ok: false, label: e instanceof Error ? e.message : String(e) }
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** A conversation ended in an agreed meeting: calendar event, card, and a
 *  Telegram card with Undo. Skips quietly when the person already has an
 *  appointment that day (a re-analysis, or the "Friday works" confirmation
 *  text), is DNC, or the time has already passed. Never throws. */
export async function bookAppointmentFromAnalysis(leadId: string, appt: AnalyzedAppointment, source: "call" | "text"): Promise<"booked" | "skipped" | "failed"> {
  try {
    const start = pacificRfc3339(appt.date, appt.time)
    if (!start) return "skipped"
    if (new Date(start).getTime() < Date.now() - 5 * 60_000) {
      console.log(`[appointments] lead ${leadId}: meeting time ${start} is already past — not booking`)
      return "skipped"
    }
    const sb = getLeadsClient()
    const { data: row, error } = await sb.from("leads").select("id, caller_phone, email, gmail_thread_id, property_address").eq("id", leadId).maybeSingle()
    if (error || !row) return "failed"
    const rows = await fetchClusterRows(sb, row as ClusterSeed)
    if (rows.some((r) => r.is_dnc)) return "skipped"
    if (rows.some((r) => (r.appointment_at ?? "").slice(0, 10) === appt.date)) {
      console.log(`[appointments] lead ${leadId}: already has an appointment on ${appt.date} — not booking twice`)
      return "skipped"
    }
    const name = clusterName(rows)
    const phone = (row.caller_phone as string | null) ?? null
    const who = appt.with || name || (phone ? formatPhone(phone) ?? phone : "seller")
    const place = appt.location || (row.property_address as string | null) || null
    const end = plusOneHour(start)
    const description = [
      appt.about,
      `Lead: ${[name, phone ? formatPhone(phone) ?? phone : null].filter(Boolean).join(" · ") || "unknown"}`,
      row.property_address ? `Property: ${row.property_address}` : null,
      `Booked automatically from the ${source} on ${pacificDayOf(new Date().toISOString())}.`,
    ].filter(Boolean).join("\n")
    const created = await createCalendarEvent({
      summary: `Appointment - ${place ? place.split(",")[0] : "seller"} with ${who}`,
      start, end, allDay: false, location: place, description, question: null,
    })
    const set = await setClusterAppointment(sb, leadId, {
      date: appt.date,
      details: { start, end, location: place, with: appt.with, event_id: created.id ?? null, html_link: created.htmlLink ?? null, source, set_at: new Date().toISOString() },
    })
    if (!set.ok) {
      await sendTelegramAlert(`⚠️ Appointment not saved — ${esc(name ?? leadId)}: ${esc(set.error ?? "unknown error")}. ${created.success ? "The calendar event was created." : ""}`)
      return "failed"
    }
    const lines = [
      `📅 <b>Appointment set</b> — ${esc(name ?? who)}`,
      esc(formatWhen({ start, end, allDay: false })),
      ...(place ? [`📍 ${esc(place)}`] : []),
      ...(appt.with && appt.with !== name ? [`With: ${esc(appt.with)}`] : []),
      "",
      created.success
        ? `Picked up from your ${source}. It's on the lead card and your calendar.`
        : `Picked up from your ${source}. It's on the lead card. ⚠️ The calendar add failed (${esc(created.error ?? "unknown")}), so add it by hand or send "cal: …".`,
    ]
    await sendTelegramAlert(lines.join("\n"), {
      buttons: [[
        { text: "↩️ Undo", data: `${APPT_UNDO_PREFIX}${leadId}` },
        ...(created.htmlLink ? [{ text: "Open in Calendar", url: created.htmlLink }] : []),
      ]],
    })
    return "booked"
  } catch (e) {
    console.error(`[appointments] booking threw for ${leadId}:`, e instanceof Error ? e.message : String(e))
    // Silent-failure rule: a lost appointment must reach Telegram.
    await sendTelegramAlert(`⚠️ A meeting was set on a ${source} but I couldn't book it (lead ${leadId}): ${esc(e instanceof Error ? e.message : String(e))}`).catch(() => {})
    return "failed"
  }
}

// ── Telegram event → lead card ──────────────────────────────────────────────

const STREET_NOISE = new Set([
  "street", "st", "drive", "dr", "court", "ct", "avenue", "ave", "road", "rd", "lane", "ln", "way", "boulevard", "blvd",
  "place", "pl", "circle", "cir", "terrace", "ter", "north", "south", "east", "west", "unit", "apt", "suite",
])

/** House number + street word out of free text: "265 Maple Court San Jose"
 *  → { number: "265", street: "maple" }. */
export function streetKey(text: string | null | undefined): { number: string; street: string } | null {
  const m = /\b(\d{1,6})\s+((?:[NSEW]\.?\s+)?[A-Za-z][A-Za-z'.-]*)/.exec(text ?? "")
  if (!m) return null
  const street = m[2].replace(/^[NSEW]\.?\s+/i, "").toLowerCase().replace(/[^a-z]/g, "")
  if (street.length < 3 || STREET_NOISE.has(street)) return null
  return { number: m[1], street }
}

export interface LeadCandidate {
  key: string
  leadId: string
  name: string
  newestAt: number
  addresses: string[]
}

/** Pure: which lead does a Telegram event belong to? Address agreement
 *  wins; with no address match, a first name only links when exactly one
 *  recent lead carries it. null = don't guess. */
export function pickLeadForEvent(
  candidates: LeadCandidate[],
  event: { person: string | null; location: string | null; summary: string | null },
  now: number = Date.now(),
): LeadCandidate | null {
  if (!candidates.length) return null
  const key = streetKey(event.location) ?? streetKey(event.summary)
  if (key) {
    const hits = candidates.filter((c) =>
      c.addresses.some((a) => {
        const k = a.toLowerCase()
        return new RegExp(`\\b${key.number}\\b`).test(k) && k.replace(/[^a-z0-9 ]/g, "").includes(key.street)
      }),
    )
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) return null
    // A street word the card has, on a different house number (the seller's
    // other house next door, or a misheard number): still one person.
    const streetOnly = candidates.filter((c) => c.addresses.some((a) => a.toLowerCase().replace(/[^a-z0-9 ]/g, "").includes(key.street)))
    if (streetOnly.length === 1) return streetOnly[0]
    if (streetOnly.length > 1) return null
  }
  const recent = candidates.filter((c) => now - c.newestAt <= 30 * 86_400_000)
  return recent.length === 1 ? recent[0] : null
}

/** Find the lead a Telegram calendar event is about, by the person's first
 *  name and the address. Read-only. */
export async function findLeadForEvent(
  sb: SupabaseClient,
  event: { person: string | null; location: string | null; summary: string | null },
): Promise<{ leadId: string; name: string } | null> {
  const first = (event.person ?? "").trim().split(/\s+/)[0]?.replace(/[^A-Za-z'-]/g, "") ?? ""
  if (first.length < 2) return null
  const since = new Date(Date.now() - 365 * 86_400_000).toISOString()
  const { data, error } = await sb
    .from("leads")
    .select("id, created_at, name, caller_phone, email, gmail_thread_id, property_address, property_details, is_dnc, is_junk")
    .ilike("name", `%${first}%`)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(300)
  if (error) {
    console.error("[appointments] lead lookup failed:", error.message)
    return null
  }
  const word = new RegExp(`\\b${first}\\b`, "i")
  const byKey = new Map<string, LeadCandidate & { blocked: boolean }>()
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const name = String(r.name ?? "")
    if (!word.test(name)) continue
    const key = clusterKeyOrId({ id: String(r.id), caller_phone: (r.caller_phone as string | null) ?? null, email: (r.email as string | null) ?? null, gmail_thread_id: (r.gmail_thread_id as string | null) ?? null })
    const at = new Date(String(r.created_at)).getTime()
    const addresses: string[] = []
    if (typeof r.property_address === "string" && r.property_address.trim()) addresses.push(r.property_address)
    if (Array.isArray(r.property_details)) {
      for (const d of r.property_details as Array<{ label?: unknown }>) if (typeof d?.label === "string" && d.label.trim()) addresses.push(d.label)
    }
    const blocked = r.is_dnc === true || r.is_junk === true
    const cur = byKey.get(key)
    if (!cur) byKey.set(key, { key, leadId: String(r.id), name, newestAt: at, addresses, blocked })
    else {
      cur.addresses.push(...addresses)
      cur.blocked = cur.blocked || blocked
    }
  }
  const picked = pickLeadForEvent(Array.from(byKey.values()).filter((c) => !c.blocked), event)
  return picked ? { leadId: picked.leadId, name: picked.name } : null
}
