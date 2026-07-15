import type { SupabaseClient } from "@supabase/supabase-js"
import type { BoardEvent, BoardEventType, BoardPeriod } from "@/lib/board"

// Server-side data access for The Board. Helpers take the supabase client as
// an argument (lib/relationships.ts convention) so routes and integration
// tests share the exact same paths.

export const PERIOD_COLUMNS = "id, label, starts_on, ends_on"
export const EVENT_COLUMNS = "id, period_id, event_type, occurred_on, payload, relationship_id, created_at"

/** Period containing dateKey; falls back to the most recent period. */
export async function fetchActivePeriod(
  supabase: SupabaseClient,
  dateKey: string
): Promise<BoardPeriod | null> {
  const containing = await supabase
    .from("board_periods")
    .select(PERIOD_COLUMNS)
    .lte("starts_on", dateKey)
    .gte("ends_on", dateKey)
    .order("starts_on", { ascending: false })
    .limit(1)
  if (containing.error) throw containing.error
  if (containing.data.length > 0) return containing.data[0] as BoardPeriod

  const latest = await supabase
    .from("board_periods")
    .select(PERIOD_COLUMNS)
    .order("ends_on", { ascending: false })
    .limit(1)
  if (latest.error) throw latest.error
  return (latest.data[0] as BoardPeriod) ?? null
}

/** Every event in the period. Pages in 1000-row windows — PostgREST caps
 *  single selects at 1000 and a 90-day block can exceed that. */
export async function fetchPeriodEvents(
  supabase: SupabaseClient,
  periodId: string
): Promise<BoardEvent[]> {
  const PAGE = 1000
  const all: BoardEvent[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("board_events")
      .select(EVENT_COLUMNS)
      .eq("period_id", periodId)
      .order("occurred_on", { ascending: true })
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    all.push(...(data as BoardEvent[]))
    if (data.length < PAGE) break
  }
  return all
}

export async function insertEvent(
  supabase: SupabaseClient,
  row: {
    period_id: string
    event_type: BoardEventType
    occurred_on: string
    payload: Record<string, unknown>
    relationship_id: string | null
  }
): Promise<BoardEvent> {
  const { data, error } = await supabase
    .from("board_events")
    .insert(row)
    .select(EVENT_COLUMNS)
    .single()
  if (error) throw error
  return data as BoardEvent
}

/** Returns false when the id didn't exist (double-tapped undo, etc.). */
export async function deleteEvent(supabase: SupabaseClient, id: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("board_events")
    .delete()
    .eq("id", id)
    .select("id")
  if (error) throw error
  return data.length > 0
}

/** Link / unlink a contact touch to a relationships row. */
export async function setEventRelationship(
  supabase: SupabaseClient,
  id: string,
  relationshipId: string | null
): Promise<BoardEvent | null> {
  const { data, error } = await supabase
    .from("board_events")
    .update({ relationship_id: relationshipId })
    .eq("id", id)
    .select(EVENT_COLUMNS)
  if (error) throw error
  return (data[0] as BoardEvent) ?? null
}
