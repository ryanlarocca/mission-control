// Inbox Agent — Supabase security advisor self-heal.
//
// Supabase emails ryan@ weekly ("Action required: security vulnerabilities
// detected in your projects") whenever a public table is created with
// Row-Level Security off. Every new campaign/inbox table ships that way, so the
// email recurs after every feature. Ryan 2026-10-11: "Can you just fix them
// automatically?" — this module recognises that exact email, asks the
// Management API's advisor what is flagged, enables RLS on every table it
// names, and re-reads the advisor to prove it is clean. The app never ships the
// anon key to a browser (every read is a server route on the service key, which
// bypasses RLS), so enabling RLS with no policies changes nothing for the app.
//
// Needs SUPABASE_PAT + SUPABASE_PROJECT_REF in .env.local (same creds the
// migration runner uses). Only `rls_disabled_in_public` is auto-fixed; any other
// ERROR-level lint is reported back as "still needs you".

const API = "https://api.supabase.com/v1"
const SENDER_RE = /@supabase\.(com|io)$/i
const SUBJECT_RE = /security (vulnerabilit|advisor|risk)/i

/** Deterministic match on the weekly advisor email — no model call. */
export function isSupabaseSecurityAlert(msg) {
  const from = String(msg?.from?.email || "").toLowerCase()
  return SENDER_RE.test(from) && SUBJECT_RE.test(String(msg?.subject || ""))
}

function creds() {
  const pat = process.env.SUPABASE_PAT
  const ref = process.env.SUPABASE_PROJECT_REF
  if (!pat || !ref) throw new Error("SUPABASE_PAT / SUPABASE_PROJECT_REF missing")
  return { pat, ref }
}

async function api(path, { method = "GET", body } = {}) {
  const { pat, ref } = creds()
  const res = await fetch(`${API}/projects/${ref}${path}`, {
    method,
    headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* non-JSON error body */ }
  if (!res.ok) throw new Error(`supabase ${method} ${path} → ${res.status}: ${(json && (json.message || json.error)) || text.slice(0, 200)}`)
  return json
}

/** All advisor lints: [{ name, level, metadata: { schema, name, type } }]. */
export async function fetchSecurityLints() {
  const j = await api("/advisors/security")
  return Array.isArray(j?.lints) ? j.lints : Array.isArray(j) ? j : []
}

export function rlsTargets(lints) {
  return lints
    .filter((l) => l.name === "rls_disabled_in_public" && l.metadata?.type === "table" && l.metadata?.schema && l.metadata?.name)
    .map((l) => ({ schema: l.metadata.schema, table: l.metadata.name }))
}
export function otherErrors(lints) {
  return lints
    .filter((l) => String(l.level).toUpperCase() === "ERROR" && l.name !== "rls_disabled_in_public")
    .map((l) => `${l.name} · ${l.metadata?.schema || ""}.${l.metadata?.name || ""}`.replace(/ · \.$/, ""))
}
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`

/**
 * Enable RLS on every table the advisor flags. Returns
 * { fixed: ["public.mail_records", …], remaining: ["…"], stillFlagged: [...],
 *   errors: ["public.x: message"] }. Idempotent — a clean project returns
 * empty lists.
 */
export async function fixRlsDisabled({ dryRun = false, log = () => {} } = {}) {
  const before = await fetchSecurityLints()
  const targets = rlsTargets(before)
  const fixed = []
  const errors = []
  for (const t of targets) {
    const sql = `alter table ${ident(t.schema)}.${ident(t.table)} enable row level security;`
    if (dryRun) {
      log(`dry-run: ${sql}`)
      fixed.push(`${t.schema}.${t.table}`)
      continue
    }
    try {
      await api("/database/query", { method: "POST", body: { query: sql } })
      fixed.push(`${t.schema}.${t.table}`)
      log(`rls enabled: ${t.schema}.${t.table}`)
    } catch (e) {
      errors.push(`${t.schema}.${t.table}: ${e.message}`)
    }
  }
  const after = dryRun || !targets.length ? before : await fetchSecurityLints()
  const stillFlagged = dryRun ? [] : rlsTargets(after).map((t) => `${t.schema}.${t.table}`)
  return { fixed, remaining: otherErrors(after), stillFlagged, errors }
}

/** Telegram card body. `esc` is the HTML escaper from telegram.mjs. */
export function advisorSummary(r, esc = (s) => s) {
  const lines = []
  if (r.fixed.length) lines.push(`🔒 <b>Supabase</b> — enabled Row-Level Security on ${r.fixed.length} table${r.fixed.length === 1 ? "" : "s"}:\n${r.fixed.map((t) => `  • ${esc(t.replace(/^public\./, ""))}`).join("\n")}`)
  else lines.push(`🔒 <b>Supabase</b> — security email received; advisor shows nothing to fix.`)
  if (r.stillFlagged.length) lines.push(`⚠️ Still flagged after the fix: ${esc(r.stillFlagged.join(", "))}`)
  if (r.errors.length) lines.push(`⚠️ Couldn't alter: ${esc(r.errors.join("; "))}`)
  if (r.remaining.length) lines.push(`👀 Other advisor errors I don't auto-fix:\n${r.remaining.map((x) => `  • ${esc(x)}`).join("\n")}`)
  if (!r.stillFlagged.length && !r.errors.length && !r.remaining.length) lines.push(`Advisor is clean. Nothing for you to do.`)
  return lines.join("\n")
}
