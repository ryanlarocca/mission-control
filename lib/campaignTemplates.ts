import Anthropic from "@anthropic-ai/sdk"
import { getLeadsClient } from "@/lib/leads"

// Template-level copy editing from Telegram (Ryan 2026-08-06: "handle
// everything inside Telegram... change the copy using AI... at the
// template level"). Live copy lives in campaign_templates (DB) — the
// engine reads it there; scripts/campaign-touches.mjs is seed/fallback.
//
// Flow: "copy: T2 <guidance>" → Claude Sonnet revises the touch's
// template → rendered preview posts with [✅ Apply] [❌ Discard]. Apply
// updates the DB template AND re-renders that touch's un-sent drafts in
// place, so nothing goes out with stale wording. Old copy is kept in the
// pending event for one-command rollback via another copy: edit.

const MODEL = "claude-sonnet-5"
const AGENTS_LINE_DISPLAY = "(650) 910-4007"

// Mirrors makeSignature() in scripts/campaign-touches.mjs — keep in sync.
function makeSignature(): string {
  return `Ryan LaRocca, LRG Homes\nCall or text: ${AGENTS_LINE_DISPLAY}\nReply "remove" anytime to opt out.`
}

const COPY_RULES = `You edit email templates for Ryan LaRocca's drip campaign to real-estate agents he knows.
He buys single-family homes and 2-15 unit multifamily in the Bay Area (South Bay focus) under $4M. As-is, quick close, proof of funds.

Hard rules:
- Output EXACTLY this format: first line "SUBJECT: <subject>", then a blank line, then the body. Nothing else — no commentary.
- Keep the {{first_name}} merge token where a greeting appears (e.g. "Hi {{first_name}},").
- Do NOT include a signature — it is appended automatically.
- NEVER use em dashes, en dashes, bullet points, or typographic ornaments. Plain hyphens, commas, periods.
- Subject lines: human, lowercase-casual, no clickbait, no colons-and-numbers listicle patterns.
- Voice: busy investor writing to colleagues. Warm, direct, short sentences. Keep overall length close to the current template unless the guidance says otherwise.
- Apply ONLY the requested changes; keep everything the guidance did not touch.`

type TemplateRow = { touch_number: number; label: string; subject: string | null; body: string | null }

export function renderTemplate(t: { subject: string; body: string }, firstName: string): { subject: string; body: string } {
  const first = firstName.trim().split(/\s+/)[0] || "there"
  const fill = (s: string) => s.replaceAll("{{first_name}}", first)
  return { subject: fill(t.subject), body: `${fill(t.body)}\n\n${makeSignature()}` }
}

export interface CopyResult {
  success: boolean
  error?: string
  touch?: number
  subject?: string
  body?: string
  preview?: { subject: string; body: string }
  eventId?: string
  oldTgMessageId?: number
}

async function getTemplate(touch: number): Promise<TemplateRow | null> {
  const sb = getLeadsClient()
  const { data } = await sb
    .from("campaign_templates")
    .select("touch_number, label, subject, body")
    .eq("touch_number", touch)
    .maybeSingle()
  return (data as TemplateRow) ?? null
}

async function composeRevision(current: TemplateRow, guidance: string): Promise<{ subject?: string; body?: string; error?: string }> {
  if (!process.env.ANTHROPIC_API_KEY) return { error: "ANTHROPIC_API_KEY not set" }
  const client = new Anthropic()
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: COPY_RULES,
      messages: [
        {
          role: "user",
          content: `Current template for touch ${current.touch_number} ("${current.label}"):\n\nSUBJECT: ${current.subject}\n\n${current.body}\n\nRyan's requested changes: ${guidance}\n\nOutput the revised template now.`,
        },
      ],
    })
    if (response.stop_reason === "refusal") return { error: "model declined" }
    const textBlock = response.content.find((b) => b.type === "text")
    const raw = (textBlock && "text" in textBlock ? textBlock.text : "").replace(/—|–/g, ", ").trim()
    const m = /^SUBJECT:\s*(.+?)\s*\n\s*\n([\s\S]+)$/.exec(raw)
    if (!m) return { error: "model output didn't match SUBJECT/body format" }
    const body = m[2].trim()
    if (!body.includes("{{first_name}}") && current.body?.includes("{{first_name}}")) {
      return { error: "revision dropped the {{first_name}} merge token — try rephrasing the guidance" }
    }
    return { subject: m[1].trim(), body }
  } catch (e) {
    return { error: `Claude API: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** "copy: T<t> <guidance>" — revise a touch template; pending until Apply. */
export async function reviseTemplateCopy(args: { touch: number; guidance: string }): Promise<CopyResult> {
  const { touch, guidance } = args
  const sb = getLeadsClient()
  const current = await getTemplate(touch)
  if (!current) return { success: false, error: `no template for touch ${touch}` }
  if (!current.subject || !current.body) {
    return { success: false, error: `T${touch} is a placeholder (${current.label}) — its copy gets written fresh, not edited` }
  }
  const out = await composeRevision(current, guidance)
  if (!out.subject || !out.body) return { success: false, error: out.error }

  const { data: row, error: insErr } = await sb
    .from("campaign_events")
    .insert({
      kind: "note",
      triage: "pending_copy",
      body: `Template edit T${touch} awaiting apply (guidance: ${guidance.slice(0, 300)})`,
      raw: {
        via: "telegram_copy",
        touch,
        guidance,
        subject: out.subject,
        body: out.body,
        prev_subject: current.subject,
        prev_body: current.body,
      },
    })
    .select("id")
    .single()
  if (insErr || !row?.id) return { success: false, error: `save failed: ${insErr?.message ?? "no id"}` }
  return {
    success: true,
    touch,
    subject: out.subject,
    body: out.body,
    preview: renderTemplate({ subject: out.subject, body: out.body }, "Alex"),
    eventId: String(row.id),
  }
}

/** Further tweaks via reply-to-preview (same mechanic as draft revisions). */
export async function reviseTemplatePending(args: { eventId: string; feedback: string }): Promise<CopyResult> {
  const { eventId, feedback } = args
  const sb = getLeadsClient()
  const { data: ev } = await sb.from("campaign_events").select("id, triage, raw").eq("id", eventId).maybeSingle()
  if (!ev) return { success: false, error: "copy edit not found" }
  if (ev.triage !== "pending_copy") return { success: false, error: "that copy edit was already applied or discarded — start a new copy: command" }
  const raw = (ev.raw ?? {}) as { touch?: number; guidance?: string; subject?: string; body?: string; prev_subject?: string; prev_body?: string; tg_message_id?: number }
  if (!raw.touch || !raw.subject || !raw.body) return { success: false, error: "copy record incomplete" }
  const out = await composeRevision(
    { touch_number: raw.touch, label: `touch ${raw.touch}`, subject: raw.subject, body: raw.body },
    feedback.replace(/^copy:\s*/i, "")
  )
  if (!out.subject || !out.body) return { success: false, error: out.error }
  const { data: row, error: insErr } = await sb
    .from("campaign_events")
    .insert({
      kind: "note",
      triage: "pending_copy",
      body: `Template edit T${raw.touch} awaiting apply (revision: ${feedback.slice(0, 300)})`,
      raw: { via: "telegram_copy", touch: raw.touch, guidance: `${raw.guidance ?? ""} → ${feedback}`, subject: out.subject, body: out.body, prev_subject: raw.prev_subject, prev_body: raw.prev_body, revision_of: eventId },
    })
    .select("id")
    .single()
  if (insErr || !row?.id) return { success: false, error: `save failed: ${insErr?.message ?? "no id"}` }
  await sb.from("campaign_events").update({ triage: "copy_superseded" }).eq("id", eventId)
  return {
    success: true,
    touch: raw.touch,
    subject: out.subject,
    body: out.body,
    preview: renderTemplate({ subject: out.subject, body: out.body }, "Alex"),
    eventId: String(row.id),
    oldTgMessageId: raw.tg_message_id,
  }
}

/** ✅ Apply: update the DB template + re-render that touch's un-sent drafts. */
export async function applyTemplateCopy(eventId: string): Promise<{ success: boolean; error?: string; touch?: number; redrafted?: number }> {
  const sb = getLeadsClient()
  const { data: ev } = await sb.from("campaign_events").select("id, triage, raw").eq("id", eventId).maybeSingle()
  if (!ev) return { success: false, error: "copy edit not found" }
  if (ev.triage !== "pending_copy") {
    if (ev.triage === "copy_applied") return { success: false, error: "already applied" }
    if (ev.triage === "copy_superseded") return { success: false, error: "this version was revised — use the newest preview's buttons" }
    return { success: false, error: "copy edit was discarded" }
  }
  const raw = (ev.raw ?? {}) as { touch?: number; subject?: string; body?: string }
  if (!raw.touch || !raw.subject || !raw.body) return { success: false, error: "copy record incomplete" }

  const { error: upErr } = await sb
    .from("campaign_templates")
    .update({ subject: raw.subject, body: raw.body, updated_at: new Date().toISOString() })
    .eq("touch_number", raw.touch)
  if (upErr) return { success: false, error: `template update failed: ${upErr.message}` }

  // Re-render every un-sent draft/approved row of this touch in place.
  const { data: pending } = await sb
    .from("campaign_sends")
    .select("id, contact:campaign_contacts (first_name, name)")
    .eq("touch_number", raw.touch)
    .in("status", ["draft", "approved"])
    .limit(1000)
  let redrafted = 0
  for (const p of pending ?? []) {
    const c = (p.contact ?? {}) as { first_name?: string; name?: string }
    const r = renderTemplate({ subject: raw.subject, body: raw.body }, c.first_name || c.name || "there")
    const { error } = await sb.from("campaign_sends").update({ subject: r.subject, body: r.body }).eq("id", p.id).in("status", ["draft", "approved"])
    if (!error) redrafted++
  }

  await sb.from("campaign_events").update({ triage: "copy_applied" }).eq("id", eventId)
  return { success: true, touch: raw.touch, redrafted }
}

export async function discardTemplateCopy(eventId: string): Promise<{ success: boolean; error?: string }> {
  const sb = getLeadsClient()
  const { data: ev } = await sb.from("campaign_events").select("id, triage").eq("id", eventId).maybeSingle()
  if (!ev) return { success: false, error: "copy edit not found" }
  if (ev.triage !== "pending_copy") return { success: false, error: "already handled" }
  await sb.from("campaign_events").update({ triage: "copy_discarded" }).eq("id", eventId)
  return { success: true }
}
