#!/usr/bin/env node
/**
 * One-shot seed of Ryan's real historical lifts into the Physiq gym tracker.
 *
 *   node scripts/seed-gym-tracker.mjs
 *
 * Uses the Physiq service_role key (bypasses RLS). Idempotent: deletes
 * RYAN_USER_ID's existing gym_sets + gym_exercises first, then re-inserts.
 * DO NOT add this to any cron — it truncates Ryan's data on every run.
 *
 * is_pr is recomputed here from the Epley e1RM (weight * (1 + reps/30)) so the
 * "PR noted" markers in the raw data are informational only.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")

function loadEnvLocal() {
  const p = path.join(REPO_ROOT, ".env.local")
  if (!fs.existsSync(p)) return
  for (const line of fs.readFileSync(p, "utf-8").split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith("#")) continue
    const eq = t.indexOf("=")
    if (eq < 0) continue
    const k = t.slice(0, eq).trim()
    let v = t.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (process.env[k] === undefined) process.env[k] = v
  }
}

loadEnvLocal()

// Ryan's real Physiq auth user id (matches weight_entries / macro_entries),
// so the gym data lines up with his bodyweight log for the stats charts.
const RYAN_USER_ID = "59933c83-cb2e-4e87-87bb-12a1bf1f4ac3"
const URL = process.env.NEXT_PUBLIC_PHYSIQ_SUPABASE_URL
const KEY = process.env.PHYSIQ_SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) {
  console.error("✗ NEXT_PUBLIC_PHYSIQ_SUPABASE_URL and PHYSIQ_SUPABASE_SERVICE_ROLE_KEY must be in .env.local")
  process.exit(1)
}

const db = createClient(URL, KEY, { auth: { persistSession: false } })

// e1RM (Epley) — shared definition mirrored in lib/gymTracker.ts
const e1rm = (weight, reps) => weight * (1 + reps / 30)

// Raw seed data. Each exercise → array of [date, weight, reps, notes?]
const SEED = {
  "Weighted Pull-ups": [
    ["2025-12-09", 45, 5],
    ["2025-12-09", 10, 11, "fatigued"],
    ["2025-12-22", 45, 7],
    ["2025-12-28", 45, 6],
    ["2026-01-03", 45, 8],
    ["2026-01-13", 45, 8.25],
    ["2026-03-01", 45, 6.75],
    ["2026-03-08", 45, 8],
    ["2026-03-31", 45, 6],
    ["2026-04-29", 45, 6],
    ["2026-05-30", 45, 4],
  ],
  "Bench Press": [
    ["2025-12-03", 225, 5],
    ["2025-12-08", 225, 5],
    ["2025-12-16", 225, 6],
    ["2025-12-21", 225, 5],
    ["2025-12-26", 225, 6],
    ["2026-01-07", 225, 5],
    ["2026-01-15", 225, 5],
    ["2026-01-20", 225, 5],
    ["2026-02-27", 225, 5],
    ["2026-03-13", 225, 4],
    ["2026-03-19", 225, 5],
    ["2026-04-01", 225, 6],
    ["2026-04-26", 225, 4],
    ["2026-05-13", 225, 5],
    ["2026-05-23", 225, 5],
    ["2026-05-28", 225, 3],
    ["2026-06-15", 225, 4],
    ["2026-06-22", 225, 5],
  ],
  "Incline DB Press": [
    ["2025-12-11", 100, 5],
    ["2025-12-30", 100, 6],
    ["2026-02-01", 100, 7],
    ["2026-02-24", 90, 7],
    ["2026-03-03", 100, 7],
    ["2026-03-24", 100, 3],
    ["2026-04-09", 100, 5],
    ["2026-04-17", 100, 6],
    ["2026-04-30", 100, 8],
    ["2026-05-16", 100, 7],
    ["2026-06-01", 100, 5],
  ],
  "Barbell Squat": [
    ["2025-12-04", 325, 6],
    ["2025-12-15", 325, 5],
    ["2026-01-02", 325, 4],
    ["2026-02-17", 335, 3],
    ["2026-02-26", 335, 3],
    ["2026-03-06", 325, 4],
    ["2026-03-26", 345, 5, "PR"],
    ["2026-04-08", 335, 4],
    ["2026-05-01", 325, 8],
    ["2026-05-13", 325, 5],
    ["2026-05-16", 325, 5],
    ["2026-06-08", 315, 7],
  ],
  "Deadlift": [
    ["2026-01-14", 345, 1],
    ["2026-01-19", 355, 1],
    ["2026-02-26", 325, 1],
    ["2026-03-18", 345, 2],
    ["2026-04-03", 360, 1],
    ["2026-05-01", 375, 1, "didn't fully lock, close"],
    ["2026-05-16", 325, 3],
  ],
  "DB Rows": [
    ["2025-12-05", 100, 10],
    ["2026-01-30", 100, 12],
    ["2026-02-25", 100, 8],
  ],
  "Lat Pulldown": [
    ["2025-12-05", 220, 4],
    ["2026-03-27", 334, 3],
    ["2026-04-22", 220, 4],
    ["2026-05-15", 220, 4],
  ],
  "Corner Barbell Rows": [
    ["2025-12-18", 170, 4],
    ["2026-06-08", 190, 4],
  ],
  "Wire Rows": [
    ["2026-01-17", 110, 4],
    ["2026-04-23", 110, 4],
    ["2026-06-03", 110, 5],
  ],
  "Shoulder Barbell Press": [
    ["2026-06-09", 135, 6],
  ],
}

async function main() {
  console.log("Seeding gym tracker for", RYAN_USER_ID)

  // Idempotency: wipe Ryan's existing rows (sets cascade off exercises, but
  // delete sets first to be explicit). Cardio is left untouched.
  await db.from("gym_sets").delete().eq("user_id", RYAN_USER_ID)
  await db.from("gym_exercises").delete().eq("user_id", RYAN_USER_ID).eq("category", "strength")
  console.log("  cleared existing strength data")

  let totalSets = 0
  const summary = []

  for (const [name, rows] of Object.entries(SEED)) {
    // Create the exercise
    const { data: ex, error: exErr } = await db
      .from("gym_exercises")
      .insert({ user_id: RYAN_USER_ID, name, category: "strength" })
      .select("id")
      .single()
    if (exErr) { console.error(`✗ exercise ${name}:`, exErr.message); process.exit(1) }

    // Sort sets by date ascending and walk the e1RM high-water mark for is_pr
    const sorted = [...rows].sort((a, b) => a[0].localeCompare(b[0]))
    let bestE1rm = 0
    const toInsert = sorted.map(([date, weight, reps, notes]) => {
      const score = e1rm(weight, reps)
      const isPr = score > bestE1rm + 1e-9
      if (isPr) bestE1rm = score
      return {
        user_id: RYAN_USER_ID,
        exercise_id: ex.id,
        date,
        weight_lbs: weight,
        reps,
        notes: notes ?? null,
        is_pr: isPr,
      }
    })

    const { error: setErr } = await db.from("gym_sets").insert(toInsert)
    if (setErr) { console.error(`✗ sets ${name}:`, setErr.message); process.exit(1) }

    totalSets += toInsert.length
    const prRow = toInsert.filter(r => r.is_pr).slice(-1)[0]
    summary.push(`  ${name.padEnd(22)} ${String(toInsert.length).padStart(2)} sets  · PR ${prRow.weight_lbs}×${prRow.reps} (${prRow.date})`)
  }

  console.log(`\n✓ Seeded ${Object.keys(SEED).length} exercises, ${totalSets} sets:`)
  summary.forEach(s => console.log(s))
}

main().catch(e => { console.error("Seed threw:", e); process.exit(1) })
