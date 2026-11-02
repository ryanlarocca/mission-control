// Market-cycle tracker — owned-property registry (cycle_owned_properties).
// briefs/BRIEF_MARKET_CYCLE_TRACKER_2026-11-01.md §3.1 item 5.
//
// Shared by the inbox agent (scripts/inbox-agent/index.mjs: a FINAL settlement
// statement adds or retires a row, a listing agreement marks it on-market) and
// the Marketing-bot route (app/api/campaign/telegram/route.ts: `own add|sold|list`).
// No imports: the supabase-js client is passed in, so the Mac mini worker and
// the Next route use the same code.
//
// Everything is behind CYCLE_REGISTRY=on (default off): with the flag off no
// caller touches the table and the Telegram command is not recognised.

/** The guard flag. Anything other than "on" (case-insensitive) is off.
 *  @param {Record<string, string | undefined>} [env] */
export function cycleRegistryOn(env = process.env) {
  return String(env?.CYCLE_REGISTRY || "").trim().toLowerCase() === "on"
}

export const REGISTRY_FLAGS = ["held", "for_sale", "home"]
const FLAG_ALIASES = { held: "held", hold: "held", for_sale: "for_sale", "for-sale": "for_sale", forsale: "for_sale", listed: "for_sale", home: "home" }

const SUFFIXES = new Set([
  "ave", "av", "avenue", "dr", "drive", "st", "street", "rd", "road", "ct", "court", "ln", "lane", "blvd", "boulevard",
  "way", "wy", "pl", "place", "cir", "circle", "ter", "terrace", "hwy", "highway", "pkwy", "parkway", "sq", "square", "loop", "trl", "trail", "row", "aly", "alley",
])
const DIRECTIONS = { north: "n", south: "s", east: "e", west: "w", n: "n", s: "s", e: "e", w: "w" }
const UNIT_RE = /\s(?:#|apt\.?|unit|ste\.?|suite)\s*[a-z0-9-]+\b.*$/i

/**
 * Street number + street name, lower case, suffix and unit dropped:
 * "5764 Halleck Dr, San Jose, CA 95123" → { number: "5764", street: "halleck", key: "5764 halleck" }.
 * "2116 Quito Road" and "2116 QUITO RD." give the same key. null when there is
 * no leading street number (the home row with no address, a bare street name).
 */
export function normalizeStreet(address) {
  const first = String(address || "").split(",")[0].replace(UNIT_RE, "").toLowerCase()
  const tokens = first.replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean)
  if (tokens.length < 2 || !/^\d+[a-z]?$/.test(tokens[0])) return null
  const number = tokens[0]
  const name = []
  for (const t of tokens.slice(1)) {
    if (SUFFIXES.has(t) && name.length) break
    if (/^\d{5}$/.test(t)) break // a zip with no comma before it
    name.push(DIRECTIONS[t] || t)
  }
  if (!name.length) return null
  const street = name.join(" ")
  return { number, street, key: `${number} ${street}` }
}

/** Same property by street number + street name. Lenient on trailing words a
 *  comma-less address drags in ("5764 Halleck San Jose" = "5764 Halleck Dr"). */
export function sameProperty(a, b) {
  const x = normalizeStreet(a)
  const y = normalizeStreet(b)
  if (!x || !y || x.number !== y.number) return false
  if (x.street === y.street) return true
  const xs = x.street.split(" ")
  const ys = y.street.split(" ")
  const [short, long] = xs.length <= ys.length ? [xs, ys] : [ys, xs]
  return short.every((t, i) => long[i] === t)
}

/** Last 5-digit group in an address ("…, CA 95123" or "…95123-4410"). */
export function zipFrom(address) {
  const all = String(address || "").match(/\b(\d{5})(?:-\d{4})?\b/g)
  if (!all) return null
  const last = all[all.length - 1].slice(0, 5)
  // a 5-digit street number alone ("12345 Main St") is not a zip
  const n = normalizeStreet(address)
  if (n && n.number === last && all.length === 1) return null
  return last
}

/** "5764 Halleck Dr, San Jose, CA 95123" → "5764 Halleck Dr" (for card lines). */
export function shortAddress(address) {
  return String(address || "").split(",")[0].trim() || "(no address)"
}

const FLAG_LABEL = { held: "held", for_sale: "for sale", home: "home" }

/**
 * Parse a Telegram registry command. Returns null when the text is not one.
 *   own add <address> [zip] [held|for_sale|home]   (flag defaults to held; the zip is required)
 *   own sold <address>
 *   own list
 * → { kind: "add", address, zip, flag } | { kind: "sold", address } | { kind: "list" } | { kind: "error", message }
 */
export function parseOwnCommand(text) {
  const m = /^\/?own(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(String(text || "").trim())
  if (!m) return null
  const rest = (m[1] || "").trim()
  const verbM = /^(add|sold|list|help)\b\s*([\s\S]*)$/i.exec(rest)
  if (!verbM) return { kind: "error", message: OWN_USAGE }
  const verb = verbM[1].toLowerCase()
  const args = verbM[2].trim()
  if (verb === "help") return { kind: "error", message: OWN_USAGE }
  if (verb === "list") return args ? { kind: "error", message: OWN_USAGE } : { kind: "list" }
  if (verb === "sold") {
    if (!normalizeStreet(args)) return { kind: "error", message: "own sold needs a street address with a number, e.g. own sold 5764 Halleck Dr" }
    return { kind: "sold", address: args.replace(/[\s,]+$/, "") }
  }
  // add
  const tokens = args.split(/\s+/).filter(Boolean)
  let flag = "held"
  const last = (tokens[tokens.length - 1] || "").toLowerCase()
  if (FLAG_ALIASES[last]) {
    flag = FLAG_ALIASES[last]
    tokens.pop()
  }
  let zip = null
  const z = /^(\d{5})(?:-\d{4})?$/.exec(tokens[tokens.length - 1] || "")
  if (z && tokens.length > 2) {
    zip = z[1]
    tokens.pop()
  }
  const address = tokens.join(" ").replace(/[\s,]+$/, "").replace(/,?\s+(?:CA|California)$/i, "").replace(/[\s,]+$/, "")
  if (!normalizeStreet(address)) return { kind: "error", message: "own add needs a street address with a number, e.g. own add 123 Main St 95123 held" }
  if (!zip) zip = zipFrom(address)
  if (!zip) return { kind: "error", message: `own add needs the zip: own add ${address} <zip> ${flag}` }
  return { kind: "add", address, zip, flag }
}

export const OWN_USAGE = "Registry commands: own add <address> <zip> [held|for_sale|home] · own sold <address> · own list"

/**
 * Pure: what one registry event does to the live rows (retired_at is null).
 * Events:
 *   { kind: "bought", address, zip, date, source }        buyer FINAL statement → insert held if no live row
 *   { kind: "sold", address, date, source }               seller FINAL statement / own sold → sold_on + retired_at
 *   { kind: "listed", address, date, source }             listing agreement / MLS Active → listed_on + for_sale
 *   { kind: "add", address, zip, flag, date, source }     own add → insert (or re-flag the live row)
 * Returns { op: "insert" | "update" | "none", row?, id?, patch?, line }.
 * `line` is the one-liner Ryan sees ("Registry: added 123 Main St (held)").
 */
export function planRegistryChange(liveRows, event) {
  const rows = (liveRows || []).filter((r) => !r.retired_at)
  const hit = event.address ? rows.find((r) => r.address && sameProperty(r.address, event.address)) : null
  const label = shortAddress(event.address)
  switch (event.kind) {
    case "bought":
    case "add": {
      const flag = event.kind === "bought" ? "held" : event.flag || "held"
      if (hit) {
        if (event.kind === "add" && hit.flag !== flag) {
          return { op: "update", id: hit.id, patch: { flag }, line: `Registry: ${shortAddress(hit.address)} ${FLAG_LABEL[hit.flag] || hit.flag} → ${FLAG_LABEL[flag]}` }
        }
        return { op: "none", line: `Registry: ${shortAddress(hit.address)} already listed (${FLAG_LABEL[hit.flag] || hit.flag}) — no change` }
      }
      if (!event.zip) return { op: "none", line: `Registry: couldn't add ${label} — no zip on the document (send: own add ${label} <zip>)` }
      const row = { address: event.address, zip: event.zip, flag, bought_on: event.kind === "bought" ? event.date || null : null, source: event.source || null }
      return { op: "insert", row, line: `Registry: added ${label} (${FLAG_LABEL[flag]})` }
    }
    case "sold": {
      if (!hit) return { op: "none", line: `Registry: ${label} is not in the registry — nothing to retire` }
      const patch = { sold_on: event.date || null, retired_at: event.retiredAt || new Date().toISOString() }
      return { op: "update", id: hit.id, patch, line: `Registry: retired ${shortAddress(hit.address)} (sold${event.date ? ` ${event.date}` : ""})` }
    }
    case "listed": {
      if (!hit) return { op: "none", line: null } // not one of Ryan's properties (or not registered yet): nothing to say
      if (hit.flag === "for_sale" && hit.listed_on) return { op: "none", line: null }
      const patch = { flag: "for_sale", listed_on: hit.listed_on || event.date || null }
      return { op: "update", id: hit.id, patch, line: `Registry: ${shortAddress(hit.address)} → for sale (listed ${patch.listed_on || "today"})` }
    }
    default:
      return { op: "none", line: null }
  }
}

/** One line for `own list`. */
export function registryListText(rows) {
  const live = (rows || []).filter((r) => !r.retired_at)
  if (!live.length) return "Registry: empty."
  return `Registry (${live.length}): ` + live.map((r) => `${r.address ? shortAddress(r.address) : "(home, no address)"} ${r.zip} ${FLAG_LABEL[r.flag] || r.flag}`).join(" · ")
}

const COLS = "id, address, zip, flag, bought_on, listed_on, sold_on, source, retired_at"

/** Live rows (retired_at is null). `client` = a supabase-js client. */
export async function liveRegistryRows(client) {
  const { data, error } = await client.from("cycle_owned_properties").select(COLS).is("retired_at", null).order("created_at", { ascending: true })
  if (error) throw new Error(`cycle_owned_properties read: ${error.message}`)
  return data || []
}

/**
 * Read live rows, plan, write. `dryRun` reads but never writes; the line then
 * says "Registry (dry run, not written): …". Returns { op, line }. Throws on a DB error so the
 * caller can put a ⚠️ line on its card.
 */
export async function applyRegistryEvent(client, event, { dryRun = false } = {}) {
  const plan = planRegistryChange(await liveRegistryRows(client), event)
  if (plan.op === "none" || dryRun) {
    return { op: plan.op, line: dryRun && plan.op !== "none" && plan.line ? plan.line.replace(/^Registry: /, "Registry (dry run, not written): ") : plan.line }
  }
  if (plan.op === "insert") {
    const { error } = await client.from("cycle_owned_properties").insert(plan.row)
    if (error) throw new Error(`cycle_owned_properties insert: ${error.message}`)
  } else {
    const { error } = await client.from("cycle_owned_properties").update(plan.patch).eq("id", plan.id)
    if (error) throw new Error(`cycle_owned_properties update: ${error.message}`)
  }
  return { op: plan.op, line: plan.line }
}

/** A listing agreement by its filename (RLA / "Residential Listing Agreement"), not a cancellation or modification of one. */
export function isListingAgreementName(filename) {
  const f = String(filename || "")
  if (/cancel|withdraw|\bCOL\b|modification|\bMT-?LA\b/i.test(f)) return false
  return /\bRLA\b|listing agreement|exclusive authori[sz]ation (?:and right )?to sell/i.test(f)
}

/** A FINAL settlement statement's date for the registry: the statement's own closing date if read, else the email day. */
export function closingDateFor(verify, fallbackDate) {
  const d = String(verify?.closing_date || "").trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return { date: d, fromEmail: false }
  return { date: fallbackDate || null, fromEmail: true }
}
