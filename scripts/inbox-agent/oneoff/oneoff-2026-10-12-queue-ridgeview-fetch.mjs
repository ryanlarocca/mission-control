// One-off (2026-10-12, Ryan: "let's give it a try"): queue the Ridgeview
// Completed-email link (gmail 1a1135bbe462b5b1) as an inbox_fetches job so the
// live worker runs the DocuSign flow end to end (expired → Send New Link →
// fresh email → download → file). Same row the Telegram `fetch` command writes.
import crypto from "node:crypto"
import fs from "node:fs"
import { sb } from "../env.mjs"

const GMAIL_ID = "1a1135bbe462b5b1"
const url = fs.readFileSync("/tmp/ridgeview/link.txt", "utf-8").trim()
if (!url) throw new Error("no link in /tmp/ridgeview/link.txt")
const { data: m } = await sb().from("inbox_messages").select("gmail_id, thread_id, kind, subject").eq("gmail_id", GMAIL_ID).maybeSingle()
if (!m) throw new Error("message row missing")
const url_sha256 = crypto.createHash("sha256").update(url).digest("hex")
const { data: existing } = await sb().from("inbox_fetches").select("id, status").eq("url_sha256", url_sha256).maybeSingle()
if (existing) {
  console.log("already queued:", existing)
  process.exit(0)
}
const { data, error } = await sb().from("inbox_fetches").insert({ gmail_id: m.gmail_id, thread_id: m.thread_id, url, url_sha256, provider: "docusign", kind: m.kind, status: "queued" }).select("id, status, created_at").single()
if (error) throw new Error(error.message)
console.log("queued:", data, "for", m.subject)
