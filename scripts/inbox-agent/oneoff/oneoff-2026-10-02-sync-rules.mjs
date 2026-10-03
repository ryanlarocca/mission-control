#!/usr/bin/env node
// Push briefs/INBOX_FILING_RULES.md into inbox_settings.rules (approved) — use after hand-editing the convention.
import fs from "node:fs"
import path from "node:path"
import { REPO_ROOT, getSetting, loadEnvLocal, setSetting } from "../env.mjs"
loadEnvLocal()
const md = fs.readFileSync(path.join(REPO_ROOT, "briefs", "INBOX_FILING_RULES.md"), "utf8").replace(/^<!--[\s\S]*?-->\s*/, "")
const prev = await getSetting("rules")
await setSetting("rules", { md, status: "approved", published_at: new Date().toISOString(), version: (prev.version || 1) + 1 })
console.log(`rules v${(prev.version || 1) + 1} published (${md.length} chars)`)
