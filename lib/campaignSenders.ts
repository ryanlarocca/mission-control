import { getLeadsClient } from "@/lib/leads"
import sendersConfig from "@/config/campaign-senders.json"

// Per-sender controls for the Telegram route (September rebuild item 3,
// 2026-09-05). The engine (scripts/campaign-senders.mjs) owns the ramp
// logic; this is the small TypeScript mirror the Vercel side needs to read
// and flip the same `campaign_settings` rows: `sender:<email>`.
//
//   pause buys [reason]      → paused (no expiry — Ryan's call, only "resume buys" lifts it)
//   resume offers            → un-paused
//   canary buys primary      → today's canary verdict (primary | promotions | spam), optional YYYY-MM-DD
//   reputation buys high     → Postmaster domain reputation as read off the dashboard
//   campaign status          → one line per sender (see campaignStatusLine)
//
// Keep the state shape in sync with freshState() in scripts/campaign-senders.mjs.

export interface SenderRef {
  email: string
  label: string
  role: "workhorse" | "understudy"
  ramp: number[]
  ceiling: number
  enabled: boolean
}

export interface SenderState {
  step: number
  entered_step: string | null
  healthy_days: number
  held_reason: string | null
  last_change: string | null
  paused: boolean
  paused_reason: string | null
  paused_by: string | null
  paused_at: string | null
  paused_until: string | null
  gap_days: number
  canary_verdicts: Record<string, CanaryVerdict>
  postmaster: { reputation: PostmasterLevel; recorded_at: string; by: string } | null
  history: { day: string; step: number; cap: number; sent: number; bounces: number; replies: number; status: string; decision: string }[]
  updated_at?: string
}

export type CanaryVerdict = "primary" | "promotions" | "spam"
export type PostmasterLevel = "HIGH" | "MEDIUM" | "LOW" | "BAD"
export const CANARY_VERDICTS: CanaryVerdict[] = ["primary", "promotions", "spam"]
export const POSTMASTER_LEVELS: PostmasterLevel[] = ["HIGH", "MEDIUM", "LOW", "BAD"]

const PT = "America/Los_Angeles"

type RawSender = { enabled?: boolean; role?: string; label?: string; ramp?: number[]; ceiling?: number }

export function listSenders(): SenderRef[] {
  const raw = (sendersConfig as { senders?: Record<string, RawSender> }).senders ?? {}
  return Object.entries(raw).map(([email, cfg]) => {
    const ramp = (cfg.ramp ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0)
    return {
      email: email.trim().toLowerCase(),
      label: cfg.label || email.split("@")[1].replace(/\.[a-z]+$/, ""),
      role: cfg.role === "understudy" ? "understudy" : "workhorse",
      ramp,
      ceiling: Number.isFinite(Number(cfg.ceiling)) && Number(cfg.ceiling) > 0 ? Number(cfg.ceiling) : ramp[ramp.length - 1] ?? 0,
      enabled: cfg.enabled !== false,
    }
  })
}

/** "buys" / "offers" / a full address → the sender, or null. */
export function resolveSender(token: string): SenderRef | null {
  const t = String(token ?? "").trim().toLowerCase()
  if (!t) return null
  return listSenders().find((s) => s.label.toLowerCase() === t || s.email === t) ?? null
}

export function freshSenderState(): SenderState {
  return {
    step: 0, entered_step: null, healthy_days: 0, held_reason: null, last_change: null,
    paused: false, paused_reason: null, paused_by: null, paused_at: null, paused_until: null,
    gap_days: 0, canary_verdicts: {}, postmaster: null, history: [],
  }
}

export function isSenderPaused(state: SenderState | null | undefined, now = Date.now()): boolean {
  if (!state?.paused) return false
  if (state.paused_until && new Date(state.paused_until).getTime() < now) return false
  return true
}

export function capFor(sender: SenderRef, state: SenderState | null | undefined): number {
  if (!sender.ramp.length) return 0
  const step = Math.max(0, Math.min(Number(state?.step ?? 0), sender.ramp.length - 1))
  return Math.min(sender.ramp[step], sender.ceiling)
}

export function ptToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: PT, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
}

const stateKey = (email: string) => `sender:${email.toLowerCase()}`

export async function getSenderState(email: string): Promise<SenderState> {
  const sb = getLeadsClient()
  const { data } = await sb.from("campaign_settings").select("value").eq("key", stateKey(email)).maybeSingle()
  return { ...freshSenderState(), ...((data?.value as Partial<SenderState> | null) ?? {}) }
}

async function saveSenderState(email: string, state: SenderState): Promise<void> {
  const sb = getLeadsClient()
  const value = { ...state, updated_at: new Date().toISOString() }
  const { error } = await sb.from("campaign_settings").upsert({ key: stateKey(email), value, updated_at: value.updated_at })
  if (error) throw new Error(`save sender state ${email}: ${error.message}`)
}

/** Manual per-sender pause (no expiry) or resume. */
export async function setSenderPaused(email: string, paused: boolean, reason: string, by: string): Promise<SenderState> {
  const st = await getSenderState(email)
  const now = new Date().toISOString()
  const next: SenderState = paused
    ? { ...st, paused: true, paused_reason: reason, paused_by: by, paused_at: now, paused_until: null }
    : { ...st, paused: false, paused_reason: null, paused_by: null, paused_at: null, paused_until: null }
  await saveSenderState(email, next)
  return next
}

/** Ryan's read of the judge inbox for one canary — feeds the "canary Primary 3 days running" gate. */
export async function recordCanaryVerdict(email: string, verdict: string, day?: string): Promise<{ state: SenderState; day: string; recent: string[] }> {
  const v = String(verdict ?? "").toLowerCase() as CanaryVerdict
  if (!CANARY_VERDICTS.includes(v)) throw new Error(`verdict must be one of ${CANARY_VERDICTS.join(" / ")}`)
  const d = day ?? ptToday()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`bad day "${d}" — use YYYY-MM-DD`)
  const st = await getSenderState(email)
  const all = { ...(st.canary_verdicts ?? {}), [d]: v }
  const keep = Object.keys(all).sort().slice(-30)
  const next: SenderState = { ...st, canary_verdicts: Object.fromEntries(keep.map((k) => [k, all[k]])) as Record<string, CanaryVerdict> }
  await saveSenderState(email, next)
  const recent = keep.slice(-3).map((k) => `${k.slice(5)} ${all[k]}`)
  return { state: next, day: d, recent }
}

/** Postmaster Tools domain reputation as read off the dashboard (manual until the API is authorized). */
export async function recordPostmaster(email: string, level: string, by: string): Promise<SenderState> {
  const l = String(level ?? "").toUpperCase() as PostmasterLevel
  if (!POSTMASTER_LEVELS.includes(l)) throw new Error(`reputation must be one of ${POSTMASTER_LEVELS.map((x) => x.toLowerCase()).join(" / ")}`)
  const st = await getSenderState(email)
  const next: SenderState = { ...st, postmaster: { reputation: l, recorded_at: new Date().toISOString(), by } }
  await saveSenderState(email, next)
  return next
}

/** One short line per enabled sender for "campaign status". */
export async function senderStatusLines(): Promise<string[]> {
  const out: string[] = []
  for (const s of listSenders().filter((x) => x.enabled)) {
    const st = await getSenderState(s.email)
    const cap = capFor(s, st)
    const paused = isSenderPaused(st)
    const until = st.paused_until ? ` until ${new Date(st.paused_until).toLocaleString("en-US", { timeZone: PT, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""
    const verdicts = Object.keys(st.canary_verdicts ?? {}).sort().slice(-3).map((d) => st.canary_verdicts[d])
    out.push(
      `${paused ? "⏸" : "▶️"} ${s.label} (${s.email}): ${cap}/day, step ${st.step}, healthy ${st.healthy_days}/3` +
        (paused ? ` — PAUSED: ${st.paused_reason ?? "manual"} (${st.paused_by ?? "?"}${until})` : "") +
        (st.held_reason ? ` — held: ${st.held_reason}` : "") +
        (verdicts.length ? ` — canary ${verdicts.join(",")}` : " — no canary verdicts") +
        (st.postmaster ? ` — Postmaster ${st.postmaster.reputation}` : "")
    )
  }
  return out
}
