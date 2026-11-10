import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { MAIL_RECORD_LITE_COLUMNS, linkMailRecordToCluster, type MailRecordLite } from "@/lib/mailMatch"
import { clearMatchCredit, clusterOrFilter, creditMailPerson } from "@/lib/mailCredit"

// Manual lead ↔ mailed-record link from the card. Body { mail_record_id: uuid | null }.
// Writes the link to every row in the caller's cluster (phone / thread / email),
// then re-runs the mailer credit (lib/mailCredit). A relink to another house
// or an unlink first clears the match credit the old record gave (never line
// credit). An unlink is remembered (mail_match_method = 'rejected') so the
// auto-link doesn't put the same match back on the next call.
export const dynamic = "force-dynamic"

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  let body: { mail_record_id?: unknown } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const recordId = body.mail_record_id === null ? null : typeof body.mail_record_id === "string" ? body.mail_record_id : undefined
  if (recordId === undefined || (recordId && !/^[0-9a-f-]{36}$/i.test(recordId))) {
    return NextResponse.json({ error: "mail_record_id must be a uuid or null" }, { status: 400 })
  }
  try {
    const sb = getLeadsClient()
    const { data: lead, error: lErr } = await sb
      .from("leads")
      .select("id, caller_phone, email, gmail_thread_id, mail_record_id")
      .eq("id", params.id)
      .maybeSingle()
    if (lErr) return NextResponse.json({ error: lErr.message }, { status: 500 })
    if (!lead) return NextResponse.json({ error: "lead not found" }, { status: 404 })
    let record: MailRecordLite | null = null
    if (recordId) {
      const { data: rec, error: rErr } = await sb.from("mail_records").select(MAIL_RECORD_LITE_COLUMNS).eq("id", recordId).maybeSingle()
      if (rErr) return NextResponse.json({ error: rErr.message }, { status: 500 })
      if (!rec) return NextResponse.json({ error: "mail record not found" }, { status: 404 })
      record = rec as unknown as MailRecordLite
    }
    // The record the person is linked to now (any row of theirs).
    const { data: prev } = await sb
      .from("leads")
      .select("mail_record_id")
      .or(clusterOrFilter(lead))
      .not("mail_record_id", "is", null)
      .limit(1)
    const prevRecordId = (prev?.[0]?.mail_record_id as string | undefined) ?? null
    if (prevRecordId && prevRecordId !== recordId) {
      const { data: old } = await sb.from("mail_records").select("campaign_id").eq("id", prevRecordId).maybeSingle()
      if (old?.campaign_id) await clearMatchCredit(sb, lead, old.campaign_id as string)
    }
    const updated = await linkMailRecordToCluster(sb, lead, recordId, recordId ? "manual" : "rejected", null, record?.prior_pieces ?? null)
    if (recordId) await creditMailPerson(sb, lead.id)
    return NextResponse.json({ ok: true, updated, record })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

