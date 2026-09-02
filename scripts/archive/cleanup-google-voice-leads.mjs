// One-off cleanup for legacy Google Voice leads polluted by the pre-fix
// generic-email ingest path. See app/api/leads/email/route.ts (ingestGoogleVoice).
//
// Two problems being repaired:
//   1. All voice-noreply@google.com forwards merged under one email-key
//      cluster and bled an unrelated lead's address (Chris Bola's "618 Beta
//      Court") onto every GV row.
//   2. Shortcode marketing/political SMS (Sierra Club @ 69866) were ingested
//      as real MFM-A/MFM-B direct-mail leads.
//
// Plan per row (mirrors the new ingest logic):
//   • real 10-digit caller  → caller_phone set, name = transcript name || the
//     phone, source="Legacy DM", source_type="direct_mail", email=null,
//     property_address cleared; drip_campaign_type → direct_mail_call when it
//     was an email-channel drip (counters left intact so cadence isn't reset).
//   • shortcode / no caller → is_junk=true, status="dead", address cleared.
//
// Dry-run by default. Pass --apply to write.

import fs from "node:fs"

const APPLY = process.argv.includes("--apply")
const env = {}
for (const line of fs.readFileSync(".env.local", "utf-8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (!m) continue
  let v = m[2]
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  env[m[1]] = v
}
const url = env.LRG_SUPABASE_URL
const key = env.LRG_SUPABASE_SERVICE_KEY

// ── Parsing (kept in sync with parseGoogleVoiceForward in the email route) ──
function isGvChromeLine(line) {
  const t = line.trim()
  if (!t) return true
  if (/^<?https?:\/\//i.test(t)) return true
  if (/voice\.google\.com|accounts\.google\.com/i.test(t)) return true
  if (/^play message$/i.test(t)) return true
  if (/^call back$/i.test(t)) return true
  if (/^your account\b/i.test(t) || /help center/i.test(t)) return true
  if (/to respond to this message/i.test(t)) return true
  if (/launch google voice/i.test(t)) return true
  if (/to avoid missing calls/i.test(t)) return true
  if (/keep google voice/i.test(t)) return true
  if (/^hello .+,$/i.test(t)) return true
  return false
}
function normalize10(d) {
  const digits = d.replace(/\D/g, "")
  const last10 = digits.length > 10 ? digits.slice(-10) : digits
  return last10.length === 10 ? `+1${last10}` : null
}
function fmtPhone(e164) {
  const d = e164.replace(/\D/g, "").slice(-10)
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}
function extractNameFromBody(text) {
  if (!text) return null
  const pats = [
    /\b[Mm]y name is ([A-Z][a-z]+(?: [A-Z][a-z]+){0,2})(?=\W|$)/,
    /\bI(?:'m| am) ([A-Z][a-z]+(?: [A-Z][a-z]+){0,2})(?=\W|$)/,
    /\b[Tt]his is ([A-Z][a-z]+(?: [A-Z][a-z]+){0,2})(?=\W|$)/,
  ]
  for (const re of pats) { const m = re.exec(text); if (m && m[1]) return m[1].trim() }
  return null
}
function parseGv(message) {
  const lines = (message || "").split(/\r?\n/)
  const headerLine = lines.find((l) => l.trim()) || ""
  const header = headerLine.trim()
  let kind = "unknown"
  if (/new text message/i.test(header)) kind = "text"
  else if (/new voicemail/i.test(header)) kind = "voicemail"
  else if (/new missed call|missed a call/i.test(header)) kind = "missed_call"
  let callerPhone = null
  const m = header.match(/from\s+\+?1?[\s.]*\(?(\d{3})\)?[\s.\-]*(\d{3})[\s.\-]*(\d{4})/i)
  if (m) callerPhone = normalize10(`${m[1]}${m[2]}${m[3]}`)
  const startIdx = lines.indexOf(headerLine)
  const content = lines
    .slice(startIdx >= 0 ? startIdx + 1 : 0)
    .filter((l) => !isGvChromeLine(l))
    .join("\n").replace(/\n{3,}/g, "\n\n").trim()
  return { kind, callerPhone, content }
}

// Coarse address key: street number + first street word, so "618 Beta Court"
// and "618 Beta Ct" collapse to the same owner key.
function addrKey(a) {
  const m = (a || "").toLowerCase().match(/^\s*(\d+)\s+([a-z]+)/)
  return m ? `${m[1]} ${m[2]}` : null
}
const PLACEHOLDER_NAMES = new Set(["", "google voice", "(no name)", "no name", "caller", "unknown"])

async function patch(id, fields) {
  const res = await fetch(`${url}/rest/v1/leads?id=eq.${id}`, {
    method: "PATCH",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(fields),
  })
  if (!res.ok) throw new Error(`PATCH ${id}: ${res.status} ${await res.text()}`)
}

// Build an address-owner map from NON-Google-Voice leads (call leads + real
// email replies) so we can tell a bled address from a caller's own address.
const ownQ = new URLSearchParams({
  select: "caller_phone,property_address,email",
  property_address: "not.is.null",
  caller_phone: "not.is.null",
})
const ownRes = await fetch(`${url}/rest/v1/leads?${ownQ}&limit=2000`, { headers: { apikey: key, Authorization: `Bearer ${key}` } })
const ownRows = await ownRes.json()
const ownerMap = new Map() // addrKey -> Set(caller_phone)
for (const o of ownRows) {
  if ((o.email || "").toLowerCase() === "voice-noreply@google.com") continue // exclude GV rows themselves
  const k = addrKey(o.property_address)
  if (!k) continue
  if (!ownerMap.has(k)) ownerMap.set(k, new Set())
  ownerMap.get(k).add(o.caller_phone)
}

const q = new URLSearchParams({
  select: "id,created_at,source,source_type,caller_phone,email,name,property_address,drip_campaign_type,is_junk,status,message",
  email: "eq.voice-noreply@google.com",
  order: "created_at.asc",
})
const res = await fetch(`${url}/rest/v1/leads?${q}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } })
if (!res.ok) { console.error("HTTP", res.status, await res.text()); process.exit(1) }
const rows = await res.json()
console.log(`${APPLY ? "APPLYING" : "DRY-RUN"} — ${rows.length} voice-noreply@google.com rows\n`)

let real = 0, spam = 0
for (const r of rows) {
  const p = parseGv(r.message)
  if (!p.callerPhone) {
    spam++
    const fields = { is_junk: true, status: "dead", property_address: null }
    console.log(`SPAM  ${r.created_at.slice(0, 10)} id=${r.id.slice(0, 8)} kind=${p.kind} — junk+dead, clear addr (was ${JSON.stringify(r.property_address)})`)
    console.log(`        msg: ${(r.message || "").replace(/\n/g, " ").slice(0, 90)}`)
    if (APPLY) await patch(r.id, fields)
  } else {
    real++
    const fields = {
      caller_phone: p.callerPhone,
      email: null,
      source: "Legacy DM",
      source_type: "direct_mail",
    }
    // Name: only fill when the current name is a placeholder. Never clobber a
    // real name (e.g. Chris Bola, captured on his clustered call leads).
    if (PLACEHOLDER_NAMES.has((r.name || "").toLowerCase())) {
      fields.name = extractNameFromBody(p.content) || fmtPhone(p.callerPhone)
    }
    // Address: clear ONLY when it's bled — i.e. its owner key belongs to a
    // DIFFERENT caller in the non-GV leads. A caller's own address (Chris's
    // 618 Beta Ct on his +1408... cluster) is preserved. Unrecognized
    // addresses are kept and flagged for a manual look.
    let addrNote = ""
    if (r.property_address) {
      const owners = ownerMap.get(addrKey(r.property_address))
      if (owners && !owners.has(p.callerPhone)) {
        fields.property_address = null
        addrNote = ` → CLEAR bled addr ${JSON.stringify(r.property_address)} (owned by ${[...owners].join(",")})`
      } else if (!owners) {
        addrNote = ` → KEEP addr ${JSON.stringify(r.property_address)} (no other owner found — review)`
      } else {
        addrNote = ` → KEEP own addr ${JSON.stringify(r.property_address)}`
      }
    }
    // Switch off email-channel drips (no email now); keep counters/clock intact.
    if (r.drip_campaign_type === "direct_mail_email" || r.drip_campaign_type === "google_ads_email_only") {
      fields.drip_campaign_type = "direct_mail_call"
    }
    console.log(`REAL  ${r.created_at.slice(0, 10)} id=${r.id.slice(0, 8)} kind=${p.kind} caller=${p.callerPhone} name=${JSON.stringify(fields.name ?? r.name)} (was src=${r.source} name=${JSON.stringify(r.name)} drip=${r.drip_campaign_type})${addrNote}`)
    if (APPLY) await patch(r.id, fields)
  }
}
console.log(`\n${APPLY ? "Applied" : "Would change"}: ${real} real callers relabeled, ${spam} spam rows junked.`)
