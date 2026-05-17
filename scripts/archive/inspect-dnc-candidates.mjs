#!/usr/bin/env node
import { createClient } from "@supabase/supabase-js"
import { readFileSync } from "node:fs"
const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) {
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    process.env[m[1]] = v
  }
}
const sb = createClient(process.env.LRG_SUPABASE_URL, process.env.LRG_SUPABASE_SERVICE_KEY)
const json = JSON.parse(readFileSync(new URL("./audit-dnc-candidates.json", import.meta.url), "utf8"))
for (const c of json.candidates) {
  console.log("\n" + "═".repeat(78))
  console.log(`KEY: ${c.key}   name=${c.name}   matched-keyword=${c.keyword}`)
  console.log("═".repeat(78))
  const { data } = await sb
    .from("leads")
    .select("id, lead_type, status, is_dnc, is_junk, message, created_at")
    .in("id", c.all_lead_ids)
    .order("created_at", { ascending: true })
  for (const r of data || []) {
    console.log(`\n[${r.created_at}] ${r.lead_type} status=${r.status} dnc=${r.is_dnc} junk=${r.is_junk}`)
    console.log(`id=${r.id}`)
    console.log(`message: ${r.message || "(none)"}`)
  }
}
