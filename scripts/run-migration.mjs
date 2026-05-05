#!/usr/bin/env node
/**
 * Apply a Supabase schema migration via the Management API.
 *
 *   node scripts/run-migration.mjs scripts/<file>.sql
 *
 * Service-role keys can't run DDL (PostgREST table-CRUD only). The Management
 * API accepts a Personal Access Token and exposes /v1/projects/<ref>/database/query
 * for arbitrary SQL. Both `SUPABASE_PAT` and `SUPABASE_PROJECT_REF` must be in
 * .env.local; the PAT is gitignored and Thadius generated the original 2026-05-05.
 *
 * Idempotent migrations (`ADD COLUMN IF NOT EXISTS`, etc.) are safe to re-run.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")
const ENV_PATH = path.join(REPO_ROOT, ".env.local")

function loadEnvLocal() {
  if (!fs.existsSync(ENV_PATH)) return
  for (const line of fs.readFileSync(ENV_PATH, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}

function die(msg, code = 1) {
  console.error(`✗ ${msg}`)
  process.exit(code)
}

async function main() {
  const file = process.argv[2]
  if (!file) {
    console.error("Usage: node scripts/run-migration.mjs <path/to/migration.sql>")
    process.exit(2)
  }
  const sqlPath = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file)
  if (!fs.existsSync(sqlPath)) die(`SQL file not found: ${sqlPath}`)

  loadEnvLocal()
  const pat = process.env.SUPABASE_PAT
  const ref = process.env.SUPABASE_PROJECT_REF
  if (!pat) die("SUPABASE_PAT is not set (check .env.local)")
  if (!ref) die("SUPABASE_PROJECT_REF is not set (check .env.local)")

  const sql = fs.readFileSync(sqlPath, "utf-8")
  console.log(`Running migration: ${path.relative(REPO_ROOT, sqlPath)}`)
  console.log(`Project: ${ref}`)
  console.log(`Statements: ${sql.split(";").filter(s => s.trim()).length}`)

  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  })
  const text = await res.text()
  if (!res.ok) {
    console.error(`✗ Migration failed (HTTP ${res.status}): ${text}`)
    process.exit(1)
  }
  // Successful DDL returns "[]"; SELECTs return rows. Either is fine.
  console.log(`✓ Migration succeeded.`)
  if (text && text !== "[]") console.log(`  Result: ${text.slice(0, 500)}`)
}

main().catch((e) => {
  console.error("Migration runner threw:", e)
  process.exit(1)
})
