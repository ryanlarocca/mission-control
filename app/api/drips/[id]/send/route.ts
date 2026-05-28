import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"

// Immediate-send for a pending, approved, or failed drip_queue row. Flips
// status to approved (for pending/failed — clearing the prior error), kicks
// the sidecar's /drip-trigger-drain so the engine fires the row right now
// instead of waiting for the next hourly pass. Returns 202 — the engine runs
// async; the UI re-fetches /api/drips to confirm the row landed in "sent".
//
// The `failed` path is the Drips-tab Retry button: a row the engine couldn't
// send (e.g. a transient sidecar error) gets the same staleness re-check as a
// pending row, then re-enters the drain queue.

// .trim() defends against a stray trailing newline in the env value
// (update-sidecar-url.sh used to `echo` the URL, which baked a `\n` into the
// Vercel env var and silently broke every drip-trigger fetch). Belt-and-
// suspenders even after the shell-script fix.
const SIDECAR_URL = (process.env.SIDECAR_URL || "http://localhost:5799").trim()
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const id = params.id
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 })

  // Body is optional. `{force: true}` bypasses the staleness check below —
  // the UI sets it on the "Send anyway" branch of the stale-drip prompt.
  let force = false
  try {
    const body = await request.json()
    if (body && typeof body === "object" && (body as { force?: unknown }).force === true) force = true
  } catch { /* empty body is fine */ }

  try {
    const sb = getLeadsClient()
    const { data: row, error } = await sb
      .from("drip_queue")
      .select("id, status, lead_id, created_at")
      .eq("id", id)
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 })
    if (row.status === "sent") return NextResponse.json({ ok: true, alreadySent: true })
    if (row.status !== "pending" && row.status !== "approved" && row.status !== "failed") {
      return NextResponse.json({ error: `cannot send row with status=${row.status}` }, { status: 409 })
    }

    // Staleness check on pending/failed rows: if a non-drip event happened on
    // the cluster after the row was queued, the draft is stale — auto-skip.
    // (Approved rows already passed this check when Ryan approved them.)
    // `force=true` lets the UI bypass this when Ryan explicitly picks "Send
    // anyway" on the stale-drip prompt.
    if (row.status === "pending" || row.status === "failed") {
      // Staleness GATE — only for a normal Send (not "Send anyway"). `force`
      // means Ryan already saw the stale prompt and chose to send regardless,
      // so we skip the gate but STILL approve the row below.
      if (!force) {
        const { data: lead } = await sb
          .from("leads")
          .select("caller_phone, email")
          .eq("id", row.lead_id)
          .maybeSingle()
        if (lead?.caller_phone || lead?.email) {
          let q = sb.from("leads").select("id, lead_type").gt("created_at", row.created_at).limit(5)
          if (lead.caller_phone) q = q.eq("caller_phone", lead.caller_phone)
          else q = q.eq("email", lead.email!)
          const { data: newer } = await q
          const stale = (newer || []).some(r => r.lead_type && !(r.lead_type as string).startsWith("drip_"))
          if (stale) {
            // 409 + `stale: true` so the client can show the Regenerate /
            // Send anyway / Skip prompt instead of just dropping the row.
            return NextResponse.json(
              { error: "Stale draft — contact had activity since this was drafted.", stale: true },
              { status: 409 }
            )
          }
        }
      }

      // Flip to approved + clear any prior error. This MUST run for BOTH a
      // normal send AND "Send anyway" (force) — the engine's drainApprovedQueue
      // only sends rows with status="approved". The old code nested this flip
      // inside the `!force` branch, so "Send anyway" left the row `pending`
      // forever: the engine got kicked but had nothing approved to drain, so it
      // never sent. That was the "I click Send anyway and it never sends" bug.
      const { error: upErr } = await sb
        .from("drip_queue")
        .update({ status: "approved", approved_at: new Date().toISOString(), error: null })
        .eq("id", id)
        .eq("status", row.status)
      if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })
    }

    // Kick the engine to drain NOW. The row is already flipped to `approved`
    // above, so even if this kick fails the hourly engine pass still sends it
    // — the message is queued, never lost. But we must report the truth: the
    // old code swallowed the kick error and ALWAYS returned `triggered: true`,
    // so the UI showed "Sent ✓", dropped the row, then the 6s refetch
    // resurrected the still-pending row — the "blink, no message sent". Now we
    // tell the client whether the immediate send actually fired.
    let triggered = false
    try {
      const kick = await fetch(`${SIDECAR_URL}/drip-trigger-drain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(5000),
      })
      triggered = kick.ok
      if (!kick.ok) {
        console.warn(`[drips:send] sidecar drain returned ${kick.status} (row approved; hourly engine will send it)`)
      }
    } catch (e) {
      console.warn("[drips:send] sidecar trigger failed (row remains approved, engine will pick it up next hour):", e instanceof Error ? e.message : String(e))
    }

    // 202 either way — the row is approved and WILL send. `triggered` tells the
    // UI whether it went out now (toast "Sent ✓") or is queued for the hourly
    // pass (toast "Queued — sends within the hour") instead of a false success.
    return NextResponse.json({ ok: true, triggered, queued: !triggered }, { status: 202 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
