// Load .env.local into process.env for integration tests (no dotenv dep —
// same hand-rolled loader as scripts/run-migration.mjs).
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const envPath = resolve(__dirname, "..", ".env.local")
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
}
