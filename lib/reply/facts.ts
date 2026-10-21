// Coach mode, learning loop step 3 (briefs/BRIEF_COACHED_DRAFT_2026-10-15.md
// §F3): facts land on the card. After a coached draft is SENT, one Sonnet
// call over the gist + the final body pulls out the number Ryan stated and a
// one-line reasoning. Leads: offer_amount + offer_verbalized_at are stamped
// on the whole cluster (like stampLeadMoment) and a dated line goes on the
// card's notes. Relationships: the notes line only. Never throws — a missed
// fact must not fail a send.

import { completeText, extractJsonObject, SONNET, hasLlmKey } from "@/lib/llm"
import { getLeadsClient } from "@/lib/leads"

export interface CoachFacts {
  offer_amount: number | null
  reasoning: string | null
}

/** `[Coach 2026-10-15] At $950K; renovated comps $1.2–1.3M; he is at $1.6M.` */
export function coachNoteLine(date: string, reasoning: string): string {
  const line = reasoning.replace(/\s+/g, " ").trim().replace(/[.]+$/, "")
  return `[Coach ${date}] ${line}.`
}

export function appendNote(existing: string | null | undefined, line: string): string {
  const prev = (existing || "").trim()
  return prev ? `${prev}\n${line}` : line
}

/** Sonnet: what did this coached message establish? Exported for the dry run. */
export async function extractCoachFacts(args: { gist: string; body: string; kind: "lead" | "relationship"; name?: string | null; property?: string | null }): Promise<CoachFacts | null> {
  if (!hasLlmKey()) return null
  const prompt = `Ryan (a cash home buyer in the Bay Area) dictated a gist to an assistant and then sent the message below${args.name ? ` to ${args.name}` : ""}${args.property ? ` about ${args.property}` : ""}. Pull out the facts the card should remember.

RYAN'S GIST (rough speech)
"""
${args.gist.trim()}
"""

THE MESSAGE HE SENT
"""
${args.body.trim()}
"""

Return JSON only:
{
  "offer_amount": number | null,
  "reasoning": string | null
}

RULES
- offer_amount: the purchase price Ryan stated to THIS ${args.kind === "lead" ? "seller" : "contact"} in the message, as a plain number of dollars (950000, not "950K"). A comp, an appraisal, their asking price, or a number Ryan only mentioned as theirs is NOT his offer. Ranges → the midpoint. No figure stated by Ryan → null.
- reasoning: ONE line, under 160 characters, in note shorthand, with what the message establishes: his number if any, the reasoning behind it, and their stated position. Example shape: "At $950K; renovated comps $1.2–1.3M; he is at $1.6M." If the message establishes nothing worth a note (a thank-you, a scheduling line), return null.
- Never invent. Only what the gist and the message say.`
  try {
    const out = await completeText({ model: SONNET, prompt, maxTokens: 300, thinking: false, tag: "[reply/facts]" })
    const parsed = JSON.parse(extractJsonObject(out.text)) as { offer_amount?: unknown; reasoning?: unknown }
    const offer = typeof parsed.offer_amount === "number" && Number.isFinite(parsed.offer_amount) && parsed.offer_amount > 0 ? Math.round(parsed.offer_amount) : null
    const reasoning = typeof parsed.reasoning === "string" && parsed.reasoning.trim() ? parsed.reasoning.trim() : null
    return { offer_amount: offer, reasoning }
  } catch (e) {
    console.warn("[reply/facts] extraction failed:", e instanceof Error ? e.message : String(e))
    return null
  }
}

interface CoachDraftRow {
  id: string
  mode: string | null
  gist: string | null
  lead_id: string | null
  relationship_id: string | null
}

/** Called by markDraftSent. Loads the draft; does nothing unless it is a
 *  coached draft with a gist. */
export async function landCoachFacts(draftId: string, sentBody: string): Promise<void> {
  if (!draftId || !sentBody.trim()) return
  try {
    const sb = getLeadsClient()
    // Own select so a database without the coach columns just returns an
    // error here and the send carries on.
    const { data: d, error } = await sb.from("reply_drafts").select("id, mode, gist, lead_id, relationship_id").eq("id", draftId).maybeSingle<CoachDraftRow>()
    if (error || !d || d.mode !== "coach" || !(d.gist || "").trim()) return
    const today = new Date().toISOString().slice(0, 10)

    if (d.lead_id) {
      const { data: anchor } = await sb.from("leads").select("id, name, property_address, caller_phone, email").eq("id", d.lead_id).maybeSingle<{ id: string; name: string | null; property_address: string | null; caller_phone: string | null; email: string | null }>()
      if (!anchor) return
      const facts = await extractCoachFacts({ gist: d.gist!, body: sentBody, kind: "lead", name: anchor.name, property: anchor.property_address })
      if (!facts) return
      // The cluster, the way buildLeadContext finds it.
      let q = sb.from("leads").select("id, notes, twilio_number, created_at").order("created_at", { ascending: false }).limit(60)
      if (anchor.caller_phone) q = q.eq("caller_phone", anchor.caller_phone)
      else if (anchor.email) q = q.eq("email", anchor.email)
      else q = q.eq("id", anchor.id)
      const { data: rowsRaw } = await q.returns<{ id: string; notes: string | null; twilio_number: string | null; created_at: string }[]>()
      const rows = rowsRaw && rowsRaw.length ? rowsRaw : [{ id: anchor.id, notes: null, twilio_number: null, created_at: "" }]
      const ids = rows.map((r) => r.id)
      if (facts.offer_amount != null) {
        const { error: offErr } = await sb.from("leads").update({ offer_amount: facts.offer_amount, offer_verbalized_at: new Date().toISOString() }).in("id", ids)
        if (offErr) console.error("[reply/facts] offer stamp failed:", offErr.message)
        else console.log(`[reply/facts] coached send stamped offer $${facts.offer_amount} on ${ids.length} row(s)`)
      }
      if (facts.reasoning) {
        // The card shows the newest inbound row's notes (LeadsTab statusSource).
        const target = rows.find((r) => r.twilio_number) ?? rows[0]
        const { error: noteErr } = await sb.from("leads").update({ notes: appendNote(target.notes, coachNoteLine(today, facts.reasoning)) }).eq("id", target.id)
        if (noteErr) console.error("[reply/facts] note append failed:", noteErr.message)
      }
      return
    }

    if (d.relationship_id) {
      const { data: r } = await sb.from("relationships").select("id, name, notes").eq("id", d.relationship_id).maybeSingle<{ id: string; name: string | null; notes: string | null }>()
      if (!r) return
      const facts = await extractCoachFacts({ gist: d.gist!, body: sentBody, kind: "relationship", name: r.name })
      if (!facts?.reasoning) return
      const { error: noteErr } = await sb.from("relationships").update({ notes: appendNote(r.notes, coachNoteLine(today, facts.reasoning)) }).eq("id", r.id)
      if (noteErr) console.error("[reply/facts] relationship note append failed:", noteErr.message)
    }
  } catch (e) {
    console.error("[reply/facts] threw:", e instanceof Error ? e.message : String(e))
  }
}
