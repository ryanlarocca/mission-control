#!/usr/bin/env node
// One-off (2026-10-17, briefs/BRIEF_INBOX_STAGING_VENDOR_FRESHBOOKS_2026-10-17.md Part E):
// queue inbox_fetches jobs for the four StyleMe / FreshBooks emails already in
// the mailbox, so the live worker pulls each PDF and files it into
// Properties/<address>/Staging/ on its next passes (≤ 3 jobs per pass):
//
//   1a103e1371adb8cc  proposal SS01168  (5764 Halleck Dr, 2026-10-03)
//   1a1054b98ffa3062  invoice  080223UP (5764 Halleck Dr, 2026-10-04, $2,985) — files as … PAID because the
//                     "$0.00" comment 1a13712751de3137 is already in inbox_messages (or replay that id afterwards)
//   1a1273d89af371d2  proposal SS01174  (2116 Quito Rd, 2026-10-10)
//   1a14ab5d4cc45c46  invoice  080223VA (2116 Quito Rd, 2026-10-17, $3,253.75)
//
//   node scripts/inbox-agent/oneoff/oneoff-2026-10-17-styleme-backfill.mjs --dry-run   # print what would be queued
//   node scripts/inbox-agent/oneoff/oneoff-2026-10-17-styleme-backfill.mjs             # queue (idempotent on url_sha256)
//
// Reads each message with the Gmail helpers, keeps the FreshBooks link the
// StyleMe vendor rule claims, and inserts the queue row the poll would have
// (provider freshbooks, kind = the vendor doc type). A message with no
// inbox_messages row gets a minimal one first (inbox_fetches.gmail_id references
// it). An existing row for the same URL is left alone unless it is failed /
// expired (then requeued). Nothing is fetched here — the worker does that.
import crypto from "node:crypto"
import { MAILBOX, getSetting, log, sb } from "../env.mjs"
import { getMessage, gmailClient } from "../gmail.mjs"
import { documentLinks, queuesForVendor } from "../fetch/index.mjs"
import { matchVendor, vendorDocType, vendorRules } from "../vendors.mjs"

const DRY = process.argv.includes("--dry-run")
const IDS = ["1a103e1371adb8cc", "1a1054b98ffa3062", "1a1273d89af371d2", "1a14ab5d4cc45c46"]
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex")

const gmail = await gmailClient()
const rules = vendorRules(await getSetting("vendors"))
let queued = 0
for (const id of IDS) {
  let msg
  try {
    msg = await getMessage(gmail, id)
  } catch (e) {
    log(`${id}: not readable (${e.message}) — skipped`)
    continue
  }
  const rule = matchVendor(msg, rules)
  if (!rule || rule.destination !== "property") {
    log(`${id}: "${msg.subject}" from ${msg.from.email} — no property-destination vendor rule matches, skipped`)
    continue
  }
  const links = documentLinks(msg).filter((l) => l.provider === "freshbooks" && queuesForVendor(l.provider, rule))
  const jobs = links.map((l) => ({ url: l.url, kind: vendorDocType(rule, { url: l.url }, msg) })).filter((j) => j.kind)
  if (!jobs.length) {
    log(`${id}: "${msg.subject}" — no FreshBooks document link in the body, skipped`)
    continue
  }
  const { data: m } = await sb().from("inbox_messages").select("gmail_id").eq("gmail_id", id).maybeSingle()
  if (!m) {
    log(`${id}: no inbox_messages row — ${DRY ? "would insert" : "inserting"} a minimal one (kind automated)`)
    if (!DRY) {
      const { error } = await sb().from("inbox_messages").insert({ gmail_id: msg.id, thread_id: msg.threadId, mailbox: MAILBOX, internal_date: msg.internalDate, sender: msg.from.email, sender_name: msg.from.name || null, subject: msg.subject, kind: "automated", classification: null, attachment_count: 0 })
      if (error) throw new Error(`inbox_messages insert ${id}: ${error.message}`)
    }
  }
  for (const job of jobs) {
    const url_sha256 = sha256(job.url)
    const { data: existing } = await sb().from("inbox_fetches").select("id, status, kind").eq("url_sha256", url_sha256).maybeSingle()
    if (existing) {
      if (["failed", "expired"].includes(existing.status)) {
        log(`${id}: ${job.kind} job ${existing.id} is ${existing.status} — ${DRY ? "would requeue" : "requeued"}`)
        if (!DRY) await sb().from("inbox_fetches").update({ status: "queued", kind: job.kind, attempts: 0, next_try_at: null, error: null, resolved_at: null }).eq("id", existing.id)
        queued++
      } else log(`${id}: ${job.kind} already on the queue (${existing.status} · ${existing.id}) — left alone`)
      continue
    }
    log(`${id}: ${DRY ? "would queue" : "queued"} ${rule.name} ${job.kind} — "${msg.subject}" · ${job.url.slice(0, 80)}…`)
    if (!DRY) {
      const { error } = await sb().from("inbox_fetches").insert({ gmail_id: msg.id, thread_id: msg.threadId, url: job.url, url_sha256, provider: "freshbooks", kind: job.kind, status: "queued" })
      if (error) throw new Error(`inbox_fetches insert ${id}: ${error.message}`)
    }
    queued++
  }
}
log(`${DRY ? "dry run — " : ""}${queued} job(s) ${DRY ? "would be " : ""}queued; the worker runs up to 3 fetches per pass`)
