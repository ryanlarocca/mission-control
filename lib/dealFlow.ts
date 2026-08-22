import type { SupabaseClient } from "@supabase/supabase-js"

// Deal Flow analysis types. The property/scorecard data is a static snapshot
// (data/deal-flow.json) exported from ~/Projects/PROJECTS/deal-analysis by
// `python3 build_final.py` + the export snippet in the changelog; notes are
// the only live table.

export type DealFlowProperty = {
  Address: string; City: string; ZIP: string; Cohort: string; Pitched: string
  Ask: string; Your_Quote: string
  Sale1_Price: string; Sale1_Date: string; Days_To_Sale: string
  Sale2_Price: string; Sale2_Date: string; Hold_Mo: string; Gross: string
  Tier: string; Est_Build: string; Est_Net: string; Annualized: string; Verdict: string
  Buyer: string; Buyer_Type: string; Listing_Agent: string
  Outcome: string; Conf: string; Sources: string
  Channel: string; VA_Sub: string; Blast: string
  Sender: string; Sender_Name: string; Sender_Type: string; Sender_Category: string; Other_Senders: string
  Bucket: string; Tag_Rules: string; City_Src: string; Trace: string; Note: string
}

export type DealFlowScorecardRow = {
  Sender: string; Sent: string; Flipped: string; InProgress: string; SoldOnce: string; Pending: string
  NeverSold: string; NotFound: string; NotTraced: string; Winners: string; "Traded%": string
  n_ask: string; "Ask_vs_Actual_med%": string; Med_Days_To_Sale: string; Gross_sum: string
  Name?: string; Type?: string; Category?: string; Channels?: string
}

export type DealFlowInvestor = {
  Buyer: string; Type: string; Bought: string; Resold: string; Avg_Hold_Mo: string; Avg_Gross: string; Properties: string
}

export type DealFlowData = {
  generated: string
  properties: DealFlowProperty[]
  scorecard: DealFlowScorecardRow[]
  investors: DealFlowInvestor[]
}

export type DealFlowNote = { id: string; address: string; body: string; created_at: string }

export const NOTE_COLUMNS = "id, address, body, created_at"

export async function fetchAllNotes(supabase: SupabaseClient): Promise<DealFlowNote[]> {
  const out: DealFlowNote[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("deal_flow_notes").select(NOTE_COLUMNS)
      .order("created_at", { ascending: true }).range(from, from + 999)
    if (error) throw error
    out.push(...(data as DealFlowNote[]))
    if (data.length < 1000) break
  }
  return out
}

export async function insertNote(supabase: SupabaseClient, address: string, body: string): Promise<DealFlowNote> {
  const { data, error } = await supabase
    .from("deal_flow_notes").insert({ address, body }).select(NOTE_COLUMNS).single()
  if (error) throw error
  return data as DealFlowNote
}

export async function deleteNote(supabase: SupabaseClient, id: string): Promise<void> {
  const { error } = await supabase.from("deal_flow_notes").delete().eq("id", id)
  if (error) throw error
}
