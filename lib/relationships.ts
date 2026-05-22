// Shared Relationships-tab (Book of Business) logic. Backed by the Supabase
// `relationships` table since the 2026-05-22 migration off the BoB Google
// Sheet (briefs/RELATIONSHIPS_SUPABASE_MIGRATION.md). The cadence constants
// and interleave() were previously copy-pasted across app/api/crms/contacts
// and all-contacts — single source of truth lives here now.

import type { SupabaseClient } from "@supabase/supabase-js"
import type { RelationshipCategory } from "@/lib/crms"
import { normalizeCategory } from "@/lib/crms"

// Cadence days by tier — how long after the last touch a contact is "due".
export const CADENCE: Record<string, number> = { A: 30, B: 45, C: 60, D: 365 }

// Per-category daily queue targets. PM/Investor/Seller never surface
// proactively (target 0); Agent backfills any shortfall.
export const DAILY_TARGETS: Record<RelationshipCategory, number> = {
  Agent: 10, Vendor: 3, Personal: 2, PM: 0, Investor: 0, PrivateMoney: 3, Seller: 0,
}

export const RELATIONSHIP_TYPES: readonly RelationshipCategory[] = [
  "Agent", "Vendor", "Personal", "PM", "Investor", "PrivateMoney", "Seller",
] as const

// Column list for `select()` against the relationships table.
export const REL_COLUMNS =
  "id, name, phone, email, source, category, tier, notes, enriched_at, last_contacted_at, snooze_until, source_lead_id"

// A row as stored in Supabase `relationships`.
export interface RelationshipRow {
  id: string
  name: string
  phone: string | null
  email: string | null
  source: string | null
  category: string
  tier: string
  notes: string | null
  enriched_at: string | null
  last_contacted_at: string | null
  snooze_until: string | null
  source_lead_id: string | null
}

// The shape the Relationships-tab UI consumes. Kept identical to the old
// sheet-backed response except `id` is now a UUID and `sheetRow` is gone.
export interface ApiContact {
  id: string
  name: string
  phone: string
  email: string | null
  tier: string
  type: RelationshipCategory
  category: RelationshipCategory
  lastContact: string
  lastContacted: string
  daysOverdue: number
  status: "due" | "overdue"
  notes: string
  hasNotes: boolean
  notesStale: boolean
}

export function daysSince(date: Date | null): number {
  if (!date) return 9999
  return Math.floor((Date.now() - date.getTime()) / 86400000)
}

// E.164 (or anything) → bare 10-digit, matching the phone format the old
// sheet-backed API returned and that the sidecar / modality-prefs expect.
export function to10Digit(phone: string | null): string {
  const d = String(phone ?? "").replace(/\D/g, "")
  return d.length >= 10 ? d.slice(-10) : d
}

function humanDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

// Map a DB row → the UI contact shape, computing cadence-derived fields.
export function toApiContact(row: RelationshipRow): ApiContact {
  const type = normalizeCategory(row.category)
  const tier = (row.tier || "C").trim().toUpperCase()
  const lastDate = row.last_contacted_at ? new Date(row.last_contacted_at) : null
  const daysSinceLast = daysSince(lastDate)
  const cadenceDays = CADENCE[tier] ?? 45
  const daysOverdue = Math.max(0, daysSinceLast - cadenceDays)
  const notes = (row.notes ?? "").trim()
  const hasNotes = notes.length > 0
  // Staleness mirrors the old [enriched: DATE] behavior: only a contact that
  // WAS enriched, >90 days ago, is stale. Hand-typed notes (no enriched_at)
  // are never flagged.
  const enrichedAt = row.enriched_at ? new Date(row.enriched_at) : null
  const notesStale = hasNotes && !!enrichedAt && daysSince(enrichedAt) > 90
  return {
    id: row.id,
    name: row.name,
    phone: to10Digit(row.phone),
    email: row.email,
    tier,
    type,
    category: type,
    lastContact: lastDate ? `${daysSinceLast}d ago` : "never",
    lastContacted: lastDate ? humanDate(lastDate) : "",
    daysOverdue,
    status: daysOverdue > 0 ? "overdue" : "due",
    notes,
    hasNotes,
    notesStale,
  }
}

export function emptyBuckets(): Record<RelationshipCategory, ApiContact[]> {
  return { Agent: [], Vendor: [], Personal: [], PM: [], Investor: [], PrivateMoney: [], Seller: [] }
}

// Weighted round-robin: repeatedly pick the bucket whose progress/target
// ratio is smallest. Naturally interleaves agents ~4x more often than
// vendors etc., matching DAILY_TARGETS.
export function interleave(buckets: Record<RelationshipCategory, ApiContact[]>): ApiContact[] {
  const cursors: Record<string, number> = {}
  for (const t of RELATIONSHIP_TYPES) cursors[t] = 0
  const out: ApiContact[] = []
  const totalRemaining = () =>
    RELATIONSHIP_TYPES.reduce((s, t) => s + Math.max(0, buckets[t].length - cursors[t]), 0)

  while (totalRemaining() > 0) {
    let bestType: RelationshipCategory | null = null
    let bestRatio = Infinity
    for (const t of RELATIONSHIP_TYPES) {
      if (cursors[t] >= buckets[t].length) continue
      const target = DAILY_TARGETS[t] || 1
      const ratio = cursors[t] / target
      if (ratio < bestRatio) { bestRatio = ratio; bestType = t }
    }
    if (!bestType) break
    out.push(buckets[bestType][cursors[bestType]])
    cursors[bestType]++
  }
  return out
}

// Fetch every relationships row. Supabase's PostgREST caps a single response
// at 1000 rows (db-max-rows) — `.limit()` can't raise that ceiling — so the
// full ~1k+ Book of Business must be paged in 1000-row windows, ordered by
// the unique id so page boundaries are stable.
export async function fetchAllRelationships(
  supabase: SupabaseClient,
): Promise<RelationshipRow[]> {
  const PAGE = 1000
  const out: RelationshipRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("relationships")
      .select(REL_COLUMNS)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    const rows = (data ?? []) as unknown as RelationshipRow[]
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}
