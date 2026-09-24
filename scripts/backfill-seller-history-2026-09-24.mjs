// One-off, 2026-09-24. The 27 phone-book sellers moved to the Leads tab on
// 9/23 had "virtually no history" on their cards. Audit found the missing
// history in Gmail: Google Voice voicemail / text / missed-call emails in
// ryan@ (Mar 2025 + Jul 2025 mailer waves) and info@ (ryansvg/ryansvb
// aliases, Dec 2025 + Mar 2026). This inserts each as an inbound timeline
// row on the lead's phone cluster, fixes property addresses from the
// transcripts, appends a short history block to notes, and clears the
// "no contact history" AI summaries so they regenerate.
// Input: /tmp/gv-all.json (fetched via DWD from ryan@ + info@).
//   node scripts/backfill-seller-history-2026-09-24.mjs [--apply]
import fs from "node:fs"
const envPath = fs.existsSync(".env.local") ? ".env.local" : "../../../.env.local"
for (const l of fs.readFileSync(envPath, "utf8").split("\n")) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "") }
const URL_ = process.env.LRG_SUPABASE_URL, KEY = process.env.LRG_SUPABASE_SERVICE_KEY
const APPLY = process.argv.includes("--apply")
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: "return=representation" }
async function rest(method, p, body) { const r = await fetch(`${URL_}/rest/v1/${p}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${t}`); return t ? JSON.parse(t) : null }

// GV line that received each email → the lead's inbound Twilio line today
// (ported 2026-07-27; see memory ported-gv-lines-mailbox-map).
const LINE_BY_MAILBOX = { "ryan@lrghomes.com": "+14084585442", ryansvg: "+14083419402", ryansvb: "+14084186294", ryansvj: "+14083654925", ryansva: "+14083573440", ryansvr: "+14083573835", "info@lrghomes.com": "+14084930632" }
function lineFor(it) {
  const m = /<(1\d{10})\./.exec(it.from || "")           // text forwards: <gvline>.<sender>.<hash>@txt.voice.google.com
  if (m) return `+${m[1]}`
  const alias = /(ryansv[a-z])@/.exec(it.to || "")?.[1]
  return LINE_BY_MAILBOX[alias] || LINE_BY_MAILBOX[it.mailbox]
}

// Hand-read from the transcripts (kept short; the transcript itself goes on the timeline).
const FACTS = {
  "4088217137": { address: "161 Welton Dr, Campbell (4plex) — also mentioned 3770 Peacock Ct, Santa Clara", note: "Timothy. Mar 2025 voicemail after a flyer (Peacock Ct). Was on the Feb 2022 multifamily-owner voicemail-blast list; Mojo dialer activity Apr 2024." },
  "4089307393": { address: "1845 Ednamaway Way", note: "Missed calls to the GV lines Jul 11 2025 and Dec 13 2025 (no voicemail). 45 texts on the card." },
  "8313327138": { address: "124 Martinelli St, Watsonville (two 4plexes)", note: "Anthony. Missed call Dec 13 2025 (no voicemail)." },
  "4157169533": { address: "53 E 39th Ave, San Mateo", note: "Mar 2025: voicemail — got the 1031 letter, 'starting to think about potentially selling'; texted 'Ok. Thanks for the follow-up' two days later." },
  "4084822250": { address: "S 11th St, San Jose — 10-unit (VA note Apr 2024: 7 units / 6 studios)", note: "Don/Donald. Voicemails Feb + Apr 2022 (10 units, all 1-bed). Apr 24 2024 VA EOD: 'hot lead — wants to hear the cash offer to see if he'll sell.' Mojo callbacks Apr 25–26 2024." },
  "5597791836": { address: "409 Center St, Santa Cruz", note: "Herb. Dec 19 2025 voicemail off the letter: 'might be ready to sell but not sure.' Name says 'Offer 1.1' — a $1.1M offer was floated at some point." },
  "4085648388": { address: "1273 Flora Ave, San Jose 95117 (duplex)", note: "Jean. Mar 15 2025 voicemail off the letter, considering selling. Called twice more Jul 2 2025 (missed, no voicemail)." },
  "4088599445": { address: "45 Wright Ave, Morgan Hill — 15 units, all 2bd/1ba, carports + guest parking, on-site laundry", note: "Jerry. Dec 15 2025 voicemail: 'thinking about selling… this year or next… let me know what you're willing to pay per door.' Strong lead — 15 doors." },
  "4087978311": { address: "405 N Central Ave, Campbell (duplex)", note: "Juan. Mar 15 2025 voicemail: 'what kind of price will you give us… if the price is right I'm waiting to sell.'" },
  "5102997133": { address: "1119 Madison Ave, Redwood City", note: "Reinhold Gardner (not 'Reynold'). Mar 19 2025 voicemail off the letter, asked for a call." },
  "6508682155": { address: "112 42nd Ave, San Mateo (duplex)", note: "Daniel Rosaya. Mar 20–21 2025: two voicemails ('I actually…', then 'I got time now if you got time'), missed call Mar 29. Called again Jul 3 2025 from 650-593-7400 (alt number)." },
  "7073917911": { address: "93 Ridgeview Ave", note: "Bill/Will Danning (billdanning@gmail.com). Jan 15–16 2026: disclosures email thread for 93 Ridgeview — this transaction already happened." },
  "6505203555": { address: null, note: "Elsa. Mar 15 2025 voicemail off the 1031 letter for 1835 El Parque Ct, San Mateo 94403: 'how much… make me an offer.'" },
  "4155338427": { address: null, note: "Eric Woo. Mar 20 2025 voicemail: 555 S 10th St, San Jose, 28-unit complex, responding to the 1031 letter; missed call Mar 21." },
  "4084898930": { address: "4231 Santa Susana Way", note: "Paul Bates. Mar 9 2026 voicemail off the letter ('would you give me a call back'); Mar 13 2026: 'we were supposed to meet today, call me back if we're still meeting.'" },
  "4087755868": { address: null, note: "Steve. Mar 27 2025 text: 'I may sell it to friend for million. It needs some work.' Missed call Mar 28. Was on the Feb 2022 multifamily-owner voicemail-blast list." },
  "4082020854": { address: null, note: "Uha. Mar 21 2025 voicemail: got the letter, 'please give me a call back if you are still interested.'" },
  "6502072117": { address: "1395 Ontario Ln, Campbell", note: "No texts, calls, or emails found anywhere (chat.db, iPhone backup, ryan@/info@ Gmail) — phone-book entry only." },
  "5103964546": { address: "1132 Dufferin", note: "No texts, calls, or emails found anywhere (chat.db, iPhone backup, ryan@/info@ Gmail) — phone-book entry only." },
  "9162135690": { address: "2341 Rosita", note: "No texts, calls, or emails found anywhere (chat.db, iPhone backup, ryan@/info@ Gmail) — phone-book entry only." },
  "4086613448": { address: "697 Lakewood", note: null }, "4083340233": { address: null, note: null }, "4083737716": { address: "371 Daffodil", note: null },
  "8312521734": { address: "502 Laverne St + 117 Beth Dr", note: null }, "4087187109": { address: null, note: "Sold his house in May 2026 (Ryan, 9/23)." }, "4082349389": { address: null, note: null }, "4088877678": { address: null, note: null },
}

const gv = JSON.parse(fs.readFileSync("/tmp/gv-all.json", "utf8"))
const phones = fs.readFileSync("/tmp/phones.txt", "utf8").trim().split("\n").map(l => l.split("|"))
const leads = await rest("GET", `leads?caller_phone=in.(${phones.map(([p]) => "%2B1" + p).join(",")})&select=id,caller_phone,name,status,notes,property_address,created_at,lead_type,source,ai_summary&order=created_at.desc`)
const STAMP = "[History backfilled from Gmail/Google Voice 2026-09-24]"
let ins = 0, upd = 0
for (const [p, label] of phones) {
  const rows = leads.filter(r => r.caller_phone.endsWith(p))
  const main = rows[0]                                     // most recent row = the card's header row
  if (!main) { console.log(`!! no lead for ${label}`); continue }
  if ((main.notes || "").includes(STAMP)) { console.log(`skip (done) ${label}`); continue }
  const items = (gv[p]?.items || []).filter(it => it.gv)   // only Google Voice events become timeline rows
  const newRows = []
  for (const it of items) {
    const isVM = /voicemail/i.test(it.subject), isTxt = /text message/i.test(it.subject)
    const from = /from \((\d{3})\) (\d{3})-(\d{4})/.exec(it.subject || "")
    const fromDigits = from ? from.slice(1).join("") : p
    const message = isVM ? `${it.text}\n\n(Google Voice voicemail transcript${fromDigits !== p ? `, called from ${fromDigits}` : ""})`
      : isTxt ? it.text
      : `Missed call — no voicemail (Google Voice line)`
    newRows.push({ source: "Legacy DM", source_type: "direct_mail", caller_phone: `+1${p}`, twilio_number: lineFor(it), lead_type: isVM ? "voicemail" : isTxt ? "sms" : "call", message, created_at: it.date, status: main.status, name: main.name, property_address: main.property_address, is_dnc: false, is_junk: false })
  }
  const f = FACTS[p] || {}
  const patch = {}
  if (f.address) patch.property_address = f.address
  const noteLines = [f.note, newRows.length ? `${newRows.length} Google Voice event(s) added to the timeline.` : null].filter(Boolean)
  patch.notes = [(main.notes || "").trim(), noteLines.length ? `${STAMP} ${noteLines.join(" ")}` : STAMP].filter(Boolean).join("\n\n")
  if (main.ai_summary) { patch.ai_summary = null; patch.ai_summary_generated_at = null }   // "no contact history" summaries → regenerate
  console.log(`${label.padEnd(44)} +${newRows.length} rows ${newRows.map(r => r.lead_type[0] + r.created_at.slice(0, 10)).join(",")}${f.address ? `  addr→"${f.address.slice(0, 40)}"` : ""}${main.ai_summary ? "  summary→reset" : ""}`)
  if (!APPLY) continue
  if (newRows.length) { await rest("POST", "leads", newRows); ins += newRows.length }
  await rest("PATCH", `leads?id=eq.${main.id}`, patch); upd++
}
console.log(APPLY ? `\nApplied: ${ins} timeline rows inserted, ${upd} leads updated` : "\nDry run — add --apply to write.")
