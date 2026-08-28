import type { SupabaseClient } from "@supabase/supabase-js"
import {
  composeVariantBody,
  lintBody,
  bodyHash,
  loadEditExamples,
  loadCopyRules,
  PROMPT_VERSION,
} from "../scripts/campaign-compose.mjs"

// Shared by /api/campaign/sends/[id]/regenerate (one draft) and
// /api/campaign/regenerate-batch (every draft). Rewrites one un-sent Phase B
// draft with the same compose + lint path as the engine, folding in Ryan's
// standing copy rules and an optional one-off note ("don't claim we've met").
// The rejected body is kept in campaign_send_edits (kind='regenerate', note).

export type RegenOutcome =
  | { ok: true; id: string; subject: string; body: string }
  | { ok: false; id: string; status: number; error: string }

const SEND_SELECT =
  "id, status, subject, body, variant, touch_number, contact:campaign_contacts(id, name, first_name, email, phone, import_flags)"

type SendRow = {
  id: string
  status: string
  subject: string
  body: string
  variant: string | null
  touch_number: number
  contact: Record<string, unknown> | Record<string, unknown>[] | null
}

export type RegenContext = {
  rules: string[]
  variants: Map<string, { variant: string; touch_number: number; subject: string; body: string; personalize: boolean }>
  examples: Map<number, Array<{ body_before: string; body_after: string }>>
}

export async function loadRegenContext(sb: SupabaseClient): Promise<RegenContext> {
  const [rules, { data: variantRows }] = await Promise.all([
    loadCopyRules(sb) as Promise<string[]>,
    sb.from("campaign_variants").select("variant, touch_number, subject, body, personalize"),
  ])
  const variants = new Map((variantRows ?? []).map((v) => [`${v.touch_number}:${v.variant}`, v]))
  return { rules, variants, examples: new Map() }
}

export async function regenerateSend(sb: SupabaseClient, id: string, note: string, ctx: RegenContext, seedSalt = ""): Promise<RegenOutcome> {
  const fail = (status: number, error: string): RegenOutcome => ({ ok: false, id, status, error })
  const { data: row, error } = await sb.from("campaign_sends").select(SEND_SELECT).eq("id", id).maybeSingle<SendRow>()
  if (error) return fail(500, error.message)
  if (!row) return fail(404, "send not found")
  if (row.status !== "draft") return fail(409, `only drafts can be regenerated (this one is ${row.status})`) // never overwrite an approved, possibly hand-edited body
  if (!row.variant) return fail(409, "only Phase B variant drafts (A/B/C) can be regenerated")
  const contact = Array.isArray(row.contact) ? row.contact[0] : row.contact
  if (!contact) return fail(409, "contact missing")
  const vt = ctx.variants.get(`${row.touch_number}:${row.variant}`)
  if (!vt) return fail(409, `variant ${row.variant} template not found`)

  if (!ctx.examples.has(row.touch_number)) ctx.examples.set(row.touch_number, await loadEditExamples(sb, row.touch_number))
  const examples = ctx.examples.get(row.touch_number) ?? []

  let composed: { subject: string; body: string; firstName: string } | null = null
  let lastErr = ""
  for (let attempt = 0; attempt < 2 && !composed; attempt++) {
    const c = await composeVariantBody({
      variant: vt,
      contact,
      seed: `regen-${id.slice(0, 8)}-${seedSalt}${Date.now() % 100000}-${attempt}`,
      examples,
      avoid: [row.body],
      rules: ctx.rules,
      note,
    })
    const errs = lintBody({ subject: c.subject, body: c.body, firstName: c.firstName, contact })
    if (errs.length) { lastErr = errs.join("; "); continue }
    if (bodyHash(c.body) === bodyHash(row.body)) { lastErr = "identical to current body"; continue }
    composed = c
  }
  if (!composed) return fail(422, `regenerate failed lint: ${lastErr}`)

  const { error: histErr } = await sb.from("campaign_send_edits").insert({
    send_id: row.id,
    contact_id: contact.id,
    touch_number: row.touch_number,
    variant: row.variant,
    kind: "regenerate",
    note: note.trim() || null,
    subject_before: row.subject,
    subject_after: composed.subject,
    body_before: row.body,
    body_after: composed.body,
  })
  if (histErr) return fail(500, `edit history: ${histErr.message}`)

  const { error: updErr } = await sb
    .from("campaign_sends")
    .update({ subject: composed.subject, body: composed.body, body_hash: bodyHash(composed.body), prompt_version: PROMPT_VERSION, edited: false })
    .eq("id", id)
  if (updErr) return fail(500, updErr.message)
  return { ok: true, id, subject: composed.subject, body: composed.body }
}

/** Persist a standing rule (Ryan-typed). Returns the row id. */
export async function saveCopyRule(sb: SupabaseClient, rule: string): Promise<string> {
  const text = rule.trim()
  if (!text) throw new Error("rule is empty")
  const { data, error } = await sb.from("campaign_copy_rules").insert({ rule: text }).select("id").single()
  if (error) throw new Error(error.message)
  return data.id as string
}
