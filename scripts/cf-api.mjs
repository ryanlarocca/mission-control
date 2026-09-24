#!/usr/bin/env node
// Cloudflare API wrapper for the agent — the ONLY path agent-driven DNS /
// redirect / zone-setting changes take (2026-09-24, Ryan: "give you full
// control of my Cloudflare"). Token = CLOUDFLARE_API_TOKEN in .env.local
// (single-quoted — see memory env-local-single-quoted-values); the
// "mission-control-agent" token carries DNS / Single Redirect / Zone
// Settings / Zone / Page Rules edit on all zones + Account Rulesets edit.
//
//   node scripts/cf-api.mjs GET  /zones
//   node scripts/cf-api.mjs POST /zones/<zone>/dns_records '{"type":"A",...}'
//   node scripts/cf-api.mjs PUT  /zones/<zone>/rulesets/phases/http_request_dynamic_redirect/entrypoint '{...}'
//   node scripts/cf-api.mjs DELETE /zones/<zone>/dns_records/<id>
//
// Prints the JSON response; exits 1 when Cloudflare reports success:false.
// Paths are relative to https://api.cloudflare.com/client/v4. Zone IDs:
// lrghomes.com abbe0daed4df2183e24eadc7b3ec091b · lrghomesbuys.com
// 1380bd819fc025bf5c8454ab471581ef · lrghomesoffers.com
// 27166ec7f50be27e478e4bee20939334.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const envPath = path.join(here, "..", ".env.local")
function token() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN
  const line = fs.readFileSync(envPath, "utf8").split("\n").find((l) => l.startsWith("CLOUDFLARE_API_TOKEN="))
  if (!line) throw new Error("CLOUDFLARE_API_TOKEN missing from .env.local")
  const raw = line.slice("CLOUDFLARE_API_TOKEN=".length).trim()
  const m = /^(['"])(.*?)\1/.exec(raw)
  return m ? m[2] : raw.split(/\s+#/)[0].trim()
}

const [method, apiPath, body] = process.argv.slice(2)
if (!method || !apiPath || !apiPath.startsWith("/")) {
  console.error("usage: node scripts/cf-api.mjs <GET|POST|PUT|PATCH|DELETE> </path> [json-body]")
  process.exit(2)
}
if (body) JSON.parse(body) // fail fast on malformed JSON before it hits the API

const res = await fetch(`https://api.cloudflare.com/client/v4${apiPath}`, {
  method: method.toUpperCase(),
  headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
  body: body || undefined,
})
const json = await res.json().catch(() => ({ success: false, errors: [{ message: `HTTP ${res.status} (non-JSON body)` }] }))
console.log(JSON.stringify(json, null, 2))
process.exit(json.success ? 0 : 1)
