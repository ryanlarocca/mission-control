// Reads briefs/REPLY_PLAYBOOK.md at runtime (same pattern as
// CAMPAIGN_VOICE.md — the file is traced into the serverless bundle via
// next.config outputFileTracingIncludes). Principles per moment, plus the
// playbook version stamped on every draft so a prompt change is visible in
// the scoreboard.

import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import type { Moment } from "./moments"

export interface Playbook {
  version: string
  // moment → the "Principles:" block for that moment (markdown, trimmed)
  principles: Record<string, string>
  raw: string
}

const PLAYBOOK_PATH = path.join(process.cwd(), "briefs", "REPLY_PLAYBOOK.md")
let cache: { mtimeMs: number; pb: Playbook } | null = null

export function loadPlaybook(): Playbook {
  let mtimeMs = 0
  try {
    mtimeMs = statSync(PLAYBOOK_PATH).mtimeMs
  } catch {
    return cache?.pb ?? { version: "missing", principles: {}, raw: "" }
  }
  if (cache && cache.mtimeMs === mtimeMs) return cache.pb
  const raw = readFileSync(PLAYBOOK_PATH, "utf8")
  const pb = parsePlaybook(raw)
  cache = { mtimeMs, pb }
  return pb
}

export function parsePlaybook(raw: string): Playbook {
  const version = raw.match(/^version:\s*(\S+)/m)?.[1] ?? "unversioned"
  const principles: Record<string, string> = {}
  // Sections are "### <moment>" … up to the next "###" / "##" / "---".
  const re = /^###\s+([a-z_ /]+)\s*$/gm
  let m: RegExpExecArray | null
  const heads: { name: string; start: number; end: number }[] = []
  while ((m = re.exec(raw))) heads.push({ name: m[1].trim(), start: m.index, end: m.index + m[0].length })
  heads.forEach((h, i) => {
    const bodyEnd = i + 1 < heads.length ? heads[i + 1].start : raw.length
    const body = raw.slice(h.end, bodyEnd)
    const pm = body.match(/Principles:\s*([\s\S]*?)(?:\n\s*\n(?:Observations|Pending whys)|\n##|$)/)
    const text = (pm?.[1] ?? "").trim()
    // "### life_event / referral_ask / check_in" covers several moments.
    for (const name of h.name.split("/").map((s) => s.trim()).filter(Boolean)) {
      principles[name] = text
    }
  })
  return { version, principles, raw }
}

export function principlesFor(pb: Playbook, moment: Moment | string | null | undefined): string | null {
  if (!moment) return null
  const p = pb.principles[moment]
  if (!p || /^\(to be written/i.test(p)) return null
  return p
}
